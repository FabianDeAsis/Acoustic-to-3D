import * as THREE from 'three';
import type { FootstepTerrainId } from './types';

function createBasketballTextureSet(): {
  map: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
} {
  const w = 512;
  const h = 256;
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = w;
  colorCanvas.height = h;
  const ctx = colorCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = w;
  bumpCanvas.height = h;
  const bctx = bumpCanvas.getContext('2d')!;

  // Rich regulation basketball orange base
  ctx.fillStyle = '#d95d16';
  ctx.fillRect(0, 0, w, h);

  bctx.fillStyle = '#909090';
  bctx.fillRect(0, 0, w, h);

  // Pebbled rubber leather dimples
  for (let i = 0; i < 4200; i++) {
    const x = ((i * 73) % w) + ((i * 19) % 3);
    const y = ((i * 137) % h) + ((i * 7) % 3);
    ctx.fillStyle = i % 2 === 0 ? 'rgba(120, 42, 6, 0.28)' : 'rgba(255, 145, 58, 0.22)';
    ctx.fillRect(x, y, 2, 2);
    bctx.fillStyle = i % 2 === 0 ? '#bcbcbc' : '#646464';
    bctx.fillRect(x, y, 2, 2);
  }

  // Black rubber ribs/seams (equator, vertical meridians, and curved side channels)
  const drawSeams = (c: CanvasRenderingContext2D, stroke: string, lineW: number) => {
    c.strokeStyle = stroke;
    c.lineWidth = lineW;
    c.lineCap = 'round';

    // Equator rib
    c.beginPath();
    c.moveTo(0, h * 0.5);
    c.lineTo(w, h * 0.5);
    c.stroke();

    // Vertical prime & anti-prime ribs
    c.beginPath();
    c.moveTo(w * 0.25, 0);
    c.lineTo(w * 0.25, h);
    c.moveTo(w * 0.75, 0);
    c.lineTo(w * 0.75, h);
    c.stroke();

    // Classic curved basketball side-panel ribs
    c.beginPath();
    c.moveTo(0, h * 0.22);
    c.bezierCurveTo(w * 0.16, h * 0.28, w * 0.16, h * 0.72, 0, h * 0.78);
    c.moveTo(w * 0.5, h * 0.22);
    c.bezierCurveTo(w * 0.34, h * 0.28, w * 0.34, h * 0.72, w * 0.5, h * 0.78);
    c.moveTo(w * 0.5, h * 0.22);
    c.bezierCurveTo(w * 0.66, h * 0.28, w * 0.66, h * 0.72, w * 0.5, h * 0.78);
    c.moveTo(w, h * 0.22);
    c.bezierCurveTo(w * 0.84, h * 0.28, w * 0.84, h * 0.72, w, h * 0.78);
    c.stroke();
  };

  drawSeams(ctx, '#121316', 7);
  drawSeams(bctx, '#202020', 8);

  const map = new THREE.CanvasTexture(colorCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.wrapS = THREE.RepeatWrapping;
  bumpMap.wrapT = THREE.ClampToEdgeWrapping;

  return { map, bumpMap };
}

export interface BasketballRig {
  root: THREE.Group;
  ballGroup: THREE.Group;
  handGroup: THREE.Group;
  courtPad: THREE.Mesh;
  courtMat: THREE.MeshStandardMaterial;
  ballShadow: THREE.Mesh;
  setFloorStyle: (floorId: 'wood' | 'concrete') => void;
}

export function buildBasketballSceneRig(
  shadowTex: THREE.CanvasTexture,
  woodMap: THREE.Texture,
  concreteMap: THREE.Texture,
  castShadows: boolean
): BasketballRig {
  const root = new THREE.Group();
  const { map: ballMap, bumpMap: ballBump } = createBasketballTextureSet();

  // Court surface pad resting cleanly at y=0.012
  const courtMat = new THREE.MeshStandardMaterial({
    color: 0xd99b52,
    map: woodMap,
    roughness: 0.42,
    metalness: 0.04,
  });
  const courtPad = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.024, 2.5), courtMat);
  courtPad.position.set(0, 0.012, 0);
  courtPad.receiveShadow = castShadows;
  root.add(courtPad);

  // Court key lines
  const lineMat = new THREE.MeshBasicMaterial({ color: 0x1e2430, transparent: true, opacity: 0.55 });
  const centerLine = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 0.03), lineMat);
  centerLine.rotation.x = -Math.PI / 2;
  centerLine.position.y = 0.026;
  root.add(centerLine);

  // Basketball sphere (radius 0.22m)
  const ballGroup = new THREE.Group();
  const ballMat = new THREE.MeshStandardMaterial({
    map: ballMap,
    bumpMap: ballBump,
    bumpScale: 0.018,
    roughness: 0.55,
    metalness: 0.04,
  });
  const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(0.22, 32, 24), ballMat);
  ballMesh.castShadow = castShadows;
  ballMesh.receiveShadow = castShadows;
  ballGroup.add(ballMesh);
  root.add(ballGroup);

  // Contact shadow disc
  const ballShadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.32, 28),
    new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      opacity: 0.52,
      depthWrite: false,
    })
  );
  ballShadow.rotation.x = -Math.PI / 2;
  ballShadow.position.y = 0.027;
  root.add(ballShadow);

  // Articulated upper hand/wrist actuator
  const handGroup = new THREE.Group();
  const palmMat = new THREE.MeshStandardMaterial({
    color: 0xd8a37c,
    roughness: 0.62,
    metalness: 0.04,
  });
  const cuffMat = new THREE.MeshStandardMaterial({
    color: 0x1f2937,
    roughness: 0.72,
    metalness: 0.12,
  });

  // Forearm / wrist cuff
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.06, 0.14, 16), cuffMat);
  cuff.position.set(0, 0.09, -0.1);
  cuff.rotation.x = Math.PI * 0.34;
  cuff.castShadow = castShadows;
  handGroup.add(cuff);

  // Palm arch
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.036, 0.15), palmMat);
  palm.position.set(0, 0.02, 0);
  palm.castShadow = castShadows;
  handGroup.add(palm);

  // 4 fingers curved downward to cup/push ball
  [-0.056, -0.019, 0.019, 0.056].forEach((fx, idx) => {
    const fLen = idx === 1 || idx === 2 ? 0.115 : 0.1;
    const finger = new THREE.Mesh(new THREE.CapsuleGeometry(0.013, fLen, 4, 8), palmMat);
    finger.rotation.x = Math.PI * 0.5 + 0.38;
    finger.position.set(fx, -0.012, 0.105);
    finger.castShadow = castShadows;
    handGroup.add(finger);
  });
  // Thumb
  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.014, 0.085, 4, 8), palmMat);
  thumb.rotation.set(Math.PI * 0.45, 0, -0.55);
  thumb.position.set(-0.095, -0.008, 0.035);
  handGroup.add(thumb);

  root.add(handGroup);

  const setFloorStyle = (floorId: 'wood' | 'concrete') => {
    if (floorId === 'wood') {
      courtMat.map = woodMap;
      courtMat.color.setHex(0xd49653);
      courtMat.roughness = 0.38;
      courtMat.metalness = 0.04;
    } else {
      courtMat.map = concreteMap;
      courtMat.color.setHex(0x9ca3af);
      courtMat.roughness = 0.86;
      courtMat.metalness = 0.05;
    }
    courtMat.needsUpdate = true;
  };

  return {
    root,
    ballGroup,
    handGroup,
    courtPad,
    courtMat,
    ballShadow,
    setFloorStyle,
  };
}

export interface FootstepsRig {
  root: THREE.Group;
  leftShoe: THREE.Group;
  rightShoe: THREE.Group;
  leftShadow: THREE.Mesh;
  rightShadow: THREE.Mesh;
  slabMat: THREE.MeshStandardMaterial;
  debrisGroup: THREE.Group;
  setTerrainStyle: (terrain: FootstepTerrainId) => void;
}

function createShoeMesh(castShadows: boolean): THREE.Group {
  const shoe = new THREE.Group();

  const soleMat = new THREE.MeshStandardMaterial({ color: 0x161922, roughness: 0.88, metalness: 0.05 });
  const upperMat = new THREE.MeshStandardMaterial({ color: 0x5d3a24, roughness: 0.65, metalness: 0.08 });
  const cuffMat = new THREE.MeshStandardMaterial({ color: 0x263142, roughness: 0.78, metalness: 0.06 });

  // Rubber outsole (heel-to-toe along -Z)
  const sole = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.035, 0.34), soleMat);
  sole.position.set(0, 0.0175, -0.02);
  sole.castShadow = castShadows;
  shoe.add(sole);

  // Heel block
  const heel = new THREE.Mesh(new THREE.BoxGeometry(0.135, 0.024, 0.1), soleMat);
  heel.position.set(0, 0.012, 0.1);
  shoe.add(heel);

  // Boot upper body
  const upper = new THREE.Mesh(new THREE.BoxGeometry(0.128, 0.085, 0.25), upperMat);
  upper.position.set(0, 0.072, 0.015);
  upper.castShadow = castShadows;
  shoe.add(upper);

  // Rounded toe box
  const toe = new THREE.Mesh(new THREE.SphereGeometry(0.066, 14, 10), upperMat);
  toe.scale.set(0.95, 0.62, 1.35);
  toe.position.set(0, 0.058, -0.12);
  toe.castShadow = castShadows;
  shoe.add(toe);

  // Ankle collar + lower shin stub
  const ankle = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.058, 0.14, 14), cuffMat);
  ankle.position.set(0, 0.165, 0.075);
  ankle.castShadow = castShadows;
  shoe.add(ankle);

  return shoe;
}

export function buildFootstepsSceneRig(
  shadowTex: THREE.CanvasTexture,
  woodMap: THREE.Texture,
  concreteMap: THREE.Texture,
  metalMap: THREE.Texture,
  glassMap: THREE.Texture,
  castShadows: boolean
): FootstepsRig {
  const root = new THREE.Group();

  // Terrain slab platform in room center
  const slabMat = new THREE.MeshPhysicalMaterial({
    color: 0x7b6d5a,
    map: concreteMap,
    roughness: 0.9,
    metalness: 0.05,
  });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.032, 2.3), slabMat);
  slab.position.set(0, 0.016, 0);
  slab.receiveShadow = castShadows;
  root.add(slab);

  // Procedural twigs, leaves & gravel chips visible in `gravel_branches` mode
  const debrisGroup = new THREE.Group();
  const pebbleMat = new THREE.MeshStandardMaterial({ color: 0x7a766e, roughness: 0.92 });
  const twigMat = new THREE.MeshStandardMaterial({ color: 0x5c3e24, roughness: 0.88 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.85, side: THREE.DoubleSide });

  for (let i = 0; i < 36; i++) {
    const px = (((i * 79) % 100) / 100 - 0.5) * 1.7;
    const pz = (((i * 131) % 100) / 100 - 0.5) * 1.85;
    if (i % 3 === 0) {
      // Small dry twig
      const twig = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.012, 0.22, 6), twigMat);
      twig.rotation.set(Math.PI / 2, (i * 0.7) % Math.PI, 0);
      twig.position.set(px, 0.04, pz);
      debrisGroup.add(twig);
    } else if (i % 3 === 1) {
      // Dry leaf patch
      const leaf = new THREE.Mesh(new THREE.CircleGeometry(0.042, 5), leafMat);
      leaf.rotation.set(-Math.PI / 2 + 0.08, 0, i * 0.5);
      leaf.position.set(px, 0.036, pz);
      debrisGroup.add(leaf);
    } else {
      // Angular gravel pebble
      const pebble = new THREE.Mesh(new THREE.DodecahedronGeometry(0.022, 0), pebbleMat);
      pebble.scale.set(1.2, 0.55, 0.9);
      pebble.position.set(px, 0.038, pz);
      debrisGroup.add(pebble);
    }
  }
  root.add(debrisGroup);

  const leftShoe = createShoeMesh(castShadows);
  const rightShoe = createShoeMesh(castShadows);
  root.add(leftShoe);
  root.add(rightShoe);

  const createFootShadow = () => {
    const m = new THREE.Mesh(
      new THREE.CircleGeometry(0.24, 24),
      new THREE.MeshBasicMaterial({
        map: shadowTex,
        transparent: true,
        opacity: 0.48,
        depthWrite: false,
      })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.034;
    return m;
  };
  const leftShadow = createFootShadow();
  const rightShadow = createFootShadow();
  root.add(leftShadow);
  root.add(rightShadow);

  const setTerrainStyle = (terrain: FootstepTerrainId) => {
    debrisGroup.visible = terrain === 'gravel_branches';
    if (terrain === 'wood') {
      slabMat.map = woodMap;
      slabMat.color.setHex(0xc88a4b);
      slabMat.roughness = 0.52;
      slabMat.metalness = 0.04;
      slabMat.opacity = 1.0;
      slabMat.transparent = false;
    } else if (terrain === 'metal') {
      slabMat.map = metalMap;
      slabMat.color.setHex(0xb8c2d0);
      slabMat.roughness = 0.28;
      slabMat.metalness = 0.88;
      slabMat.opacity = 1.0;
      slabMat.transparent = false;
    } else if (terrain === 'glass') {
      slabMat.map = glassMap;
      slabMat.color.setHex(0x8be2f7);
      slabMat.roughness = 0.08;
      slabMat.metalness = 0.1;
      slabMat.opacity = 0.62;
      slabMat.transparent = true;
    } else {
      slabMat.map = concreteMap;
      slabMat.color.setHex(0x7c7163);
      slabMat.roughness = 0.92;
      slabMat.metalness = 0.03;
      slabMat.opacity = 1.0;
      slabMat.transparent = false;
    }
    slabMat.needsUpdate = true;
  };

  return {
    root,
    leftShoe,
    rightShoe,
    leftShadow,
    rightShadow,
    slabMat,
    debrisGroup,
    setTerrainStyle,
  };
}

export interface PercussionRig {
  root: THREE.Group;
  snareHead: THREE.Mesh;
  cymbalDiscGroup: THREE.Group;
  woodblockGroup: THREE.Group;
  stickLGroup: THREE.Group;
  stickRGroup: THREE.Group;
}

function createDrumstickMesh(castShadows: boolean): THREE.Group {
  const g = new THREE.Group();
  const hickoryMat = new THREE.MeshStandardMaterial({
    color: 0xdcb47e,
    roughness: 0.45,
    metalness: 0.05,
  });
  // Tapered shaft extending along -Z from wrist pivot
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.016, 0.72, 12), hickoryMat);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.set(0, 0, -0.36);
  shaft.castShadow = castShadows;
  g.add(shaft);

  // Acorn tip
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.017, 12, 10), hickoryMat);
  tip.scale.set(1, 1, 1.45);
  tip.position.set(0, 0, -0.73);
  g.add(tip);

  return g;
}

export function buildPercussionSceneRig(
  woodMap: THREE.Texture,
  castShadows: boolean
): PercussionRig {
  const root = new THREE.Group();
  const chromeMat = new THREE.MeshStandardMaterial({
    color: 0xc8d2df,
    roughness: 0.22,
    metalness: 0.92,
  });
  const blackHardwareMat = new THREE.MeshStandardMaterial({
    color: 0x1a202c,
    roughness: 0.55,
    metalness: 0.7,
  });

  // 1. Snare Drum / Membrane (left: x=-0.64, y=0.78, z=0.22)
  const snareGroup = new THREE.Group();
  snareGroup.position.set(-0.64, 0, 0.22);

  const snareStandStem = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.64, 14), chromeMat);
  snareStandStem.position.y = 0.32;
  snareGroup.add(snareStandStem);
  const snareBase = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.03, 18), blackHardwareMat);
  snareBase.position.y = 0.015;
  snareGroup.add(snareBase);

  const snareShellMat = new THREE.MeshStandardMaterial({
    map: woodMap,
    color: 0xb4532a,
    roughness: 0.38,
    metalness: 0.12,
  });
  const snareShell = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.24, 32, 1, true), snareShellMat);
  snareShell.position.y = 0.66;
  snareShell.castShadow = castShadows;
  snareGroup.add(snareShell);

  const rimTop = new THREE.Mesh(new THREE.TorusGeometry(0.322, 0.014, 10, 32), chromeMat);
  rimTop.rotation.x = Math.PI / 2;
  rimTop.position.y = 0.78;
  snareGroup.add(rimTop);

  const snareHeadMat = new THREE.MeshStandardMaterial({
    color: 0xf1f5f9,
    roughness: 0.62,
    metalness: 0.04,
  });
  const snareHead = new THREE.Mesh(new THREE.CylinderGeometry(0.315, 0.315, 0.016, 32), snareHeadMat);
  snareHead.position.y = 0.775;
  snareHead.receiveShadow = castShadows;
  snareGroup.add(snareHead);
  root.add(snareGroup);

  // 2. Resonant Brass Crash/Ride Cymbal (right: x=0.68, y=1.16, z=-0.14)
  const cymbalStand = new THREE.Group();
  cymbalStand.position.set(0.68, 0, -0.14);

  const cymStem = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.024, 1.18, 14), chromeMat);
  cymStem.position.y = 0.59;
  cymbalStand.add(cymStem);
  const cymBase = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.03, 18), blackHardwareMat);
  cymBase.position.y = 0.015;
  cymbalStand.add(cymBase);

  const cymbalDiscGroup = new THREE.Group();
  cymbalDiscGroup.position.set(0, 1.16, 0);
  const bronzeMat = new THREE.MeshStandardMaterial({
    color: 0xe3b34b,
    roughness: 0.24,
    metalness: 0.92,
  });
  const cymDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.39, 0.014, 36), bronzeMat);
  cymDisc.castShadow = castShadows;
  cymbalDiscGroup.add(cymDisc);
  const cymBell = new THREE.Mesh(new THREE.SphereGeometry(0.085, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), bronzeMat);
  cymBell.position.y = 0.004;
  cymbalDiscGroup.add(cymBell);
  cymbalStand.add(cymbalDiscGroup);
  root.add(cymbalStand);

  // 3. Resonant Hollow Woodblock (center-back: x=0.02, y=0.86, z=-0.44)
  const wbStand = new THREE.Group();
  wbStand.position.set(0.02, 0, -0.44);
  const wbStem = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.02, 0.8, 12), chromeMat);
  wbStem.position.y = 0.4;
  wbStand.add(wbStem);
  const wbBase = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.028, 16), blackHardwareMat);
  wbBase.position.y = 0.014;
  wbStand.add(wbBase);

  const woodblockGroup = new THREE.Group();
  woodblockGroup.position.set(0, 0.84, 0);
  const wbMat = new THREE.MeshStandardMaterial({
    map: woodMap,
    color: 0xb67035,
    roughness: 0.48,
    metalness: 0.04,
  });
  const wbBody = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.11, 0.16), wbMat);
  wbBody.castShadow = castShadows;
  woodblockGroup.add(wbBody);
  // Slotted acoustic chamber slit along front face
  const wbSlot = new THREE.Mesh(
    new THREE.BoxGeometry(0.25, 0.026, 0.02),
    new THREE.MeshBasicMaterial({ color: 0x160f0a })
  );
  wbSlot.position.set(0, 0.012, 0.078);
  woodblockGroup.add(wbSlot);
  wbStand.add(woodblockGroup);
  root.add(wbStand);

  // 4. Two Wooden Drumsticks
  const stickLGroup = createDrumstickMesh(castShadows);
  const stickRGroup = createDrumstickMesh(castShadows);
  root.add(stickLGroup);
  root.add(stickRGroup);

  return {
    root,
    snareHead,
    cymbalDiscGroup,
    woodblockGroup,
    stickLGroup,
    stickRGroup,
  };
}
