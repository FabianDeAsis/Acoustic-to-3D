export type BuiltInPbrMaterialId = 'metal' | 'wood' | 'concrete' | 'glass';

export type PbrMaterialId = BuiltInPbrMaterialId | (string & {});

export type ProceduralPatternId =
  | 'ceramic_glaze'
  | 'brushed_metal'
  | 'crystalline_ice'
  | 'molded_plastic'
  | 'organic_grain'
  | 'porous_mineral'
  | 'woven_composite';

export interface ProceduralTextureRecipe {
  pattern: ProceduralPatternId;
  primaryColor: string;    // #RRGGBB
  secondaryColor: string;  // #RRGGBB
  accentColor: string;     // #RRGGBB
  grainScale: number;      // 0.3 .. 3.0
  contrast: number;        // 0.1 .. 1.0
  bumpIntensity: number;   // 0.05 .. 1.0
}

export type RoomMaterialId = 'concrete' | 'wood' | 'glass' | 'acoustic_foam';

export type RoomSizePresetId = 'booth' | 'studio' | 'hall' | 'cathedral';

export type ObjectShapeId =
  | 'resonator_block'
  | 'acoustic_cylinder'
  | 'composite_orb'
  | 'imported_mesh';

export interface RoughnessPixelMap {
  width: number;
  height: number;
  /** Raw RGBA8 pixel buffer extracted from PBR roughnessMap / glTF metallicRoughnessTexture */
  data: Uint8ClampedArray;
  /** Scalar material.roughness multiplier (glTF spec: finalRoughness = pixelG/255 * factor) */
  roughnessFactor: number;
  /** True when sourced from glTF metallicRoughnessTexture (roughness stored in G channel) */
  isGltfPacked: boolean;
  /** Texture vertical flip flag from Three.js Texture.flipY */
  flipY: boolean;
  repeatU: number;
  repeatV: number;
  offsetU: number;
  offsetV: number;
}

export interface ImportedModelStats {
  fileName: string;
  format: 'obj' | 'gltf' | 'glb';
  triangleCount: number;
  rawBoundingBox: Vec3;
  normalizedBoundingBox: Vec3;
  approximateVolumeM3: number;
  bboxVolumeM3: number;
  volumeFillRatio: number;
  /** Acoustic fundamental pitch multiplier derived from V_ref / V_approx^(1/3) */
  volumePitchScale: number;
  hasRoughnessMap: boolean;
  roughnessMapSize?: { width: number; height: number };
  meanSampledRoughness?: number;
}

export type ConsoleTabId = 'material' | 'room' | 'dsp' | 'scenes';

export type AnalyzerViewId = 'spectrum' | 'oscilloscope' | 'ir';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface RoomDimensions {
  width: number;  // meters (X)
  height: number; // meters (Y)
  depth: number;  // meters (Z)
}

export interface ModalModeDefinition {
  ratio: number;       // Frequency multiplier relative to fundamental
  amplitude: number;   // Relative excitation gain (0..1)
  qFactor: number;     // Base resonance sharpness
  decayWeight: number; // Relative decay multiplier
}

export interface PbrMaterialSpec {
  id: PbrMaterialId;
  name: string;
  subtitle: string;
  swatchColor: string;
  albedoHex: number;
  accentHex: number;
  defaultRoughness: number;
  metalness: number;
  densityKgM3: number;
  defaultMassKg: number;
  defaultHardness: number;    // 0..1 (elastic modulus proxy)
  defaultElasticity: number;  // 0..1 (restitution coefficient)
  frictionCoeff: number;      // Coulomb friction baseline
  baseFundamentalHz: number;  // Reference fundamental at defaultMassKg
  neuralHarmonicDrive: number;// DDSP / nonlinear shimmer amount
  neuralFormantHz: number;    // Characteristic material formant body
  modes: ModalModeDefinition[];
  isCustom?: boolean;
  transmission?: number;      // 0..0.95 (glass, ice, translucent plastic)
  ior?: number;               // 1.15..2.2
  clearcoat?: number;         // 0..1 (ceramic glaze, lacquer)
  textureRecipe?: ProceduralTextureRecipe;
  acousticNotes?: string;
}

export interface RoomMaterialSpec {
  id: RoomMaterialId;
  name: string;
  subtitle: string;
  swatchColor: string;
  wallColorHex: number;
  floorColorHex: number;
  wallRoughness: number;
  wallMetalness: number;
  defaultAbsorption: number; // Broad Sabine absorption alpha (0.02..0.95)
  bandAbsorption: {
    low: number;  // 125 Hz
    mid: number;  // 1 kHz
    high: number; // 4 kHz
  };
  diffusion: number; // 0..1 surface scattering
}

export interface RoomSizePreset {
  id: RoomSizePresetId;
  name: string;
  dimensions: RoomDimensions;
}

export interface ObjectPhysicsConfig {
  materialId: PbrMaterialId;
  shapeId: ObjectShapeId;
  massKg: number;       // 0.2 .. 25 kg
  roughness: number;    // 0.02 .. 1.0
  hardness: number;     // 0.1 .. 1.0
  elasticity: number;   // 0.05 .. 0.92
  /** Optional modal fundamental frequency multiplier derived from imported 3D mesh volume */
  customVolumePitchScale?: number;
}

export interface RoomAcousticConfig {
  materialId: RoomMaterialId;
  sizePreset: RoomSizePresetId;
  scaleMultiplier: number; // 0.6 .. 1.6
  wallAbsorption: number;  // 0.04 .. 0.95
  dryWet: number;          // 0.0 .. 1.0
}

export type PhysicalExcitationModeId =
  | 'dual_hertz'
  | 'elastic_cavity'
  | 'stochastic_fracture'
  | 'friedlander_shockwave';

export interface DspEngineConfig {
  excitationMode: PhysicalExcitationModeId;
  neuralConditioning: number; // 0.0 .. 1.0
  frictionGain: number;       // 0.0 .. 1.5
  showAcousticRays: boolean;
  masterGainDb: number;       // -24 .. +6 dB
}

export interface ModalPartial {
  index: number;
  frequencyHz: number;
  gain: number;
  qFactor: number;
  decayMs: number;
}

export interface ContactEvent {
  type: 'impact' | 'friction';
  velocity: number;         // m/s (normal for impact, tangential for friction)
  position: Vec3;
  normal: Vec3;
  contactArea: number;      // normalized 0.1..1.0
  localRoughness: number;   // sampled from PBR roughness heightfield or texture pixels (0..1)
  asperityImpulse: number;  // micro-bump derivative for stick-slip grain
  roughnessSource?: 'procedural' | 'pbr_texture';
  contactUv?: { u: number; v: number };
  timestampMs: number;
}

export interface AcousticRay {
  id: string;
  order: 0 | 1 | 2;         // 0 = direct, 1 = first reflection
  points: Vec3[];
  attenuation: number;      // 0..1 energy left
  delayMs: number;
  surface: string;
}

export interface PhysicsBodyState {
  position: Vec3;
  velocity: Vec3;
  rotation: Vec3;
  angularVelocity: Vec3;
  isGrounded: boolean;
  isDragging: boolean;
  autoDragPhase: number;
  impactCount: number;
  lastImpactVelocity: number;
  currentFrictionSpeed: number;
  currentLocalRoughness: number;
  currentContactUv?: { u: number; v: number };
  currentRoughnessSource?: 'procedural' | 'pbr_texture';
}

export interface RoomAcousticMetrics {
  dimensions: RoomDimensions;
  volumeM3: number;
  surfaceAreaM2: number;
  rt60Seconds: number;
  earlyReflectionMs: number;
  criticalDistanceM: number;
  meanAbsorption: number;
}

export interface AudioMeterSnapshot {
  peakDb: number;
  rmsDb: number;
  lufsMomentary: number;
  sampleRate: number;
  latencyMs: number;
  activeVoices: number;
}

export interface AcousticOccluderBox {
  center: Vec3;
  halfExtents: Vec3;
}

export interface StandingWaveMode {
  label: string;
  nx: number;
  ny: number;
  nz: number;
  frequencyHz: number;
  pressure: number; // 0..1 spatial pressure amplitude |Psi|
  gainDb: number;   // -9.5..+9.5 dB modal coloration at mic coordinate
  qFactor: number;
}

export interface SpatialAcousticProbe {
  micPosition: Vec3;
  directDistanceM: number;
  directDelayMs: number;
  haasItdMs: number;
  haasDeltaMs: number;
  haasZone: 'comb_filter' | 'haas_fusion' | 'discrete_echo';
  stereoPan: number;
  occlusionFactor: number;
  occlusionCutoffHz: number;
  occlusionAttenuationDb: number;
  standingWaves: StandingWaveMode[];
  dominantStandingWave: StandingWaveMode;
  drRatioDb: number;
}

export interface MeasuredIrSummary {
  micPosition: Vec3;
  roomMaterialId: RoomMaterialId;
  roomSizePreset: RoomSizePresetId;
  rt60Seconds: number;
  durationSec: number;
  sampleRate: number;
  bitDepth: 24;
  channels: 2;
  measuredAtMs: number;
}

export type FoleySceneId = 'basketball' | 'footsteps' | 'percussion';

export type BasketballCadenceId = 'slow_dribble' | 'fast_crossover' | 'free_throw';

export type BasketballFloorId = 'wood' | 'concrete';

export type FootstepTerrainId = 'wood' | 'gravel_branches' | 'metal' | 'glass';

export interface FoleySceneConfig {
  enabled: boolean;
  sceneId: FoleySceneId;
  playing: boolean;
  basketballCadence: BasketballCadenceId;
  basketballFloor: BasketballFloorId;
  footstepTerrain: FootstepTerrainId;
  /** 0.0 (slow walk) .. 1.0 (sprint/run) */
  footstepSpeed: number;
  /** 75 .. 160 BPM for modal percussion groove */
  percussionBpm: number;
}

export type FoleySceneAudioEventKind =
  | 'basketball_bounce'
  | 'basketball_hand_catch'
  | 'footstep_heel'
  | 'footstep_toe'
  | 'percussion_snare'
  | 'percussion_cymbal'
  | 'percussion_woodblock';

export interface FoleySceneAudioTrigger {
  kind: FoleySceneAudioEventKind;
  position: Vec3;
  velocity: number;
  surfaceMaterial: RoomMaterialId;
  terrain?: FootstepTerrainId;
  intensity: number;
  label: string;
}


