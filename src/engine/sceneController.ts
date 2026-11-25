import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { resolvePbrMaterialSpec, ROOM_MATERIALS } from './materials';
import {
  createInitialBodyState,
  getEffectiveRoomDimensions,
  prepareDropState,
  stepPhysics,
  traceAcousticRays,
} from './physics';
import {
  createContactShadowTexture,
  createCustomPbrTextureSet,
  createFloorGridTexture,
  createPbrTextureSet,
  type ProceduralTextureSet,
} from './proceduralTextures';
import { loadImported3DModelFiles } from './modelImporter';
import {
  computeSpatialAcousticProbe,
  getRoomAcousticOccluder,
} from './spatialAcoustics';
import {
  createInitialFoleySceneState,
  DEFAULT_FOLEY_SCENE_CONFIG,
  stepFoleyScene,
  type FoleySceneSimState,
} from './foleyScenes';
import {
  buildBasketballSceneRig,
  buildFootstepsSceneRig,
  buildPercussionSceneRig,
  type BasketballRig,
  type FootstepsRig,
  type PercussionRig,
} from './foleySceneMeshes';
import type {
  AcousticOccluderBox,
  AcousticRay,
  BuiltInPbrMaterialId,
  ContactEvent,
  DspEngineConfig,
  FoleySceneAudioTrigger,
  FoleySceneConfig,
  ImportedModelStats,
  ObjectPhysicsConfig,
  ObjectShapeId,
  PbrMaterialId,
  PbrMaterialSpec,
  PhysicsBodyState,
  RoomAcousticConfig,
  RoomDimensions,
  RoomMaterialId,
  RoughnessPixelMap,
  SpatialAcousticProbe,
  Vec3,
} from './types';

export interface SceneTelemetryCallbackData {
  bodyState: PhysicsBodyState;
  activeRays: AcousticRay[];
  spatialProbe: SpatialAcousticProbe;
  foleySceneState: FoleySceneSimState;
  isSoftwareGl: boolean;
}

export interface SceneControllerCallbacks {
  onContactEvent: (event: ContactEvent, roomWidth: number) => void;
  onFrictionEnd: () => void;
  onFoleySceneTrigger?: (trigger: FoleySceneAudioTrigger, roomWidth: number) => void;
  onSpatialProbeChange?: (
    probe: SpatialAcousticProbe,
    sourcePos: Vec3,
    refreshConvolverIr: boolean
  ) => void;
  onTelemetry: (data: SceneTelemetryCallbackData) => void;
}

// Reusable scratch objects (zero GC allocations inside render loop)
const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _hitPoint = new THREE.Vector3();

function detectSoftwareWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

/**
 * Encapsulated Three.js Acoustic Chamber & PBR Object Viewport Controller.
 * Completely decoupled from React state; mounts once into an empty container div.
 */
export class AcousticSceneController {
  private container: HTMLElement;
  private callbacks: SceneControllerCallbacks;
  private isSoftwareGl: boolean;

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;

  // Procedural texture caches
  private objectTextures = new Map<PbrMaterialId, ProceduralTextureSet>();
  private roomTextures = new Map<RoomMaterialId, ProceduralTextureSet>();
  private contactShadowTex: THREE.CanvasTexture;
  private floorGridTex: THREE.CanvasTexture;

  // Hero object (composite 3-12 part THREE.Group pivoted at bottom-center y=0)
  private heroGroup: THREE.Group;
  private heroPrimaryMaterial: THREE.MeshPhysicalMaterial;
  private heroTrimMaterial: THREE.MeshStandardMaterial;
  private heroSensorMaterial: THREE.MeshStandardMaterial;
  private heroHitProxy: THREE.Mesh;
  private contactShadowMesh: THREE.Mesh;

  // Imported custom 3D mesh (.OBJ / .GLTF / .GLB) & extracted PBR roughness pixels
  private importedModelRoot: THREE.Group | null = null;
  private importedRoughnessMap: RoughnessPixelMap | null = null;
  private importedUvBounds: { minU: number; maxU: number; minV: number; maxV: number } | undefined = undefined;
  private importedHasOriginalMaterials = false;
  private importedModelStats: ImportedModelStats | null = null;

  // Acoustic chamber architectural elements
  private roomGroup: THREE.Group;
  private wallMat: THREE.MeshStandardMaterial;
  private floorMat: THREE.MeshStandardMaterial;
  private floorMesh: THREE.Mesh;
  private floorGridMesh: THREE.Mesh;
  private wallBack: THREE.Mesh;
  private wallLeft: THREE.Mesh;
  private wallRight: THREE.Mesh;
  private ceilingMesh: THREE.Mesh;
  private absorberBaffles: THREE.Group;
  private absorberMat: THREE.MeshStandardMaterial;
  private micGroup: THREE.Group;
  private micHitProxy!: THREE.Mesh;
  private micFloorRing!: THREE.Mesh;
  private micFloorRingMat!: THREE.MeshBasicMaterial;
  private micPoleMesh!: THREE.Mesh;
  private micHeadGroup!: THREE.Group;
  private occluderGroup!: THREE.Group;

  // Acoustic ray-tracing & impact wavefront visuals
  private rayLineSegments: THREE.LineSegments;
  private rayGeometry: THREE.BufferGeometry;
  private rayMaterial: THREE.LineBasicMaterial;
  private wavefrontRing: THREE.Mesh;
  private wavefrontMat: THREE.MeshBasicMaterial;
  private wavefrontAge = 10;

  // Simulation state
  private objectConfig: ObjectPhysicsConfig;
  private activeMaterialSpec: PbrMaterialSpec;
  private customMaterials = new Map<string, PbrMaterialSpec>();
  private roomConfig: RoomAcousticConfig;
  private dspConfig: DspEngineConfig;
  private currentRoomDims: RoomDimensions;
  private targetRoomDims: RoomDimensions;
  private bodyState: PhysicsBodyState;
  private autoDragActive = false;
  private manualDragTarget: Vec3 | null = null;
  private dragMode: 'none' | 'object' | 'mic' = 'none';
  private micDragLastClientY = 0;
  private micHasCustomPos = false;
  private roomAcousticsMode = false;
  private activeRays: AcousticRay[] = [];
  private latestSpatialProbe!: SpatialAcousticProbe;
  private rayFlashIntensity = 0;

  // Animated 3D Foley Scenes (Basketball, Mixed-Terrain Footsteps, Percussion Set)
  private foleySceneConfig: FoleySceneConfig = { ...DEFAULT_FOLEY_SCENE_CONFIG };
  private foleySceneState: FoleySceneSimState = createInitialFoleySceneState();
  private basketballRig!: BasketballRig;
  private footstepsRig!: FootstepsRig;
  private percussionRig!: PercussionRig;

  // Camera transition target (cleared on arrival or OrbitControls start)
  private cameraLerpPos: THREE.Vector3 | null = null;
  private cameraLerpTarget: THREE.Vector3 | null = null;

  // Loop management
  private frameId = 0;
  private disposed = false;
  private lastTickMs = 0;
  private lastTelemetryMs = 0;
  private resizeObserver: ResizeObserver | null = null;
  private listenerPos: Vec3 = { x: -2.2, y: 1.45, z: 1.6 };

  constructor(
    container: HTMLElement,
    initialObject: ObjectPhysicsConfig,
    initialRoom: RoomAcousticConfig,
    initialDsp: DspEngineConfig,
    callbacks: SceneControllerCallbacks
  ) {
    this.container = container;
    this.callbacks = callbacks;
    this.objectConfig = initialObject;
    this.activeMaterialSpec = resolvePbrMaterialSpec(initialObject.materialId);
    this.roomConfig = initialRoom;
    this.dspConfig = initialDsp;
    this.currentRoomDims = getEffectiveRoomDimensions(initialRoom);
    this.targetRoomDims = { ...this.currentRoomDims };
    this.bodyState = createInitialBodyState();

    this.isSoftwareGl = detectSoftwareWebGL();

    // 1. Renderer setup (Three.js r160+ color pipeline + software WebGL safeguards)
    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2)
    );
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    const width = Math.max(300, container.clientWidth);
    const height = Math.max(240, container.clientHeight);
    this.renderer.setSize(width, height);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.setAttribute('data-testid', 'viewport-canvas');
    container.appendChild(this.renderer.domElement);

    // 2. Scene, Fog & Studio PMREM Environment (same lighting on GPU & Software WebGL)
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0c0f15);
    this.scene.fog = new THREE.FogExp2(0x0c0f15, 0.022);

    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    pmremGenerator.dispose();

    // 3. Camera & OrbitControls
    this.camera = new THREE.PerspectiveCamera(44, width / height, 0.1, 80);
    this.camera.position.set(3.9, 2.75, 4.9);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = !this.isSoftwareGl;
    this.controls.dampingFactor = 0.07;
    this.controls.target.set(0, 0.65, 0);
    this.controls.minDistance = 2.0;
    this.controls.maxDistance = 14.5;
    this.controls.maxPolarAngle = Math.PI * 0.485;
    this.controls.minPolarAngle = 0.15;
    this.controls.addEventListener('start', () => {
      this.cameraLerpPos = null;
      this.cameraLerpTarget = null;
    });
    this.controls.update();

    // 4. Three-point Warm/Cool Studio Lighting Rig (1 shadow caster on GPU)
    const hemiLight = new THREE.HemisphereLight(0xbcd6f5, 0x1e222b, 0.68);
    this.scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff1dc, 2.25);
    keyLight.position.set(3.8, 6.4, 4.2);
    if (!this.isSoftwareGl) {
      keyLight.castShadow = true;
      keyLight.shadow.mapSize.set(1024, 1024);
      keyLight.shadow.camera.near = 0.5;
      keyLight.shadow.camera.far = 20;
      keyLight.shadow.camera.left = -5.5;
      keyLight.shadow.camera.right = 5.5;
      keyLight.shadow.camera.top = 5.5;
      keyLight.shadow.camera.bottom = -5.5;
      keyLight.shadow.bias = -0.0005;
      keyLight.shadow.normalBias = 0.02;
    }
    this.scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x7cc8ff, 1.05);
    rimLight.position.set(-4.5, 3.6, -4.0);
    this.scene.add(rimLight);

    const warmFill = new THREE.PointLight(0xffb56b, 1.4, 12, 1.6);
    warmFill.position.set(2.5, 2.6, 1.8);
    this.scene.add(warmFill);

    // 5. Generate Procedural PBR Textures
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    (['metal', 'wood', 'concrete', 'glass'] as BuiltInPbrMaterialId[]).forEach((id) => {
      this.objectTextures.set(id, createPbrTextureSet(id, maxAniso, 1));
    });
    (['concrete', 'wood', 'glass', 'acoustic_foam'] as RoomMaterialId[]).forEach((id) => {
      this.roomTextures.set(id, createPbrTextureSet(id, maxAniso, 3));
    });
    this.contactShadowTex = createContactShadowTexture();
    this.floorGridTex = createFloorGridTexture(maxAniso);

    // 6. Build Configurable Acoustic Room
    this.roomGroup = new THREE.Group();
    this.wallMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.82,
      metalness: 0.05,
    });
    this.floorMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.78,
      metalness: 0.06,
    });
    this.absorberMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.92,
      metalness: 0.04,
      map: this.roomTextures.get('acoustic_foam')!.map,
      bumpMap: this.roomTextures.get('acoustic_foam')!.bumpMap,
      bumpScale: 0.06,
    });

    const planeGeo = new THREE.PlaneGeometry(1, 1);
    this.floorMesh = new THREE.Mesh(planeGeo, this.floorMat);
    this.floorMesh.rotation.x = -Math.PI / 2;
    this.floorMesh.receiveShadow = !this.isSoftwareGl;
    this.roomGroup.add(this.floorMesh);

    const gridMat = new THREE.MeshBasicMaterial({
      map: this.floorGridTex,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.floorGridMesh = new THREE.Mesh(planeGeo, gridMat);
    this.floorGridMesh.rotation.x = -Math.PI / 2;
    this.floorGridMesh.position.y = 0.008;
    this.roomGroup.add(this.floorGridMesh);

    this.wallBack = new THREE.Mesh(planeGeo, this.wallMat);
    this.wallBack.receiveShadow = !this.isSoftwareGl;
    this.roomGroup.add(this.wallBack);

    this.wallLeft = new THREE.Mesh(planeGeo, this.wallMat);
    this.wallLeft.rotation.y = Math.PI / 2;
    this.wallLeft.receiveShadow = !this.isSoftwareGl;
    this.roomGroup.add(this.wallLeft);

    this.wallRight = new THREE.Mesh(planeGeo, this.wallMat);
    this.wallRight.rotation.y = -Math.PI / 2;
    this.wallRight.receiveShadow = !this.isSoftwareGl;
    this.roomGroup.add(this.wallRight);

    this.ceilingMesh = new THREE.Mesh(planeGeo, this.wallMat);
    this.ceilingMesh.rotation.x = Math.PI / 2;
    this.roomGroup.add(this.ceilingMesh);

    this.absorberBaffles = this.buildAcousticBaffles();
    this.roomGroup.add(this.absorberBaffles);

    // Freestanding Studio Acoustic Gobo / Divider Panel (real geometric occluder)
    this.occluderGroup = this.buildAcousticOccluderGobo();
    this.roomGroup.add(this.occluderGroup);

    // Draggable Measurement Microphone Prop (spatial listener anchor for Haas, standing waves & occlusion)
    this.micGroup = this.buildMeasurementMicrophone();
    this.roomGroup.add(this.micGroup);

    this.scene.add(this.roomGroup);

    // 7. Build Hero Composite PBR Specimen (pivoted at bottom-center y=0)
    this.heroPrimaryMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.25,
      metalness: 0.9,
      clearcoat: 0.2,
      envMapIntensity: 1.25,
    });
    this.heroTrimMaterial = new THREE.MeshStandardMaterial({
      color: 0x262d3a,
      roughness: 0.58,
      metalness: 0.75,
    });
    this.heroSensorMaterial = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0x92400e,
      emissiveIntensity: 0.65,
      roughness: 0.22,
      metalness: 0.35,
    });

    this.heroGroup = new THREE.Group();
    this.heroHitProxy = new THREE.Mesh(
      new THREE.BoxGeometry(1.15, 1.15, 1.15),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    this.heroHitProxy.position.y = 0.52;
    this.heroGroup.add(this.heroHitProxy);
    this.rebuildHeroGeometry(initialObject.shapeId);
    this.scene.add(this.heroGroup);

    // Grounded Radial Contact Shadow Disc beneath hero object
    const shadowGeo = new THREE.CircleGeometry(0.88, 32);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: this.contactShadowTex,
      transparent: true,
      opacity: 0.52,
      depthWrite: false,
    });
    this.contactShadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
    this.contactShadowMesh.rotation.x = -Math.PI / 2;
    this.contactShadowMesh.position.y = 0.015;
    this.scene.add(this.contactShadowMesh);

    // 8. Acoustic Ray-Tracing Lines & Expanding Impact Wavefront Ring
    this.rayGeometry = new THREE.BufferGeometry();
    const maxSegments = 24;
    this.rayGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(maxSegments * 2 * 3), 3)
    );
    this.rayGeometry.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(maxSegments * 2 * 3), 3)
    );
    this.rayMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    this.rayLineSegments = new THREE.LineSegments(this.rayGeometry, this.rayMaterial);
    this.rayLineSegments.frustumCulled = false;
    this.scene.add(this.rayLineSegments);

    const ringGeo = new THREE.RingGeometry(0.18, 0.26, 48);
    this.wavefrontMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.wavefrontRing = new THREE.Mesh(ringGeo, this.wavefrontMat);
    this.wavefrontRing.rotation.x = -Math.PI / 2;
    this.wavefrontRing.position.y = 0.022;
    this.scene.add(this.wavefrontRing);

    // 8B. Build Animated 3D Foley Scene Rigs (hidden until Escenas Foley tab/mode is active)
    const castShadows = !this.isSoftwareGl;
    this.basketballRig = buildBasketballSceneRig(
      this.contactShadowTex,
      this.objectTextures.get('wood')!.map,
      this.objectTextures.get('concrete')!.map,
      castShadows
    );
    this.basketballRig.root.visible = false;
    this.scene.add(this.basketballRig.root);

    this.footstepsRig = buildFootstepsSceneRig(
      this.contactShadowTex,
      this.objectTextures.get('wood')!.map,
      this.objectTextures.get('concrete')!.map,
      this.objectTextures.get('metal')!.map,
      this.objectTextures.get('glass')!.map,
      castShadows
    );
    this.footstepsRig.root.visible = false;
    this.scene.add(this.footstepsRig.root);

    this.percussionRig = buildPercussionSceneRig(
      this.objectTextures.get('wood')!.map,
      castShadows
    );
    this.percussionRig.root.visible = false;
    this.scene.add(this.percussionRig.root);

    // Apply initial materials & room scale
    this.applyObjectConfig(initialObject);
    this.applyRoomConfig(initialRoom);
    this.updateRoomTransform(this.currentRoomDims);
    this.updateAcousticRaysVisual(0.45);

    // Pre-warm GPU shaders once (skip on software WebGL)
    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    // 9. Attach pointer drag, WebGL context loss, and resize handlers
    this.attachEvents();

    // Start paced animation loop
    this.lastTickMs = performance.now();
    this.scheduleNextFrame();
  }

  /**
   * Builds wall-mounted acoustic absorber baffles that visually scale in thickness
   * as the user adjusts the Wall Absorption parameter.
   */
  private buildAcousticBaffles(): THREE.Group {
    const group = new THREE.Group();
    const panelGeo = new THREE.BoxGeometry(1.0, 1.55, 0.08);
    // 3 panels on back wall, 2 on left cutaway wall (keeps right side cleanly open for camera)
    const placements: Array<{ wall: 'back' | 'left'; offset: number }> = [
      { wall: 'back', offset: -0.3 },
      { wall: 'back', offset: 0 },
      { wall: 'back', offset: 0.3 },
      { wall: 'left', offset: -0.24 },
      { wall: 'left', offset: 0.24 },
    ];

    for (const p of placements) {
      const frame = new THREE.Group();
      frame.userData = p;

      const baffle = new THREE.Mesh(panelGeo, this.absorberMat);
      baffle.castShadow = !this.isSoftwareGl;
      frame.add(baffle);

      // Clean architectural aluminum edge trim
      const trim = new THREE.Mesh(
        new THREE.BoxGeometry(1.04, 1.59, 0.04),
        new THREE.MeshStandardMaterial({ color: 0x3b4252, roughness: 0.42, metalness: 0.72 })
      );
      trim.position.z = -0.025;
      frame.add(trim);

      group.add(frame);
    }

    return group;
  }

  /**
   * Builds a freestanding studio acoustic gobo / diffuser partition used to demonstrate
   * genuine geometric line-of-sight acoustic occlusion and edge diffraction when the mic
   * is dragged behind it.
   */
  private buildAcousticOccluderGobo(): THREE.Group {
    const group = new THREE.Group();
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x262d3a,
      roughness: 0.45,
      metalness: 0.72,
    });
    const woolMat = new THREE.MeshStandardMaterial({
      color: 0x1e2430,
      roughness: 0.94,
      metalness: 0.04,
    });
    const slatMat = new THREE.MeshStandardMaterial({
      color: 0x8b6242,
      roughness: 0.56,
      metalness: 0.06,
    });

    // Core acoustic mineral wool body (unit 1x1x1 scaled to match getRoomAcousticOccluder)
    const core = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), woolMat);
    core.castShadow = !this.isSoftwareGl;
    core.receiveShadow = !this.isSoftwareGl;
    group.add(core);

    // Outer perimeter steel frame (left/right/top/bottom rails)
    const railSideGeo = new THREE.BoxGeometry(0.045, 1.02, 1.12);
    const railL = new THREE.Mesh(railSideGeo, frameMat);
    railL.position.x = -0.5;
    group.add(railL);
    const railR = new THREE.Mesh(railSideGeo, frameMat);
    railR.position.x = 0.5;
    group.add(railR);

    const railTop = new THREE.Mesh(new THREE.BoxGeometry(1.06, 0.04, 1.12), frameMat);
    railTop.position.y = 0.5;
    group.add(railTop);

    // Vertical acoustic wood slats on front face for unmistakable studio gobo identity
    const slatGeo = new THREE.BoxGeometry(0.055, 0.92, 0.14);
    for (let i = -3; i <= 3; i++) {
      const slat = new THREE.Mesh(slatGeo, slatMat);
      slat.position.set(i * 0.125, 0, 0.52);
      group.add(slat);
    }

    // Dual weighted studio stabilizer feet resting flush on y=0
    const footGeo = new THREE.BoxGeometry(0.12, 0.035, 3.2);
    const footL = new THREE.Mesh(footGeo, frameMat);
    footL.position.set(-0.36, -0.49, 0);
    group.add(footL);
    const footR = new THREE.Mesh(footGeo, frameMat);
    footR.position.set(0.36, -0.49, 0);
    group.add(footR);

    return group;
  }

  /**
   * Builds a composite studio measurement condenser microphone stand with telescoping pole,
   * floor locator ring, and raycast hit proxy for effortless 3D spatial dragging.
   */
  private buildMeasurementMicrophone(): THREE.Group {
    const group = new THREE.Group();
    const darkMetal = new THREE.MeshStandardMaterial({
      color: 0x252b36,
      roughness: 0.48,
      metalness: 0.78,
    });
    const chrome = new THREE.MeshStandardMaterial({
      color: 0xcbd5e1,
      roughness: 0.18,
      metalness: 0.92,
    });
    const ringGlow = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 0.8,
      roughness: 0.22,
    });

    // Invisible generous hit proxy cylinder so picking the mic in 3D is effortless
    this.micHitProxy = new THREE.Mesh(
      new THREE.CylinderGeometry(0.46, 0.46, 2.35, 12),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
    );
    this.micHitProxy.position.y = 1.15;
    group.add(this.micHitProxy);

    // Spatial locator floor ring (highlights brightly in Acústica de Sala or while dragging)
    this.micFloorRingMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.micFloorRing = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.37, 36),
      this.micFloorRingMat
    );
    this.micFloorRing.rotation.x = -Math.PI / 2;
    this.micFloorRing.position.y = 0.018;
    group.add(this.micFloorRing);

    // Weighted tripod disc base
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.04, 24), darkMetal);
    base.position.y = 0.02;
    group.add(base);

    // Telescoping vertical stand pole (unit height 1.0 scaled dynamically to listenerPos.y)
    this.micPoleMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.016, 0.02, 1.0, 12),
      darkMetal
    );
    this.micPoleMesh.position.y = 0.72;
    this.micPoleMesh.scale.y = 1.4;
    group.add(this.micPoleMesh);

    // Mic head sub-group mounted at listenerPos.y and aimed toward the sound source
    this.micHeadGroup = new THREE.Group();
    this.micHeadGroup.position.y = 1.45;

    const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.08), chrome);
    this.micHeadGroup.add(clamp);

    const micBody = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.018, 0.26, 16), chrome);
    micBody.rotation.x = Math.PI / 2;
    micBody.position.z = 0.12;
    this.micHeadGroup.add(micBody);

    const capsule = new THREE.Mesh(new THREE.SphereGeometry(0.032, 16, 12), ringGlow);
    capsule.position.z = 0.26;
    this.micHeadGroup.add(capsule);

    group.add(this.micHeadGroup);

    return group;
  }

  private disposeImportedModel(): void {
    if (!this.importedModelRoot) return;
    if (this.importedModelRoot.parent === this.heroGroup) {
      this.heroGroup.remove(this.importedModelRoot);
    }
    this.importedModelRoot.traverse((node) => {
      if (!(node as THREE.Mesh).isMesh) return;
      const mesh = node as THREE.Mesh;
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (
          m &&
          m !== this.heroPrimaryMaterial &&
          m !== this.heroTrimMaterial &&
          m !== this.heroSensorMaterial
        ) {
          const std = m as THREE.MeshStandardMaterial;
          std.map?.dispose();
          std.roughnessMap?.dispose();
          std.metalnessMap?.dispose();
          std.normalMap?.dispose();
          std.bumpMap?.dispose();
          std.aoMap?.dispose();
          std.emissiveMap?.dispose();
          m.dispose();
        }
      }
    });
    this.importedModelRoot = null;
    this.importedRoughnessMap = null;
    this.importedUvBounds = undefined;
    this.importedHasOriginalMaterials = false;
    this.importedModelStats = null;
  }

  /**
   * Imports a user-selected .OBJ, .GLTF, or .GLB 3D model, centers & grounds it at (0,0,0),
   * computes its bounding box & approximate tetrahedral volume for modal frequency scaling,
   * and extracts any PBR roughnessMap pixels for real-time friction synthesis.
   */
  public async importCustomModel(files: FileList | File[]): Promise<ImportedModelStats> {
    const loaded = await loadImported3DModelFiles(files, { castShadows: !this.isSoftwareGl });

    this.disposeImportedModel();

    this.importedModelRoot = loaded.root;
    this.importedRoughnessMap = loaded.roughnessMap;
    this.importedUvBounds = loaded.bottomUvBounds;
    this.importedHasOriginalMaterials = loaded.hasOriginalMaterials;
    this.importedModelStats = loaded.stats;

    // If the file lacks embedded PBR materials (e.g. raw .OBJ), bind our live studio PBR material
    if (!loaded.hasOriginalMaterials) {
      loaded.root.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          (child as THREE.Mesh).material = this.heroPrimaryMaterial;
        }
      });
    }

    // Center the physics body in the acoustic chamber so the imported model appears immediately at center
    this.autoDragActive = false;
    this.manualDragTarget = null;
    this.bodyState = {
      ...createInitialBodyState(),
      impactCount: this.bodyState.impactCount,
      currentLocalRoughness: loaded.stats.meanSampledRoughness ?? this.objectConfig.roughness,
      currentRoughnessSource: loaded.roughnessMap ? 'pbr_texture' : 'procedural',
    };

    this.objectConfig = {
      ...this.objectConfig,
      shapeId: 'imported_mesh',
      customVolumePitchScale: loaded.stats.volumePitchScale,
    };

    this.rebuildHeroGeometry('imported_mesh');
    this.spawnWavefront({ x: 0, y: 0, z: 0 });
    this.rayFlashIntensity = 0.85;
    this.refreshSpatialProbe(false);

    return loaded.stats;
  }

  /**
   * Builds a composite 5-7 part precision acoustic test object (never a bare primitive),
   * or mounts the active imported 3D mesh, pivoted cleanly at bottom-center (y = 0).
   */
  private rebuildHeroGeometry(shapeId: ObjectShapeId): void {
    // Remove previous visual parts (preserve hitProxy at index 0; do NOT dispose cached importedModelRoot)
    while (this.heroGroup.children.length > 1) {
      const child = this.heroGroup.children[this.heroGroup.children.length - 1];
      this.heroGroup.remove(child);
      if (child !== this.importedModelRoot) {
        child.traverse((node) => {
          if ((node as THREE.Mesh).isMesh) {
            (node as THREE.Mesh).geometry.dispose();
          }
        });
      }
    }

    if (shapeId === 'imported_mesh' && this.importedModelRoot) {
      this.heroGroup.add(this.importedModelRoot);
      const nb = this.importedModelStats?.normalizedBoundingBox;
      if (nb) {
        this.heroHitProxy.scale.set(
          Math.max(0.65, nb.x * 1.15),
          Math.max(0.65, nb.y * 1.15),
          Math.max(0.65, nb.z * 1.15)
        );
        this.heroHitProxy.position.y = Math.max(0.35, nb.y * 0.5);
      }
      return;
    }

    // Restore default hit proxy scale for built-in composite geometries
    this.heroHitProxy.scale.set(1, 1, 1);
    this.heroHitProxy.position.y = 0.48;

    const cast = !this.isSoftwareGl;
    const partGroup = new THREE.Group();

    if (shapeId === 'resonator_block') {
      // 1. Chamfered main acoustic block via ExtrudeGeometry with bevel
      const w = 0.76;
      const h = 0.62;
      const shape = new THREE.Shape();
      const r = 0.08;
      shape.moveTo(-w / 2 + r, -w / 2);
      shape.lineTo(w / 2 - r, -w / 2);
      shape.quadraticCurveTo(w / 2, -w / 2, w / 2, -w / 2 + r);
      shape.lineTo(w / 2, w / 2 - r);
      shape.quadraticCurveTo(w / 2, w / 2, w / 2 - r, w / 2);
      shape.lineTo(-w / 2 + r, w / 2);
      shape.quadraticCurveTo(-w / 2, w / 2, -w / 2, w / 2 - r);
      shape.lineTo(-w / 2, -w / 2 + r);
      shape.quadraticCurveTo(-w / 2, -w / 2, -w / 2 + r, -w / 2);

      const extrudeGeo = new THREE.ExtrudeGeometry(shape, {
        depth: h,
        bevelEnabled: true,
        bevelThickness: 0.05,
        bevelSize: 0.045,
        bevelSegments: 3,
      });
      extrudeGeo.rotateX(-Math.PI / 2);
      const body = new THREE.Mesh(extrudeGeo, this.heroPrimaryMaterial);
      body.position.y = 0.08;
      body.castShadow = cast;
      body.receiveShadow = cast;
      partGroup.add(body);

      // 2. Machined contact base plinth (contrasting roughness)
      const basePlinth = new THREE.Mesh(
        new THREE.BoxGeometry(0.82, 0.055, 0.82),
        this.heroTrimMaterial
      );
      basePlinth.position.y = 0.0275;
      basePlinth.castShadow = cast;
      partGroup.add(basePlinth);

      // 3. Acoustic resonance equatorial collar
      const collar = new THREE.Mesh(
        new THREE.BoxGeometry(0.89, 0.07, 0.89),
        this.heroTrimMaterial
      );
      collar.position.y = 0.42;
      collar.castShadow = cast;
      partGroup.add(collar);

      // 4. Top piezoelectric transducer cap
      const capBase = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.26, 0.07, 24),
        this.heroTrimMaterial
      );
      capBase.position.y = 0.785;
      capBase.castShadow = cast;
      partGroup.add(capBase);

      // 5. Amber accelerometer beacon ring
      const sensorRing = new THREE.Mesh(
        new THREE.TorusGeometry(0.14, 0.022, 12, 28),
        this.heroSensorMaterial
      );
      sensorRing.rotation.x = Math.PI / 2;
      sensorRing.position.y = 0.825;
      partGroup.add(sensorRing);
    } else if (shapeId === 'acoustic_cylinder') {
      // 1. LatheGeometry contoured bell/cylinder acoustic resonator
      const points = [
        new THREE.Vector2(0.01, 0.0),
        new THREE.Vector2(0.38, 0.0),
        new THREE.Vector2(0.42, 0.08),
        new THREE.Vector2(0.39, 0.25),
        new THREE.Vector2(0.35, 0.62),
        new THREE.Vector2(0.4, 0.78),
        new THREE.Vector2(0.32, 0.86),
        new THREE.Vector2(0.01, 0.86),
      ];
      const latheGeo = new THREE.LatheGeometry(points, 32);
      const body = new THREE.Mesh(latheGeo, this.heroPrimaryMaterial);
      body.castShadow = cast;
      body.receiveShadow = cast;
      partGroup.add(body);

      // 2. Lower damping foot ring
      const foot = new THREE.Mesh(
        new THREE.CylinderGeometry(0.43, 0.45, 0.05, 32),
        this.heroTrimMaterial
      );
      foot.position.y = 0.025;
      foot.castShadow = cast;
      partGroup.add(foot);

      // 3. Mid acoustic tuning rib
      const rib = new THREE.Mesh(
        new THREE.TorusGeometry(0.375, 0.032, 12, 32),
        this.heroTrimMaterial
      );
      rib.rotation.x = Math.PI / 2;
      rib.position.y = 0.45;
      rib.castShadow = cast;
      partGroup.add(rib);

      // 4. Upper crown flange
      const crown = new THREE.Mesh(
        new THREE.CylinderGeometry(0.24, 0.28, 0.06, 24),
        this.heroTrimMaterial
      );
      crown.position.y = 0.89;
      partGroup.add(crown);

      // 5. Sensor indicator stud
      const stud = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.08, 0.04, 16),
        this.heroSensorMaterial
      );
      stud.position.y = 0.935;
      partGroup.add(stud);
    } else {
      // Composite Acoustic Orb (sphere core + machined equatorial gimbal + cradle foot)
      // 1. Grounded cradle collar (y=0 flush)
      const cradle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.34, 0.38, 0.08, 28),
        this.heroTrimMaterial
      );
      cradle.position.y = 0.04;
      cradle.castShadow = cast;
      partGroup.add(cradle);

      // 2. Primary resonant core sphere
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.44, 32, 24),
        this.heroPrimaryMaterial
      );
      core.position.y = 0.49;
      core.castShadow = cast;
      core.receiveShadow = cast;
      partGroup.add(core);

      // 3. Machined equatorial band
      const eqBand = new THREE.Mesh(
        new THREE.TorusGeometry(0.455, 0.035, 12, 36),
        this.heroTrimMaterial
      );
      eqBand.rotation.x = Math.PI / 2;
      eqBand.position.y = 0.49;
      eqBand.castShadow = cast;
      partGroup.add(eqBand);

      // 4. Meridian rib
      const meridian = new THREE.Mesh(
        new THREE.TorusGeometry(0.452, 0.022, 10, 36),
        this.heroTrimMaterial
      );
      meridian.position.y = 0.49;
      partGroup.add(meridian);

      // 5. Apex sensor ring
      const apex = new THREE.Mesh(
        new THREE.TorusGeometry(0.12, 0.022, 10, 24),
        this.heroSensorMaterial
      );
      apex.rotation.x = Math.PI / 2;
      apex.position.y = 0.94;
      partGroup.add(apex);
    }

    this.heroGroup.add(partGroup);
  }

  /**
   * Registers an AI-generated custom PBR material and synthesizes its procedural
   * Albedo, Roughness, and Bump CanvasTextures on the fly.
   */
  public registerCustomMaterial(spec: PbrMaterialSpec): void {
    this.customMaterials.set(spec.id, spec);
    if (!spec.textureRecipe) return;

    const existing = this.objectTextures.get(spec.id);
    if (existing) {
      existing.map.dispose();
      existing.roughnessMap.dispose();
      existing.bumpMap.dispose();
    }

    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    const texSet = createCustomPbrTextureSet(spec.textureRecipe, maxAniso);
    this.objectTextures.set(spec.id, texSet);
  }

  public applyObjectConfig(config: ObjectPhysicsConfig, materialSpec?: PbrMaterialSpec): void {
    const shapeChanged = config.shapeId !== this.objectConfig.shapeId;
    this.objectConfig = config;

    if (materialSpec && materialSpec.isCustom) {
      if (!this.objectTextures.has(materialSpec.id)) {
        this.registerCustomMaterial(materialSpec);
      } else {
        this.customMaterials.set(materialSpec.id, materialSpec);
      }
    }

    if (shapeChanged) {
      this.rebuildHeroGeometry(config.shapeId);
    }

    const spec =
      materialSpec ??
      this.customMaterials.get(config.materialId) ??
      resolvePbrMaterialSpec(config.materialId);
    this.activeMaterialSpec = spec;

    const texSet =
      this.objectTextures.get(spec.id) ?? this.objectTextures.get('metal')!;

    this.heroPrimaryMaterial.map = texSet.map;
    this.heroPrimaryMaterial.roughnessMap = texSet.roughnessMap;
    this.heroPrimaryMaterial.bumpMap = texSet.bumpMap;
    const bumpMult = spec.textureRecipe ? 0.5 + spec.textureRecipe.bumpIntensity : 1.0;
    this.heroPrimaryMaterial.bumpScale = (0.015 + config.roughness * 0.045) * bumpMult;
    this.heroPrimaryMaterial.roughness = config.roughness;
    this.heroPrimaryMaterial.metalness = spec.metalness;
    this.heroPrimaryMaterial.color.setHex(0xffffff);

    const transmissionVal =
      typeof spec.transmission === 'number'
        ? spec.transmission
        : spec.id === 'glass'
        ? 0.88
        : 0;
    const clearcoatVal =
      typeof spec.clearcoat === 'number'
        ? spec.clearcoat
        : spec.id === 'glass'
        ? 1.0
        : spec.id === 'metal'
        ? 0.18
        : spec.id === 'wood'
        ? 0.14
        : 0;

    if (transmissionVal > 0.1) {
      this.heroPrimaryMaterial.transparent = true;
      this.heroPrimaryMaterial.opacity = this.isSoftwareGl
        ? Math.max(0.45, 1 - transmissionVal * 0.52)
        : 1.0;
      this.heroPrimaryMaterial.transmission = this.isSoftwareGl ? 0 : transmissionVal;
      this.heroPrimaryMaterial.ior = spec.ior ?? 1.52;
      this.heroPrimaryMaterial.thickness = 0.85;
      this.heroPrimaryMaterial.clearcoat = Math.max(0.5, clearcoatVal);
      this.heroPrimaryMaterial.clearcoatRoughness = Math.max(0.04, config.roughness * 0.6);
      this.heroPrimaryMaterial.anisotropy = 0;
    } else if (spec.metalness >= 0.65) {
      this.heroPrimaryMaterial.transparent = false;
      this.heroPrimaryMaterial.opacity = 1.0;
      this.heroPrimaryMaterial.transmission = 0;
      this.heroPrimaryMaterial.clearcoat = clearcoatVal;
      this.heroPrimaryMaterial.clearcoatRoughness = Math.max(0.08, config.roughness * 0.5);
      this.heroPrimaryMaterial.anisotropy = 0.78;
    } else {
      this.heroPrimaryMaterial.transparent = false;
      this.heroPrimaryMaterial.opacity = 1.0;
      this.heroPrimaryMaterial.transmission = 0;
      this.heroPrimaryMaterial.clearcoat = clearcoatVal;
      this.heroPrimaryMaterial.clearcoatRoughness = Math.max(0.06, config.roughness * 0.5);
      this.heroPrimaryMaterial.anisotropy = 0;
    }
    this.heroPrimaryMaterial.side =
      config.shapeId === 'imported_mesh' ? THREE.DoubleSide : THREE.FrontSide;
    this.heroPrimaryMaterial.needsUpdate = true;

    // Subtle mass-driven visual scale cue (keep imported 3D mesh at its calibrated normalized scale)
    const massScale =
      config.shapeId === 'imported_mesh'
        ? 1.0
        : Math.max(0.84, Math.min(1.22, 0.84 + Math.cbrt(config.massKg) * 0.14));
    this.heroGroup.scale.setScalar(massScale);
  }

  public applyRoomConfig(config: RoomAcousticConfig): void {
    this.roomConfig = config;
    this.targetRoomDims = getEffectiveRoomDimensions(config);

    const spec = ROOM_MATERIALS[config.materialId];
    const texSet = this.roomTextures.get(config.materialId)!;

    this.wallMat.map = texSet.map;
    this.wallMat.roughnessMap = texSet.roughnessMap;
    this.wallMat.bumpMap = texSet.bumpMap;
    this.wallMat.bumpScale = config.materialId === 'acoustic_foam' ? 0.045 : 0.02;
    this.wallMat.roughness = Math.max(0.15, Math.min(0.98, spec.wallRoughness * 0.65 + config.wallAbsorption * 0.35));
    this.wallMat.metalness = spec.wallMetalness;
    this.wallMat.color.setHex(spec.wallColorHex).lerp(new THREE.Color(0xffffff), 0.45);
    this.wallMat.needsUpdate = true;

    this.floorMat.map = texSet.map;
    this.floorMat.roughnessMap = texSet.roughnessMap;
    this.floorMat.bumpMap = texSet.bumpMap;
    this.floorMat.bumpScale = 0.02;
    this.floorMat.roughness = Math.max(0.25, spec.wallRoughness);
    this.floorMat.color.setHex(spec.floorColorHex).lerp(new THREE.Color(0xffffff), 0.38);
    this.floorMat.needsUpdate = true;

    // Acoustic absorption baffles visibly thicken and deepen with wallAbsorption
    const baffleDepthScale = 0.45 + config.wallAbsorption * 2.4;
    this.absorberBaffles.children.forEach((frame) => {
      frame.scale.set(1, 0.7 + config.wallAbsorption * 0.55, baffleDepthScale);
    });
  }

  public applyDspConfig(config: DspEngineConfig): void {
    this.dspConfig = config;
    this.rayLineSegments.visible = config.showAcousticRays;
  }

  public triggerDrop(dropHeight = 2.45): void {
    this.autoDragActive = false;
    this.manualDragTarget = null;
    const cappedHeight = Math.min(dropHeight, Math.max(1.4, this.currentRoomDims.height - 1.1));
    this.bodyState = prepareDropState(this.bodyState, cappedHeight);
  }

  public triggerManualImpulse(): void {
    const impulseEvent: ContactEvent = {
      type: 'impact',
      velocity: 5.2,
      position: { ...this.bodyState.position },
      normal: { x: 0, y: 1, z: 0 },
      contactArea: 0.75,
      localRoughness: this.bodyState.currentLocalRoughness,
      asperityImpulse: 0.65,
      timestampMs: performance.now(),
    };
    this.bodyState = {
      ...this.bodyState,
      impactCount: this.bodyState.impactCount + 1,
      lastImpactVelocity: 5.2,
      velocity: { ...this.bodyState.velocity, y: 1.35 },
      isGrounded: false,
    };
    this.spawnWavefront(impulseEvent.position);
    this.rayFlashIntensity = 1.0;
    this.callbacks.onContactEvent(impulseEvent, this.currentRoomDims.width);
  }

  public setAutoDrag(active: boolean): void {
    this.autoDragActive = active;
    if (!active) {
      this.bodyState = {
        ...this.bodyState,
        velocity: { x: 0, y: 0, z: 0 },
        currentFrictionSpeed: 0,
        isDragging: false,
      };
      this.callbacks.onFrictionEnd();
    }
  }

  public resetCamera(): void {
    const scale = Math.max(0.85, Math.min(1.6, this.currentRoomDims.width / 7.2));
    this.cameraLerpPos = new THREE.Vector3(3.9 * scale, 2.75 * scale, 4.9 * scale);
    this.cameraLerpTarget = new THREE.Vector3(0, 0.65, 0);
  }

  public setRoomAcousticsMode(active: boolean): void {
    this.roomAcousticsMode = active;
    if (this.micFloorRingMat) {
      this.micFloorRingMat.opacity = active ? 0.78 : 0.26;
      this.micFloorRingMat.color.setHex(active ? 0x38bdf8 : 0x38bdf8);
    }
  }

  public setMicPosition(pos: Vec3, refreshConvolverIr = true): void {
    this.micHasCustomPos = true;
    const clamped = this.clampMicPosition(pos, this.currentRoomDims);
    this.listenerPos = clamped;
    this.syncMicrophoneTransform();
    this.refreshSpatialProbe(refreshConvolverIr);
  }

  public setMicHeight(heightMeters: number): void {
    this.setMicPosition({ ...this.listenerPos, y: heightMeters }, true);
  }

  public resetMicPosition(): void {
    this.micHasCustomPos = false;
    const dims = this.currentRoomDims;
    const halfW = dims.width * 0.5;
    const halfD = dims.depth * 0.5;
    this.listenerPos = {
      x: -Math.min(halfW - 0.85, dims.width * 0.3),
      y: Math.min(1.45, dims.height - 0.5),
      z: Math.min(halfD - 0.85, dims.depth * 0.24),
    };
    this.syncMicrophoneTransform();
    this.refreshSpatialProbe(true);
  }

  public getSpatialMeasurementContext(): {
    sourcePos: Vec3;
    micPos: Vec3;
    occluder: AcousticOccluderBox;
    probe: SpatialAcousticProbe;
  } {
    const sourcePos = this.getSourceAnchor();
    const occluder = getRoomAcousticOccluder(this.currentRoomDims);
    const probe = computeSpatialAcousticProbe(
      sourcePos,
      this.listenerPos,
      this.currentRoomDims,
      this.roomConfig,
      occluder
    );
    this.latestSpatialProbe = probe;
    return {
      sourcePos,
      micPos: { ...this.listenerPos },
      occluder,
      probe,
    };
  }

  public triggerSweepVisual(): void {
    this.spawnWavefront(this.bodyState.position);
    this.wavefrontMat.color.setHex(0x38bdf8);
    this.rayFlashIntensity = 1.0;
  }

  public triggerShockwaveVisual(): void {
    this.spawnWavefront(this.bodyState.position);
    this.wavefrontMat.color.setHex(0xf97316);
    this.wavefrontRing.scale.setScalar(1.35);
    this.wavefrontMat.opacity = 0.92;
    this.rayFlashIntensity = 1.0;
    if (this.dspConfig.showAcousticRays) {
      this.updateAcousticRaysVisual(1.0);
    }
  }

  public setFoleySceneConfig(config: FoleySceneConfig): void {
    const prevEnabled = this.foleySceneConfig.enabled;
    const sceneChanged = config.sceneId !== this.foleySceneConfig.sceneId;
    this.foleySceneConfig = { ...config };

    if (config.enabled && (!prevEnabled || sceneChanged)) {
      this.autoDragActive = false;
      this.manualDragTarget = null;
      this.callbacks.onFrictionEnd();
    }

    if (this.basketballRig && this.footstepsRig && this.percussionRig) {
      this.heroGroup.visible = !config.enabled;
      this.contactShadowMesh.visible = !config.enabled;
      this.basketballRig.root.visible = config.enabled && config.sceneId === 'basketball';
      this.footstepsRig.root.visible = config.enabled && config.sceneId === 'footsteps';
      this.percussionRig.root.visible = config.enabled && config.sceneId === 'percussion';

      this.basketballRig.setFloorStyle(config.basketballFloor);
      this.footstepsRig.setTerrainStyle(config.footstepTerrain);
      this.syncFoleyRigTransforms();
    }

    if (config.enabled !== prevEnabled || sceneChanged) {
      this.refreshSpatialProbe(true);
      if (this.dspConfig.showAcousticRays) {
        this.updateAcousticRaysVisual(0.5);
      }
    }
  }

  public resetFoleyScene(): void {
    this.foleySceneState = createInitialFoleySceneState();
    this.syncFoleyRigTransforms();
  }

  private syncFoleyRigTransforms(): void {
    if (!this.basketballRig || !this.footstepsRig || !this.percussionRig) return;

    // 1. Basketball + Hand + Squash & Stretch + Shadow
    const bb = this.foleySceneState.basketball;
    const sqY = Math.max(0.58, Math.min(1.22, bb.squashY));
    const sqXZ = Math.sqrt(1 / sqY);
    this.basketballRig.ballGroup.position.set(bb.ballPos.x, bb.ballPos.y, bb.ballPos.z);
    this.basketballRig.ballGroup.rotation.set(bb.ballRotX, 0, bb.ballRotZ);
    this.basketballRig.ballGroup.scale.set(sqXZ, sqY, sqXZ);
    this.basketballRig.handGroup.position.set(bb.handPos.x, bb.handPos.y, bb.handPos.z);
    this.basketballRig.handGroup.rotation.set(bb.handPitch, 0, 0);
    this.basketballRig.ballShadow.position.set(bb.ballPos.x, 0.027, bb.ballPos.z);
    const bbHAtten = Math.max(0.2, 1 - (bb.ballPos.y - 0.22) * 0.42);
    this.basketballRig.ballShadow.scale.setScalar(0.85 + (bb.ballPos.y - 0.22) * 0.35);
    (this.basketballRig.ballShadow.material as THREE.MeshBasicMaterial).opacity = 0.56 * bbHAtten;

    // 2. Footsteps Heel-to-Toe Pair
    const fs = this.foleySceneState.footsteps;
    this.footstepsRig.leftShoe.position.set(fs.leftFoot.x, fs.leftFoot.y, fs.leftFoot.z);
    this.footstepsRig.leftShoe.rotation.set(fs.leftFoot.pitch, 0, 0);
    this.footstepsRig.leftShadow.position.set(fs.leftFoot.x, 0.034, fs.leftFoot.z);
    (this.footstepsRig.leftShadow.material as THREE.MeshBasicMaterial).opacity =
      0.5 * Math.max(0.18, 1 - fs.leftFoot.y * 2.1);

    this.footstepsRig.rightShoe.position.set(fs.rightFoot.x, fs.rightFoot.y, fs.rightFoot.z);
    this.footstepsRig.rightShoe.rotation.set(fs.rightFoot.pitch, 0, 0);
    this.footstepsRig.rightShadow.position.set(fs.rightFoot.x, 0.034, fs.rightFoot.z);
    (this.footstepsRig.rightShadow.material as THREE.MeshBasicMaterial).opacity =
      0.5 * Math.max(0.18, 1 - fs.rightFoot.y * 2.1);

    // 3. Percussion Kit & Drumsticks
    const pc = this.foleySceneState.percussion;
    this.percussionRig.snareHead.position.y = 0.775 - pc.snareHitEnergy * 0.012;
    this.percussionRig.cymbalDiscGroup.rotation.set(
      Math.sin(pc.cymbalWobblePhase) * pc.cymbalHitEnergy * 0.14,
      0,
      Math.cos(pc.cymbalWobblePhase * 0.85) * pc.cymbalHitEnergy * 0.11
    );
    this.percussionRig.woodblockGroup.position.y = 0.84 - pc.woodblockHitEnergy * 0.01;

    this.percussionRig.stickLGroup.position.set(
      pc.stickL.pivotX,
      pc.stickL.pivotY,
      pc.stickL.pivotZ
    );
    this.percussionRig.stickLGroup.rotation.order = 'YXZ';
    this.percussionRig.stickLGroup.rotation.set(pc.stickL.pitch, pc.stickL.yaw, 0);

    this.percussionRig.stickRGroup.position.set(
      pc.stickR.pivotX,
      pc.stickR.pivotY,
      pc.stickR.pivotZ
    );
    this.percussionRig.stickRGroup.rotation.order = 'YXZ';
    this.percussionRig.stickRGroup.rotation.set(pc.stickR.pitch, pc.stickR.yaw, 0);
  }

  private getSourceAnchor(): Vec3 {
    if (this.foleySceneConfig.enabled) {
      return { ...this.foleySceneState.activeSourcePos };
    }
    return {
      x: this.bodyState.position.x,
      y: Math.max(0.28, this.bodyState.position.y + 0.32),
      z: this.bodyState.position.z,
    };
  }

  private clampMicPosition(pos: Vec3, dims: RoomDimensions): Vec3 {
    const margin = 0.42;
    const halfW = Math.max(0.8, dims.width * 0.5 - margin);
    const halfD = Math.max(0.8, dims.depth * 0.5 - margin);
    const maxY = Math.max(0.9, dims.height - 0.35);
    return {
      x: Math.max(-halfW, Math.min(halfW, pos.x)),
      y: Math.max(0.35, Math.min(maxY, pos.y)),
      z: Math.max(-halfD, Math.min(halfD, pos.z)),
    };
  }

  private syncMicrophoneTransform(): void {
    this.micGroup.position.set(this.listenerPos.x, 0, this.listenerPos.z);

    // Adjust telescoping vertical stand height & head position
    const poleHeight = Math.max(0.32, this.listenerPos.y - 0.04);
    this.micPoleMesh.scale.y = poleHeight;
    this.micPoleMesh.position.y = 0.04 + poleHeight * 0.5;
    this.micHeadGroup.position.y = this.listenerPos.y;
    this.micHitProxy.position.y = Math.max(0.8, this.listenerPos.y * 0.65);

    // Aim microphone capsule smoothly toward the active sound source
    const src = this.getSourceAnchor();
    const dx = src.x - this.listenerPos.x;
    const dz = src.z - this.listenerPos.z;
    this.micGroup.rotation.y = Math.atan2(dx, dz);
  }

  private refreshSpatialProbe(refreshConvolverIr: boolean): void {
    const src = this.getSourceAnchor();
    const occluder = getRoomAcousticOccluder(this.currentRoomDims);
    this.latestSpatialProbe = computeSpatialAcousticProbe(
      src,
      this.listenerPos,
      this.currentRoomDims,
      this.roomConfig,
      occluder
    );
    this.callbacks.onSpatialProbeChange?.(this.latestSpatialProbe, src, refreshConvolverIr);
  }

  private updateRoomTransform(dims: RoomDimensions): void {
    const { width, height, depth } = dims;
    const halfW = width * 0.5;
    const halfD = depth * 0.5;

    this.floorMesh.scale.set(width, depth, 1);
    this.floorGridMesh.scale.set(width, depth, 1);
    this.floorGridTex.repeat.set(Math.max(2, width * 0.8), Math.max(2, depth * 0.8));

    this.wallBack.scale.set(width, height, 1);
    this.wallBack.position.set(0, height * 0.5, -halfD);

    this.wallLeft.scale.set(depth, height, 1);
    this.wallLeft.position.set(-halfW, height * 0.5, 0);

    this.wallRight.scale.set(depth, height, 1);
    this.wallRight.position.set(halfW, height * 0.5, 0);

    this.ceilingMesh.scale.set(width, depth, 1);
    this.ceilingMesh.position.set(0, height, 0);

    // Position acoustic wall panels flush on back and left cutaway walls
    this.absorberBaffles.children.forEach((frame) => {
      const meta = frame.userData as { wall: 'back' | 'left'; offset: number };
      const panelY = Math.min(height * 0.52, 2.1);
      if (meta.wall === 'back') {
        frame.position.set(meta.offset * width, panelY, -halfD + 0.05);
        frame.rotation.set(0, 0, 0);
      } else {
        frame.position.set(-halfW + 0.05, panelY, meta.offset * depth);
        frame.rotation.set(0, Math.PI / 2, 0);
      }
    });

    // Position freestanding acoustic gobo / occluder panel cleanly in back-right quadrant
    const occ = getRoomAcousticOccluder(dims);
    this.occluderGroup.position.set(occ.center.x, occ.center.y, occ.center.z);
    this.occluderGroup.scale.set(
      occ.halfExtents.x * 2,
      occ.halfExtents.y * 2,
      occ.halfExtents.z * 2
    );

    // Keep user-dragged mic position clamped inside room bounds, or place at default front-left
    if (!this.micHasCustomPos) {
      this.listenerPos = {
        x: -Math.min(halfW - 0.85, width * 0.3),
        y: Math.min(1.45, height - 0.5),
        z: Math.min(halfD - 0.85, depth * 0.24),
      };
    } else {
      this.listenerPos = this.clampMicPosition(this.listenerPos, dims);
    }
    this.syncMicrophoneTransform();
    this.refreshSpatialProbe(false);
  }

  private spawnWavefront(pos: Vec3): void {
    this.wavefrontMat.color.setHex(0xf59e0b);
    this.wavefrontRing.position.set(pos.x, 0.034, pos.z);
    this.wavefrontRing.scale.setScalar(1);
    this.wavefrontAge = 0;
  }

  private updateAcousticRaysVisual(intensity: number): void {
    const source = this.getSourceAnchor();
    const occluder = getRoomAcousticOccluder(this.currentRoomDims);
    this.latestSpatialProbe = computeSpatialAcousticProbe(
      source,
      this.listenerPos,
      this.currentRoomDims,
      this.roomConfig,
      occluder
    );

    this.activeRays = traceAcousticRays(
      source,
      this.listenerPos,
      this.currentRoomDims,
      this.roomConfig.wallAbsorption
    );

    const isOccluded = this.latestSpatialProbe.occlusionFactor > 0.08;
    const posAttr = this.rayGeometry.getAttribute('position') as THREE.BufferAttribute;
    const colAttr = this.rayGeometry.getAttribute('color') as THREE.BufferAttribute;
    const posArr = posAttr.array as Float32Array;
    const colArr = colAttr.array as Float32Array;

    let segIdx = 0;
    for (const ray of this.activeRays) {
      const energy = ray.attenuation * (0.34 + intensity * 0.66);
      const isDirect = ray.order === 0;
      const r = isDirect ? (isOccluded ? 0.96 : 0.98) * energy : 0.22 * energy;
      const g = isDirect ? (isOccluded ? 0.26 : 0.65) * energy : 0.76 * energy;
      const b = isDirect ? (isOccluded ? 0.26 : 0.12) * energy : 0.98 * energy;

      for (let i = 0; i < ray.points.length - 1; i++) {
        const a = ray.points[i];
        const bPt = ray.points[i + 1];
        const base = segIdx * 6;
        if (base + 5 >= posArr.length) break;

        posArr[base] = a.x;
        posArr[base + 1] = a.y;
        posArr[base + 2] = a.z;
        posArr[base + 3] = bPt.x;
        posArr[base + 4] = bPt.y;
        posArr[base + 5] = bPt.z;

        colArr[base] = r;
        colArr[base + 1] = g;
        colArr[base + 2] = b;
        colArr[base + 3] = r * 0.8;
        colArr[base + 4] = g * 0.8;
        colArr[base + 5] = b * 0.8;
        segIdx += 1;
      }
    }

    this.rayGeometry.setDrawRange(0, segIdx * 2);
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    this.rayMaterial.opacity = Math.max(0.28, Math.min(0.95, 0.34 + intensity * 0.6));
  }

  private attachEvents(): void {
    const dom = this.renderer.domElement;

    const updateNdc = (e: PointerEvent) => {
      const rect = dom.getBoundingClientRect();
      _ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      _ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      updateNdc(e);
      _raycaster.setFromCamera(_ndc, this.camera);

      // Prioritize microphone when in Acústica de Sala or Escenas Foley, or test nearest hit between mic & hero object
      const micHits = _raycaster.intersectObject(this.micHitProxy, false);
      const heroHits = this.foleySceneConfig.enabled
        ? []
        : _raycaster.intersectObject(this.heroHitProxy, false);

      const pickMic =
        micHits.length > 0 &&
        (heroHits.length === 0 ||
          this.roomAcousticsMode ||
          this.foleySceneConfig.enabled ||
          micHits[0].distance <= heroHits[0].distance);

      if (pickMic) {
        e.stopImmediatePropagation();
        this.dragMode = 'mic';
        this.micHasCustomPos = true;
        this.micDragLastClientY = e.clientY;
        this.controls.enabled = false;
        this.micFloorRingMat.opacity = 0.95;
        this.micFloorRingMat.color.setHex(0xf59e0b);
        dom.style.cursor = 'grabbing';
        dom.setPointerCapture(e.pointerId);
        return;
      }

      if (heroHits.length > 0) {
        e.stopImmediatePropagation();
        this.dragMode = 'object';
        this.controls.enabled = false;
        this.autoDragActive = false;
        if (_raycaster.ray.intersectPlane(_groundPlane, _hitPoint)) {
          this.manualDragTarget = { x: _hitPoint.x, y: 0, z: _hitPoint.z };
        }
        dom.style.cursor = 'grabbing';
        dom.setPointerCapture(e.pointerId);
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (this.dragMode === 'mic') {
        if (e.shiftKey) {
          // Shift+drag adjusts vertical microphone elevation Y smoothly
          const dyPx = this.micDragLastClientY - e.clientY;
          this.micDragLastClientY = e.clientY;
          this.listenerPos = this.clampMicPosition(
            { ...this.listenerPos, y: this.listenerPos.y + dyPx * 0.012 },
            this.currentRoomDims
          );
        } else {
          this.micDragLastClientY = e.clientY;
          updateNdc(e);
          _raycaster.setFromCamera(_ndc, this.camera);
          if (_raycaster.ray.intersectPlane(_groundPlane, _hitPoint)) {
            this.listenerPos = this.clampMicPosition(
              { x: _hitPoint.x, y: this.listenerPos.y, z: _hitPoint.z },
              this.currentRoomDims
            );
          }
        }
        this.syncMicrophoneTransform();
        this.refreshSpatialProbe(true);
        return;
      }

      if (this.dragMode === 'object' && this.manualDragTarget) {
        updateNdc(e);
        _raycaster.setFromCamera(_ndc, this.camera);
        if (_raycaster.ray.intersectPlane(_groundPlane, _hitPoint)) {
          this.manualDragTarget = { x: _hitPoint.x, y: 0, z: _hitPoint.z };
        }
        return;
      }

      // Hover cursor + ring cue so draggable 3D microphone and hero object are unmistakable
      if (e.buttons === 0) {
        updateNdc(e);
        _raycaster.setFromCamera(_ndc, this.camera);
        const hoveringMic = _raycaster.intersectObject(this.micHitProxy, false).length > 0;
        if (hoveringMic) {
          dom.style.cursor = 'move';
          this.micFloorRingMat.opacity = 0.92;
        } else {
          const hoveringHero = _raycaster.intersectObject(this.heroHitProxy, false).length > 0;
          dom.style.cursor = hoveringHero ? 'grab' : 'default';
          this.micFloorRingMat.opacity = this.roomAcousticsMode ? 0.78 : 0.26;
        }
      }
    };

    const endDrag = (e: PointerEvent) => {
      if (this.dragMode === 'none') return;
      const prevMode = this.dragMode;
      this.dragMode = 'none';
      this.manualDragTarget = null;
      this.controls.enabled = true;
      dom.style.cursor = 'default';
      try {
        dom.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore if not captured
      }
      if (prevMode === 'mic') {
        this.micFloorRingMat.color.setHex(0x38bdf8);
        this.micFloorRingMat.opacity = this.roomAcousticsMode ? 0.78 : 0.26;
        this.refreshSpatialProbe(true);
      } else {
        this.callbacks.onFrictionEnd();
      }
    };

    const onContextLost = (e: Event) => {
      e.preventDefault();
    };

    dom.style.cursor = 'default';
    dom.addEventListener('pointerdown', onPointerDown, { capture: true });
    dom.addEventListener('pointermove', onPointerMove);
    dom.addEventListener('pointerup', endDrag);
    dom.addEventListener('pointercancel', endDrag);
    dom.addEventListener('webglcontextlost', onContextLost);

    this.resizeObserver = new ResizeObserver(() => {
      if (this.disposed) return;
      const w = Math.max(300, this.container.clientWidth);
      const h = Math.max(240, this.container.clientHeight);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });
    this.resizeObserver.observe(this.container);

    // Store cleanup hook
    this.cleanupListeners = () => {
      dom.removeEventListener('pointerdown', onPointerDown, { capture: true });
      dom.removeEventListener('pointermove', onPointerMove);
      dom.removeEventListener('pointerup', endDrag);
      dom.removeEventListener('pointercancel', endDrag);
      dom.removeEventListener('webglcontextlost', onContextLost);
    };
  }

  private cleanupListeners: () => void = () => {};

  /**
   * Software-WebGL fence pacing per Three.js skill guidelines.
   * Ensures headless Chromium CPU rendering never starves DOM clicks or screenshots.
   */
  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (!gl || typeof gl.fenceSync !== 'function') {
      this.frameId = window.setTimeout(cb, 80);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) {
        if (sync) gl.deleteSync(sync);
        return;
      }
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        this.frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  }

  private scheduleNextFrame(): void {
    if (this.disposed) return;
    if (this.isSoftwareGl) {
      this.afterDraw(this.tick);
    } else {
      this.frameId = window.requestAnimationFrame(this.tick);
    }
  }

  private tick = (): void => {
    if (this.disposed) return;

    const nowMs = performance.now();
    // Real wall-clock elapsed seconds (up to 0.28s per software-GL frame), integrated in <= 1/60s substeps
    const frameElapsed = Math.min(0.28, Math.max(0.004, (nowMs - this.lastTickMs) / 1000));
    this.lastTickMs = nowMs;

    // 1. Smoothly interpolate room dimensions (exponential damping)
    const damp = 1 - Math.exp(-7 * frameElapsed);
    const dimsChanged =
      Math.abs(this.currentRoomDims.width - this.targetRoomDims.width) > 0.005 ||
      Math.abs(this.currentRoomDims.height - this.targetRoomDims.height) > 0.005 ||
      Math.abs(this.currentRoomDims.depth - this.targetRoomDims.depth) > 0.005;

    if (dimsChanged) {
      this.currentRoomDims.width += (this.targetRoomDims.width - this.currentRoomDims.width) * damp;
      this.currentRoomDims.height += (this.targetRoomDims.height - this.currentRoomDims.height) * damp;
      this.currentRoomDims.depth += (this.targetRoomDims.depth - this.currentRoomDims.depth) * damp;
      this.updateRoomTransform(this.currentRoomDims);
    }

    // 2. Fixed-substep Simulation (either Animated Foley Scene or Rigid-Body Hero Physics)
    const substeps = Math.max(1, Math.ceil(frameElapsed / (1 / 60)));
    const subDt = frameElapsed / substeps;

    if (this.foleySceneConfig.enabled) {
      for (let s = 0; s < substeps; s++) {
        const res = stepFoleyScene(this.foleySceneState, this.foleySceneConfig, subDt);
        this.foleySceneState = res.next;
        for (const trig of res.triggers) {
          this.spawnWavefront(trig.position);
          if (trig.kind === 'percussion_cymbal') {
            this.wavefrontMat.color.setHex(0x38bdf8);
          } else if (trig.kind === 'footstep_heel' && trig.terrain === 'gravel_branches') {
            this.wavefrontMat.color.setHex(0xa3e635);
          }
          this.rayFlashIntensity = Math.min(1, 0.55 + trig.intensity * 0.4);
          this.callbacks.onFoleySceneTrigger?.(trig, this.currentRoomDims.width);
        }
      }
      this.syncFoleyRigTransforms();
    } else {
      let latestFrictionEvent: ContactEvent | null = null;
      const activeRoughnessMap =
        this.objectConfig.shapeId === 'imported_mesh' ? this.importedRoughnessMap : null;

      for (let s = 0; s < substeps; s++) {
        const step = stepPhysics(
          this.bodyState,
          this.objectConfig,
          this.currentRoomDims,
          subDt,
          {
            autoDragActive: this.autoDragActive,
            dragTarget: this.manualDragTarget,
            nowMs,
            materialSpec: this.activeMaterialSpec,
            roughnessPixelMap: activeRoughnessMap,
            contactUvBounds: this.importedUvBounds,
          }
        );
        this.bodyState = step.state;

        for (const ev of step.events) {
          if (ev.type === 'impact') {
            this.spawnWavefront(ev.position);
            this.rayFlashIntensity = Math.min(1, 0.6 + ev.velocity * 0.1);
            this.callbacks.onContactEvent(ev, this.currentRoomDims.width);
          } else if (ev.type === 'friction') {
            latestFrictionEvent = ev;
          }
        }
      }

      if (latestFrictionEvent) {
        this.rayFlashIntensity = Math.max(
          this.rayFlashIntensity,
          Math.min(0.75, latestFrictionEvent.velocity * 0.2)
        );
        this.callbacks.onContactEvent(latestFrictionEvent, this.currentRoomDims.width);
      } else if (!this.autoDragActive && !this.manualDragTarget) {
        this.callbacks.onFrictionEnd();
      }
    }

    // 3. Sync Hero 3D Mesh & Grounded Contact Shadow
    this.heroGroup.position.set(
      this.bodyState.position.x,
      this.bodyState.position.y,
      this.bodyState.position.z
    );
    this.heroGroup.rotation.set(
      this.bodyState.rotation.x,
      this.bodyState.rotation.y,
      this.bodyState.rotation.z
    );

    this.contactShadowMesh.position.x = this.bodyState.position.x;
    this.contactShadowMesh.position.z = this.bodyState.position.z;
    const heightAtten = Math.max(0.18, 1 - this.bodyState.position.y * 0.28);
    const shadowScale = (0.95 + this.bodyState.position.y * 0.25) * this.heroGroup.scale.x;
    this.contactShadowMesh.scale.setScalar(shadowScale);
    (this.contactShadowMesh.material as THREE.MeshBasicMaterial).opacity = 0.54 * heightAtten;

    // 4. Sync mic aim toward moving sound source + Animate Wavefront & Acoustic Rays
    this.syncMicrophoneTransform();
    if (this.wavefrontAge < 1.2) {
      this.wavefrontAge += frameElapsed * 2.2;
      const radiusScale = 1 + this.wavefrontAge * 6.5;
      this.wavefrontRing.scale.setScalar(radiusScale);
      this.wavefrontMat.opacity = Math.max(0, (1 - this.wavefrontAge / 1.2) * 0.72);
    } else {
      this.wavefrontMat.opacity = 0;
    }

    this.rayFlashIntensity *= Math.exp(-3.2 * frameElapsed);
    if (this.dspConfig.showAcousticRays) {
      this.updateAcousticRaysVisual(this.rayFlashIntensity);
    }

    // 5. Smooth Camera Reset Transition
    if (this.cameraLerpPos && this.cameraLerpTarget) {
      const camDamp = 1 - Math.exp(-6 * frameElapsed);
      this.camera.position.lerp(this.cameraLerpPos, camDamp);
      this.controls.target.lerp(this.cameraLerpTarget, camDamp);
      if (this.camera.position.distanceTo(this.cameraLerpPos) < 0.03) {
        this.cameraLerpPos = null;
        this.cameraLerpTarget = null;
      }
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);

    // 6. Throttle React HUD telemetry callbacks to <= 10Hz
    if (nowMs - this.lastTelemetryMs >= 100) {
      this.lastTelemetryMs = nowMs;
      this.callbacks.onTelemetry({
        bodyState: { ...this.bodyState },
        activeRays: this.activeRays,
        spatialProbe: this.latestSpatialProbe,
        foleySceneState: this.foleySceneState,
        isSoftwareGl: this.isSoftwareGl,
      });
    }

    this.scheduleNextFrame();
  };

  public dispose(): void {
    this.disposed = true;
    window.cancelAnimationFrame(this.frameId);
    window.clearTimeout(this.frameId);
    this.cleanupListeners();
    this.resizeObserver?.disconnect();
    this.controls.dispose();

    this.objectTextures.forEach((set) => {
      set.map.dispose();
      set.roughnessMap.dispose();
      set.bumpMap.dispose();
    });
    this.roomTextures.forEach((set) => {
      set.map.dispose();
      set.roughnessMap.dispose();
      set.bumpMap.dispose();
    });
    this.disposeImportedModel();
    this.contactShadowTex.dispose();
    this.floorGridTex.dispose();

    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((m) => m.dispose());
        } else {
          mesh.material.dispose();
        }
      }
    });

    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
