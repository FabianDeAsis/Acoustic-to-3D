import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAudioLevels,
  computeModalBank,
  generateRoomImpulseResponse,
} from './dspMath';
import { normalizeGeneratedMaterialPayload } from './materialGenerator';
import {
  computeRoomAcousticMetrics,
  createInitialBodyState,
  prepareDropState,
  sampleRoughnessMap,
  stepPhysics,
  traceAcousticRays,
} from './physics';
import {
  analyzeTriangleBuffers,
  computeMeanRoughnessFromPixelMap,
  sampleRoughnessPixel,
} from './modelImporter';
import {
  computeDualHertzPartition,
  computeElasticCavityParams,
  computePoissonLambda,
  computeShockwaveDistanceCutoffHz,
  computeSurfaceModalBank,
  generateFriedlanderShockwave,
  generatePoissonFractureBuffer,
} from './physicalExcitation';
import {
  computeBiquadBandpassCoeffs,
  computeBiquadLowpassCoeffs,
  computeBiquadPeakingCoeffs,
  concatStereoChunks,
  evaluateBiquadMagnitude,
  generateCppAcousticPresetHeader,
} from './sessionExport';
import { PBR_MATERIALS } from './materials';
import {
  createInitialFoleySceneState,
  DEFAULT_FOLEY_SCENE_CONFIG,
  getFootstepCadenceHz,
  stepFoleyScene,
} from './foleyScenes';
import {
  computeSegmentOcclusion,
  computeSpatialAcousticProbe,
  computeStandingWaveModes,
  encodeStereoWav24Bit,
  generateLogSineSweep,
  generateSpatialRoomImpulseResponse,
  getRoomAcousticOccluder,
} from './spatialAcoustics';
import type { ObjectPhysicsConfig, RoomAcousticConfig, RoughnessPixelMap } from './types';

test('computeModalBank scales fundamental pitch inversely with mass and preserves material Q hierarchy', () => {
  const lightMetal: ObjectPhysicsConfig = {
    materialId: 'metal',
    shapeId: 'resonator_block',
    massKg: 1.5,
    roughness: 0.24,
    hardness: 0.92,
    elasticity: 0.62,
  };
  const heavyMetal: ObjectPhysicsConfig = { ...lightMetal, massKg: 12.0 };
  const wood: ObjectPhysicsConfig = {
    materialId: 'wood',
    shapeId: 'resonator_block',
    massKg: 1.5,
    roughness: 0.62,
    hardness: 0.46,
    elasticity: 0.44,
  };

  const lightBank = computeModalBank(lightMetal);
  const heavyBank = computeModalBank(heavyMetal);
  const woodBank = computeModalBank(wood);

  assert.equal(lightBank.length, 8);
  assert.ok(
    lightBank[0].frequencyHz > heavyBank[0].frequencyHz,
    'Lighter object must have higher fundamental frequency'
  );
  assert.ok(
    lightBank[0].qFactor > woodBank[0].qFactor * 3,
    'Metal must exhibit substantially higher modal Q resonance than wood'
  );

  for (const partial of lightBank) {
    assert.ok(partial.frequencyHz >= 40 && partial.frequencyHz <= 18500);
    assert.ok(partial.decayMs >= 18);
  }
});

test('generateRoomImpulseResponse responds accurately to room size and wall absorption at 48kHz', () => {
  const dryBooth: RoomAcousticConfig = {
    materialId: 'acoustic_foam',
    sizePreset: 'booth',
    scaleMultiplier: 1.0,
    wallAbsorption: 0.82,
    dryWet: 0.35,
  };
  const liveCathedral: RoomAcousticConfig = {
    materialId: 'concrete',
    sizePreset: 'cathedral',
    scaleMultiplier: 1.0,
    wallAbsorption: 0.08,
    dryWet: 0.65,
  };

  const boothIr = generateRoomImpulseResponse(dryBooth, 48000);
  const cathedralIr = generateRoomImpulseResponse(liveCathedral, 48000);

  assert.equal(boothIr.sampleRate, 48000);
  assert.equal(boothIr.left.length, boothIr.right.length);
  assert.equal(boothIr.envelopePreview.length, 128);
  assert.ok(
    cathedralIr.rt60Seconds > boothIr.rt60Seconds * 5,
    'Cathedral concrete room must have much longer RT60 than acoustic booth'
  );
  assert.ok(cathedralIr.left.length > boothIr.left.length);

  // Verify non-silent IR energy
  let peak = 0;
  for (let i = 0; i < cathedralIr.left.length; i++) {
    peak = Math.max(peak, Math.abs(cathedralIr.left[i]));
  }
  assert.ok(peak > 0.5, 'Normalized IR should have clear peak energy');
});

test('stepPhysics gravity drop triggers impact event and bounce restitution at y=0', () => {
  const objCfg: ObjectPhysicsConfig = {
    materialId: 'glass',
    shapeId: 'composite_orb',
    massKg: 1.2,
    roughness: 0.08,
    hardness: 0.96,
    elasticity: 0.55,
  };
  const roomDims = { width: 7.4, height: 4.2, depth: 6.8 };

  let state = prepareDropState(createInitialBodyState(), 2.2);
  let impactDetected = false;
  let maxImpactSpeed = 0;

  for (let step = 0; step < 120; step++) {
    const res = stepPhysics(state, objCfg, roomDims, 0.016, {
      autoDragActive: false,
      dragTarget: null,
      nowMs: step * 16,
    });
    state = res.state;
    for (const ev of res.events) {
      if (ev.type === 'impact') {
        impactDetected = true;
        maxImpactSpeed = Math.max(maxImpactSpeed, ev.velocity);
      }
    }
  }

  assert.equal(impactDetected, true, 'Dropping object from 2.2m must emit an impact contact event');
  assert.ok(maxImpactSpeed > 5.0, 'Impact speed from 2.2m drop should exceed 5 m/s');
  assert.ok(state.impactCount >= 1);
  assert.ok(state.position.y >= 0, 'Object must never penetrate below floor y=0');
});

test('continuous auto-drag emits friction events modulated by PBR roughness map', () => {
  const concreteCfg: ObjectPhysicsConfig = {
    materialId: 'concrete',
    shapeId: 'resonator_block',
    massKg: 8.5,
    roughness: 0.88,
    hardness: 0.78,
    elasticity: 0.22,
  };
  const roomDims = { width: 7.4, height: 4.2, depth: 6.8 };
  let state = createInitialBodyState();

  const frictionEvents = [];
  for (let step = 0; step < 25; step++) {
    const res = stepPhysics(state, concreteCfg, roomDims, 0.016, {
      autoDragActive: true,
      dragTarget: null,
      nowMs: step * 16,
    });
    state = res.state;
    frictionEvents.push(...res.events.filter((e) => e.type === 'friction'));
  }

  assert.ok(frictionEvents.length > 15, 'Auto-drag must emit continuous friction events');
  assert.ok(frictionEvents[5].velocity > 0.5, 'Tangential drag velocity must be positive');

  const roughLow = sampleRoughnessMap(1.2, 0.4, 'glass', 0.08);
  const roughHigh = sampleRoughnessMap(1.2, 0.4, 'concrete', 0.88);
  assert.ok(roughHigh.roughness > roughLow.roughness * 4);
});

test('traceAcousticRays returns direct path plus 5 first-order reflections attenuated by wall absorption', () => {
  const roomDims = { width: 8, height: 4, depth: 8 };
  const lowAbsRays = traceAcousticRays({ x: 0, y: 0.3, z: 0 }, { x: 2, y: 1.4, z: 2 }, roomDims, 0.1);
  const highAbsRays = traceAcousticRays({ x: 0, y: 0.3, z: 0 }, { x: 2, y: 1.4, z: 2 }, roomDims, 0.88);

  assert.equal(lowAbsRays.length, 6);
  assert.equal(lowAbsRays[0].order, 0);
  assert.ok(lowAbsRays[1].attenuation > highAbsRays[1].attenuation);

  const metrics = computeRoomAcousticMetrics({
    materialId: 'wood',
    sizePreset: 'studio',
    scaleMultiplier: 1,
    wallAbsorption: 0.24,
    dryWet: 0.4,
  });
  assert.ok(metrics.volumeM3 > 100 && metrics.rt60Seconds > 0.3);
});

test('computeAudioLevels calculates accurate dBFS and LUFS for sine signal and silence', () => {
  const silence = new Float32Array(512);
  const silentLevels = computeAudioLevels(silence);
  assert.equal(silentLevels.peakDb, -96);

  const sine = new Float32Array(1024);
  for (let i = 0; i < sine.length; i++) {
    sine[i] = 0.5 * Math.sin((2 * Math.PI * 10 * i) / sine.length);
  }
  const levels = computeAudioLevels(sine);
  assert.ok(levels.peakDb > -6.5 && levels.peakDb < -5.5, '0.5 amplitude sine peak should be ~-6 dBFS');
  assert.ok(levels.rmsDb < levels.peakDb);
  assert.ok(levels.lufsMomentary < levels.rmsDb);
});

test('normalizeGeneratedMaterialPayload validates, clamps, and produces exactly 12 sorted modal modes', () => {
  const rawPayload = {
    name: 'Cerámica Hueca',
    subtitle: 'Porcelana esmaltada de pared fina',
    acousticNotes: 'Cavidad resonante en 380 Hz y agudos vítreos de alto Q.',
    densityKgM3: 1150,
    hardness: 0.89,
    elasticity: 0.42,
    roughness: 0.14,
    metalness: 0.03,
    transmission: 0.0,
    ior: 1.54,
    clearcoat: 0.86,
    frictionCoeff: 0.31,
    neuralHarmonicDrive: 0.22,
    neuralFormantHz: 2100,
    modes: [
      { frequencyHz: 1840, gain: 0.65, qFactor: 140 },
      { frequencyHz: 380, gain: 1.0, qFactor: 68 },
      { frequencyHz: 790, gain: 0.84, qFactor: 115 },
      { frequencyHz: 1290, gain: 0.72, qFactor: 132 },
      { frequencyHz: 2450, gain: 0.56, qFactor: 155 },
      { frequencyHz: 3120, gain: 0.48, qFactor: 162 },
      { frequencyHz: 4050, gain: 0.39, qFactor: 150 },
      { frequencyHz: 5180, gain: 0.31, qFactor: 138 },
      { frequencyHz: 6420, gain: 0.24, qFactor: 125 },
      { frequencyHz: 7890, gain: 0.18, qFactor: 112 },
      { frequencyHz: 9400, gain: 0.13, qFactor: 98 },
      { frequencyHz: 11200, gain: 0.09, qFactor: 86 },
    ],
    texture: {
      pattern: 'ceramic_glaze',
      primaryColor: '#e9e4db',
      secondaryColor: '#cfc5b6',
      accentColor: '#9c8f7e',
      grainScale: 1.2,
      contrast: 0.35,
      bumpIntensity: 0.25,
    },
  };

  const spec = normalizeGeneratedMaterialPayload(rawPayload, 'cerámica hueca');
  assert.equal(spec.isCustom, true);
  assert.equal(spec.modes.length, 12);
  assert.equal(spec.baseFundamentalHz, 380);
  assert.equal(spec.modes[0].ratio, 1);
  assert.equal(spec.textureRecipe?.pattern, 'ceramic_glaze');
  assert.equal(spec.swatchColor, '#e9e4db');

  // Verify all 12 modes flow cleanly through computeModalBank
  const bank = computeModalBank(
    {
      materialId: spec.id,
      shapeId: 'resonator_block',
      massKg: spec.defaultMassKg,
      roughness: spec.defaultRoughness,
      hardness: spec.defaultHardness,
      elasticity: spec.defaultElasticity,
    },
    spec
  );
  assert.equal(bank.length, 12);
  for (let i = 1; i < bank.length; i++) {
    assert.ok(bank[i].frequencyHz >= bank[i - 1].frequencyHz);
  }

  // Reject malformed payloads with too few modes
  assert.throws(() => normalizeGeneratedMaterialPayload({ name: 'Inválido', modes: [] }, 'x'));
});

test('computeSpatialAcousticProbe captures Haas ITD polarity, corner standing-wave antinodes, and gobo occlusion', () => {
  const roomConfig: RoomAcousticConfig = {
    materialId: 'concrete',
    sizePreset: 'studio',
    scaleMultiplier: 1.0,
    wallAbsorption: 0.14,
    dryWet: 0.42,
  };
  const dims = computeRoomAcousticMetrics(roomConfig).dimensions;
  const occluder = getRoomAcousticOccluder(dims);
  const source = { x: 0, y: 0.35, z: 0 };

  // Left vs Right microphone placement flips Haas ITD sign
  const probeLeft = computeSpatialAcousticProbe(source, { x: -2.2, y: 1.4, z: 1.4 }, dims, roomConfig, occluder);
  const probeRight = computeSpatialAcousticProbe(source, { x: 2.2, y: 1.4, z: 1.4 }, dims, roomConfig, occluder);
  assert.ok(probeLeft.haasItdMs > 0.1, 'Source to the right of mic should yield positive ITD');
  assert.ok(probeRight.haasItdMs < -0.1, 'Source to the left of mic should yield negative ITD');
  assert.equal(probeLeft.occlusionFactor, 0, 'Front-left mic must have clear line of sight');

  // Corner placement excites positive standing-wave antinode boost vs center pressure node
  const cornerModes = computeStandingWaveModes(
    dims,
    { x: -dims.width * 0.48, y: 0.2, z: -dims.depth * 0.48 },
    roomConfig.wallAbsorption
  );
  const centerModes = computeStandingWaveModes(
    dims,
    { x: 0, y: dims.height * 0.5, z: 0 },
    roomConfig.wallAbsorption
  );
  assert.ok(cornerModes[0].gainDb > 3.5, 'Room corner should strongly boost standing-wave antinode');
  assert.ok(centerModes[0].gainDb < -3.5, 'Room center should fall into odd-mode pressure null');

  // Placement behind acoustic gobo panel produces strong geometric occlusion & LP roll-off
  const occludedMic = {
    x: occluder.center.x + 0.55,
    y: occluder.center.y,
    z: occluder.center.z - 0.75,
  };
  const occ = computeSegmentOcclusion(source, occludedMic, occluder);
  assert.ok(occ.occlusionFactor > 0.5, 'Mic behind acoustic gobo must be occluded');
  assert.ok(occ.cutoffHz < 3500, 'Occlusion must significantly lower lowpass diffraction cutoff');
  assert.ok(occ.attenuationDb < -5, 'Occlusion must attenuate direct path dB');
});

test('generateLogSineSweep and generateSpatialRoomImpulseResponse produce valid 48kHz signals', () => {
  const sweep = generateLogSineSweep(2.0, 20, 20000, 48000);
  assert.equal(sweep.length, 96000);
  assert.ok(Math.abs(sweep[0]) < 1e-4, 'Sweep must start smoothly at 0');
  assert.ok(Math.abs(sweep[sweep.length - 1]) < 1e-4, 'Sweep must end smoothly at 0');

  let sweepPeak = 0;
  for (let i = 0; i < sweep.length; i++) {
    sweepPeak = Math.max(sweepPeak, Math.abs(sweep[i]));
  }
  assert.ok(sweepPeak > 0.4 && sweepPeak <= 0.6);

  const roomConfig: RoomAcousticConfig = {
    materialId: 'wood',
    sizePreset: 'studio',
    scaleMultiplier: 1.0,
    wallAbsorption: 0.24,
    dryWet: 0.45,
  };
  const dims = computeRoomAcousticMetrics(roomConfig).dimensions;
  const occluder = getRoomAcousticOccluder(dims);
  const irA = generateSpatialRoomImpulseResponse(roomConfig, { x: 0, y: 0.35, z: 0 }, { x: -2.0, y: 1.4, z: 1.5 }, occluder, 48000);
  const irB = generateSpatialRoomImpulseResponse(roomConfig, { x: 0, y: 0.35, z: 0 }, { x: occluder.center.x + 0.5, y: 1.0, z: occluder.center.z - 0.7 }, occluder, 48000);

  assert.equal(irA.sampleRate, 48000);
  assert.equal(irA.left.length, irA.right.length);
  assert.notEqual(irA.left[24], irB.left[24], 'Spatial IR must vary meaningfully with 3D microphone coordinate');
});

test('encodeStereoWav24Bit builds a standards-compliant 24-bit / 48kHz stereo RIFF PCM WAV file', () => {
  const left = new Float32Array([0, 0.5, -0.5, 1.0, -1.0]);
  const right = new Float32Array([0, -0.25, 0.25, -1.0, 1.0]);
  const wav = encodeStereoWav24Bit(left, right, 48000);
  const view = new DataView(wav);
  const bytes = new Uint8Array(wav);
  const ascii = (start: number, len: number) =>
    String.fromCharCode(...bytes.slice(start, start + len));

  assert.equal(wav.byteLength, 44 + 5 * 6);
  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), 36 + 5 * 6);
  assert.equal(ascii(8, 4), 'WAVE');
  assert.equal(ascii(12, 4), 'fmt ');
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 2); // Stereo
  assert.equal(view.getUint32(24, true), 48000); // 48 kHz
  assert.equal(view.getUint32(28, true), 288000); // 48000 * 2 * 3
  assert.equal(view.getUint16(32, true), 6); // BlockAlign = 6 bytes
  assert.equal(view.getUint16(34, true), 24); // 24-bit
  assert.equal(ascii(36, 4), 'data');
  assert.equal(view.getUint32(40, true), 30);

  // Decode sample 1 left (+0.5 -> +4194304) from 3 little-endian bytes at offset 44 + 6 = 50
  const b0 = bytes[50];
  const b1 = bytes[51];
  const b2 = bytes[52];
  let decoded = b0 | (b1 << 8) | (b2 << 16);
  if (decoded & 0x800000) decoded |= ~0xffffff;
  assert.ok(Math.abs(decoded / 8388607 - 0.5) < 1e-5, '24-bit PCM sample round-trip must be exact');
});

function createBoxTriangleBuffer(sx: number, sy: number, sz: number) {
  const hx = sx * 0.5;
  const hz = sz * 0.5;
  const positions = new Float32Array([
    -hx, 0, -hz,   hx, 0, -hz,   hx, sy, -hz,   -hx, sy, -hz, // back
    -hx, 0,  hz,   hx, 0,  hz,   hx, sy,  hz,   -hx, sy,  hz, // front
  ]);
  // Outward-wound 12 triangles covering all 6 faces
  const indices = [
    0, 2, 1, 0, 3, 2, // back (-Z)
    4, 5, 6, 4, 6, 7, // front (+Z)
    0, 1, 5, 0, 5, 4, // bottom (-Y)
    3, 7, 6, 3, 6, 2, // top (+Y)
    0, 4, 7, 0, 7, 3, // left (-X)
    1, 2, 6, 1, 6, 5, // right (+X)
  ];
  return { positions, indices };
}

test('analyzeTriangleBuffers computes exact BBox, tetrahedral volume, and scales modal fundamental frequency', () => {
  const largeCube = analyzeTriangleBuffers([createBoxTriangleBuffer(2.0, 2.0, 2.0)]);
  const smallCube = analyzeTriangleBuffers([createBoxTriangleBuffer(0.25, 0.25, 0.25)]);

  assert.equal(largeCube.triangleCount, 12);
  assert.deepEqual(largeCube.rawBoundingBox, { x: 2, y: 2, z: 2 });
  assert.ok(Math.abs(largeCube.approximateVolumeM3 - 8.0) < 0.01, '2m cube volume must be 8.0 m³');
  assert.ok(Math.abs(smallCube.approximateVolumeM3 - 0.0156) < 0.001, '0.25m cube volume must be ~0.0156 m³');
  assert.ok(
    smallCube.volumePitchScale > largeCube.volumePitchScale * 4,
    'Smaller volume mesh must have a significantly higher modal pitch multiplier'
  );

  const baseCfg: ObjectPhysicsConfig = {
    materialId: 'metal',
    shapeId: 'imported_mesh',
    massKg: 4.2,
    roughness: 0.25,
    hardness: 0.9,
    elasticity: 0.6,
  };
  const largeBank = computeModalBank({ ...baseCfg, customVolumePitchScale: largeCube.volumePitchScale });
  const smallBank = computeModalBank({ ...baseCfg, customVolumePitchScale: smallCube.volumePitchScale });
  assert.ok(
    smallBank[0].frequencyHz > largeBank[0].frequencyHz * 4,
    'Modal fundamental frequency must scale inversely with cube-root of imported mesh volume'
  );
});

test('sampleRoughnessPixel reads glTF PBR roughness pixels and modulates live friction during drag', () => {
  // Build a 16x16 split PBR metallicRoughness texture: left half smooth (G=25 -> ~0.10), right half rough (G=235 -> ~0.92)
  const w = 16;
  const h = 16;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const g = x < w / 2 ? 25 : 235;
      data[idx] = 0;
      data[idx + 1] = g;
      data[idx + 2] = 0;
      data[idx + 3] = 255;
    }
  }

  const pixelMap: RoughnessPixelMap = {
    width: w,
    height: h,
    data,
    roughnessFactor: 1.0,
    isGltfPacked: true,
    flipY: false,
    repeatU: 1,
    repeatV: 1,
    offsetU: 0,
    offsetV: 0,
  };

  const smoothPx = sampleRoughnessPixel(pixelMap, 0.2, 0.5, 1.0);
  const roughPx = sampleRoughnessPixel(pixelMap, 0.8, 0.5, 1.0);
  const boundaryPx = sampleRoughnessPixel(pixelMap, 0.5, 0.5, 1.0);

  assert.ok(smoothPx.roughness < 0.15, `Smooth pixel expected <0.15, got ${smoothPx.roughness}`);
  assert.ok(roughPx.roughness > 0.85, `Rough pixel expected >0.85, got ${roughPx.roughness}`);
  assert.ok(boundaryPx.asperity > smoothPx.asperity + 0.35, 'Roughness transition edge must elevate stick-slip asperity');
  assert.ok(Math.abs(computeMeanRoughnessFromPixelMap(pixelMap) - 0.51) < 0.05);

  // Run continuous drag in stepPhysics with this roughnessPixelMap and verify real-time pixel modulation
  const cfg: ObjectPhysicsConfig = {
    materialId: 'metal',
    shapeId: 'imported_mesh',
    massKg: 4.2,
    roughness: 0.5,
    hardness: 0.85,
    elasticity: 0.5,
    customVolumePitchScale: 1.0,
  };
  let state = createInitialBodyState();
  const sampledRoughnesses: number[] = [];
  for (let i = 0; i < 60; i++) {
    const res = stepPhysics(state, cfg, { width: 7.4, height: 4.2, depth: 6.8 }, 0.02, {
      autoDragActive: true,
      dragTarget: null,
      nowMs: i * 20,
      roughnessPixelMap: pixelMap,
    });
    state = res.state;
    for (const ev of res.events) {
      if (ev.type === 'friction') {
        assert.equal(ev.roughnessSource, 'pbr_texture');
        sampledRoughnesses.push(ev.localRoughness);
      }
    }
  }
  const minR = Math.min(...sampledRoughnesses);
  const maxR = Math.max(...sampledRoughnesses);
  assert.ok(
    maxR - minR > 0.6,
    `Continuous drag must sample both smooth (${minR}) and rough (${maxR}) pixels from PBR texture`
  );
});

test('computeDualHertzPartition partitions impact energy by relative hardness and supplies valid surface modal banks', () => {
  const hardOnSoft = computeDualHertzPartition(0.95, 'wood');
  const softOnHard = computeDualHertzPartition(0.28, 'glass');

  assert.ok(Math.abs(hardOnSoft.objectEnergyShare + hardOnSoft.surfaceEnergyShare - 1.0) < 0.002);
  assert.ok(Math.abs(softOnHard.objectEnergyShare + softOnHard.surfaceEnergyShare - 1.0) < 0.002);
  assert.ok(
    hardOnSoft.surfaceEnergyShare > hardOnSoft.objectEnergyShare,
    'Hard object striking softer wood floor must deliver larger deformation share to the wood surface'
  );
  assert.ok(
    softOnHard.objectEnergyShare > softOnHard.surfaceEnergyShare,
    'Soft object striking hard glass floor must absorb larger deformation share in the object'
  );
  assert.ok(hardOnSoft.hertzContactMs >= 0.8 && hardOnSoft.hertzContactMs <= 14.0);

  for (const roomMat of ['concrete', 'wood', 'glass', 'acoustic_foam'] as const) {
    const floorBank = computeSurfaceModalBank(roomMat, false);
    const wallBank = computeSurfaceModalBank(roomMat, true);
    assert.ok(floorBank.length >= 4);
    assert.ok(wallBank[0].frequencyHz > floorBank[0].frequencyHz);
  }
});

test('computeElasticCavityParams anchors internal air cavity at 850 Hz with a 20 ms force-proportional upward pitch envelope', () => {
  const gentle = computeElasticCavityParams(1.2, 0.72, 4.2);
  const strong = computeElasticCavityParams(6.4, 0.72, 4.2);

  assert.equal(gentle.baseCavityHz, 850);
  assert.equal(gentle.pitchEnvelopeMs, 20);
  assert.equal(strong.pitchEnvelopeMs, 20);
  assert.ok(gentle.peakCavityHz > gentle.baseCavityHz, 'Impact compression must bend pitch upward');
  assert.ok(
    strong.peakCavityHz > gentle.peakCavityHz,
    'Stronger impact velocity must produce a larger upward pitch shift'
  );
  assert.ok(strong.cavityGain > gentle.cavityGain);
});

test('computePoissonLambda and generatePoissonFractureBuffer modulate high-frequency micro-impulse density with velocity', () => {
  assert.equal(computePoissonLambda(0, 4.2, 0.7), 0);

  const slowLambda = computePoissonLambda(0.45, 4.2, 0.75);
  const fastLambda = computePoissonLambda(2.1, 4.2, 0.75);
  assert.ok(fastLambda > slowLambda * 2.5, 'Higher drag velocity must substantially increase Poisson impulse rate');

  const slowBuf = generatePoissonFractureBuffer({
    durationSec: 0.25,
    lambdaHz: slowLambda,
    roughness: 0.75,
    sampleRate: 48000,
    seed: 12345,
  });
  const fastBuf = generatePoissonFractureBuffer({
    durationSec: 0.25,
    lambdaHz: fastLambda,
    roughness: 0.75,
    sampleRate: 48000,
    seed: 12345,
  });

  assert.equal(slowBuf.samples.length, 12000);
  assert.ok(fastBuf.impulseCount > slowBuf.impulseCount * 2);
});

test('generateFriedlanderShockwave produces instantaneous positive shock, negative rarefaction phase, soft saturation, and distance LP', () => {
  const nearCutoff = computeShockwaveDistanceCutoffHz(1.2);
  const farCutoff = computeShockwaveDistanceCutoffHz(9.5);
  assert.ok(nearCutoff > farCutoff * 2.2, 'Distance low-pass cutoff must decrease sharply with propagation distance');

  const blast = generateFriedlanderShockwave({
    distanceMeters: 2.6,
    intensity: 1.2,
    sampleRate: 48000,
    durationSec: 0.42,
  });

  assert.equal(blast.sampleRate, 48000);
  assert.equal(blast.samples.length, Math.floor(0.42 * 48000));
  assert.ok(blast.peakPositive > 0.45 && blast.peakPositive <= 1.0, 'Peak positive overpressure must be softly saturated within (0.45, 1.0]');
  assert.ok(blast.minNegative < -0.1, `Friedlander waveform must exhibit a true negative rarefaction phase, got ${blast.minNegative}`);
  assert.ok(blast.minNegative >= -1.0);
  assert.ok(blast.positivePhaseMs > 5 && blast.positivePhaseMs < 50);

  // Verify shock front reaches peak within first 4 ms (instantaneous rise)
  let peakIdx = 0;
  for (let i = 0; i < blast.samples.length; i++) {
    if (blast.samples[i] > blast.samples[peakIdx]) peakIdx = i;
  }
  assert.ok(peakIdx / blast.sampleRate < 0.005, 'Mach shock front must peak rapidly near t=0');
});

test('RBJ 48kHz biquad coefficient generators satisfy pole stability and exact frequency response targets', () => {
  const bp = computeBiquadBandpassCoeffs(1200, 18, 48000);
  // Schur-Cohn stability triangle for 2nd-order denominator 1 + a1*z^-1 + a2*z^-2
  assert.ok(Math.abs(bp.a2) < 1 && 1 + bp.a1 + bp.a2 > 0 && 1 - bp.a1 + bp.a2 > 0);
  const magAtCenter = evaluateBiquadMagnitude(bp, 1200, 48000);
  const magOffCenter = evaluateBiquadMagnitude(bp, 4000, 48000);
  assert.ok(Math.abs(magAtCenter - 1.0) < 1e-4, `Constant-peak bandpass must have 0 dB gain at center, got ${magAtCenter}`);
  assert.ok(magOffCenter < 0.05, 'High-Q bandpass must strongly attenuate far off-center frequencies');

  const peak = computeBiquadPeakingCoeffs(92, 6.5, 6.0, 48000);
  const peakMag = evaluateBiquadMagnitude(peak, 92, 48000);
  const expectedLinear = Math.pow(10, 6.0 / 20);
  assert.ok(Math.abs(peakMag - expectedLinear) < 0.01, `Peaking EQ +6 dB should have linear gain ~${expectedLinear}, got ${peakMag}`);

  const lp = computeBiquadLowpassCoeffs(2000, 0.7071, 48000);
  const lpPass = evaluateBiquadMagnitude(lp, 120, 48000);
  const lpStop = evaluateBiquadMagnitude(lp, 12000, 48000);
  assert.ok(lpPass > 0.99 && lpStop < 0.05);
});

test('generateCppAcousticPresetHeader emits valid self-contained C++20 header with biquads, physics, and room acoustics', () => {
  const objectConfig: ObjectPhysicsConfig = {
    materialId: 'metal',
    shapeId: 'resonator_block',
    massKg: 4.2,
    roughness: 0.24,
    hardness: 0.92,
    elasticity: 0.62,
  };
  const roomConfig: RoomAcousticConfig = {
    materialId: 'concrete',
    sizePreset: 'studio',
    scaleMultiplier: 1.0,
    wallAbsorption: 0.14,
    dryWet: 0.42,
  };
  const roomMetrics = computeRoomAcousticMetrics(roomConfig);
  const modalBank = computeModalBank(objectConfig, PBR_MATERIALS.metal);
  const spatialProbe = computeSpatialAcousticProbe(
    { x: 0, y: 0.35, z: 0 },
    { x: -2.2, y: 1.45, z: 1.6 },
    roomMetrics.dimensions,
    roomConfig,
    getRoomAcousticOccluder(roomMetrics.dimensions)
  );

  const header = generateCppAcousticPresetHeader({
    objectConfig,
    materialSpec: PBR_MATERIALS.metal,
    modalBank,
    roomConfig,
    roomMetrics,
    dspConfig: {
      excitationMode: 'dual_hertz',
      neuralConditioning: 0.55,
      frictionGain: 1.0,
      showAcousticRays: true,
      masterGainDb: 0,
    },
    spatialProbe,
    sampleRate: 48000,
  });

  assert.ok(header.includes('#pragma once'));
  assert.ok(header.includes('namespace acoustic3d::preset'));
  assert.ok(header.includes('inline constexpr float processBiquadDF2T('));
  assert.ok(header.includes('inline constexpr uint32_t kSampleRateHz = 48000u;'));
  assert.ok(header.includes(`inline constexpr std::size_t kObjectModalCount = ${modalBank.length}u;`));
  assert.ok(header.includes('4.2f'), 'Object massKg must appear in C++ preset');
  assert.ok(header.includes('0.24f'), 'Object roughness must appear in C++ preset');
  assert.ok(header.includes('kRoomAcoustics'));
  assert.ok(header.includes('kSpatialMic'));
  assert.ok(!header.includes('NaN'), 'Exported C++ header must never contain NaN');
});

test('concatStereoChunks stitches recorded PCM blocks cleanly into a 48kHz 24-bit Stereo WAV', () => {
  const c1L = new Float32Array([0.1, 0.25, -0.5]);
  const c1R = new Float32Array([-0.1, -0.25, 0.5]);
  const c2L = new Float32Array([0.8, -0.2]);
  const c2R = new Float32Array([0.4, 0.2]);

  const stitched = concatStereoChunks([c1L, c2L], [c1R, c2R]);
  assert.equal(stitched.totalSamples, 5);
  assert.ok(Math.abs(stitched.left[3] - 0.8) < 1e-6);
  assert.ok(Math.abs(stitched.right[4] - 0.2) < 1e-6);
  assert.ok(Math.abs(stitched.peakLinear - 0.8) < 1e-6);

  const wav = encodeStereoWav24Bit(stitched.left, stitched.right, 48000);
  assert.equal(wav.byteLength, 44 + 5 * 6);
});

test('stepFoleyScene Basketball simulates gravity bounce, squash-stretch deformation, and floor surface selection', () => {
  let state = createInitialFoleySceneState();
  const cfg = {
    ...DEFAULT_FOLEY_SCENE_CONFIG,
    enabled: true,
    sceneId: 'basketball' as const,
    basketballCadence: 'fast_crossover' as const,
    basketballFloor: 'wood' as const,
  };

  let bounceTriggerCount = 0;
  let minSquashY = 1.0;
  for (let i = 0; i < 160; i++) {
    const res = stepFoleyScene(state, cfg, 1 / 60);
    state = res.next;
    minSquashY = Math.min(minSquashY, state.basketball.squashY);
    for (const trig of res.triggers) {
      if (trig.kind === 'basketball_bounce') {
        bounceTriggerCount += 1;
        assert.equal(trig.surfaceMaterial, 'wood');
        assert.ok(trig.velocity > 0.65);
      }
    }
  }

  assert.ok(bounceTriggerCount >= 2, `Fast crossover should trigger multiple floor bounces, got ${bounceTriggerCount}`);
  assert.ok(minSquashY < 0.9, `Floor impact must compress ball vertically via squash & stretch, got minSquashY=${minSquashY}`);
});

test('stepFoleyScene Footsteps emits alternating heel-to-toe triggers modulated by walk vs run speed', () => {
  const slowCfg = {
    ...DEFAULT_FOLEY_SCENE_CONFIG,
    enabled: true,
    sceneId: 'footsteps' as const,
    footstepTerrain: 'gravel_branches' as const,
    footstepSpeed: 0.1,
  };
  const fastCfg = { ...slowCfg, footstepSpeed: 0.95 };

  assert.ok(getFootstepCadenceHz(fastCfg.footstepSpeed) > getFootstepCadenceHz(slowCfg.footstepSpeed) * 2);

  let slowState = createInitialFoleySceneState();
  let fastState = createInitialFoleySceneState();
  let slowHeels = 0;
  let fastHeels = 0;
  let sawToe = false;

  for (let i = 0; i < 120; i++) {
    const rSlow = stepFoleyScene(slowState, slowCfg, 1 / 60);
    slowState = rSlow.next;
    slowHeels += rSlow.triggers.filter((t) => t.kind === 'footstep_heel').length;

    const rFast = stepFoleyScene(fastState, fastCfg, 1 / 60);
    fastState = rFast.next;
    fastHeels += rFast.triggers.filter((t) => t.kind === 'footstep_heel').length;
    if (rFast.triggers.some((t) => t.kind === 'footstep_toe' && t.terrain === 'gravel_branches')) {
      sawToe = true;
    }
  }

  assert.ok(fastHeels > slowHeels, 'Running cadence must emit more heel strikes than slow walking');
  assert.equal(sawToe, true, 'Footsteps cycle must emit toe roll triggers as well as heel strikes');
});

test('stepFoleyScene Percussion triggers all 3 modal instruments (snare, cymbal, woodblock) on tempo', () => {
  let state = createInitialFoleySceneState();
  const cfg = {
    ...DEFAULT_FOLEY_SCENE_CONFIG,
    enabled: true,
    sceneId: 'percussion' as const,
    percussionBpm: 120,
  };

  const seenKinds = new Set<string>();
  for (let i = 0; i < 160; i++) {
    const res = stepFoleyScene(state, cfg, 1 / 60);
    state = res.next;
    for (const trig of res.triggers) {
      seenKinds.add(trig.kind);
    }
  }

  assert.ok(seenKinds.has('percussion_snare'), 'Groove must strike Snare');
  assert.ok(seenKinds.has('percussion_cymbal'), 'Groove must strike Metallic Cymbal');
  assert.ok(seenKinds.has('percussion_woodblock'), 'Groove must strike Woodblock');
  assert.ok(state.percussion.hitCount >= 8);
});





