import { ROOM_MATERIALS } from './materials';
import { computeRoomAcousticMetrics, SPEED_OF_SOUND_MPS, traceAcousticRays } from './physics';
import type { ImpulseResponseData } from './dspMath';
import type {
  AcousticOccluderBox,
  RoomAcousticConfig,
  RoomDimensions,
  SpatialAcousticProbe,
  StandingWaveMode,
  Vec3,
} from './types';

const HEAD_RADIUS_M = 0.088; // Standard acoustic stereo/binaural spacing half-width (~17.6 cm)

/**
 * Returns the architectural freestanding acoustic gobo / divider panel inside the room.
 * Placed cleanly in the back-right quadrant so the hero object and default front-left mic
 * remain completely unobstructed, while dragging the mic behind it demonstrates true acoustic occlusion.
 */
export function getRoomAcousticOccluder(roomDims: RoomDimensions): AcousticOccluderBox {
  const halfW = roomDims.width * 0.5;
  const halfD = roomDims.depth * 0.5;
  const panelWidth = Math.min(1.55, Math.max(1.05, roomDims.width * 0.2));
  const panelHeight = Math.min(2.15, Math.max(1.45, roomDims.height * 0.58));
  const panelThickness = 0.16;

  return {
    center: {
      x: Math.min(halfW - 0.95, roomDims.width * 0.22),
      y: panelHeight * 0.5,
      z: -Math.min(halfD - 0.95, roomDims.depth * 0.14),
    },
    halfExtents: {
      x: panelWidth * 0.5,
      y: panelHeight * 0.5,
      z: panelThickness * 0.5,
    },
  };
}

/**
 * Computes geometric line-of-sight occlusion between source and listener against an axis-aligned
 * acoustic gobo/partition box using exact 3D slab ray-AABB intersection plus smooth edge diffraction.
 */
export function computeSegmentOcclusion(
  source: Vec3,
  listener: Vec3,
  occluder: AcousticOccluderBox
): {
  occlusionFactor: number; // 0 = unobstructed, 0..0.92 = occluded
  cutoffHz: number;        // 19500 Hz open -> ~720 Hz fully occluded
  attenuationDb: number;   // 0 dB open -> ~-14 dB fully occluded
} {
  const dx = listener.x - source.x;
  const dy = listener.y - source.y;
  const dz = listener.z - source.z;
  const segLen = Math.hypot(dx, dy, dz);
  if (segLen < 1e-4) {
    return { occlusionFactor: 0, cutoffHz: 19500, attenuationDb: 0 };
  }

  // Expand slightly for Fresnel edge diffraction transition zone (0.24 m penumbra)
  const penumbra = 0.24;
  const minX = occluder.center.x - occluder.halfExtents.x - penumbra;
  const maxX = occluder.center.x + occluder.halfExtents.x + penumbra;
  const minY = occluder.center.y - occluder.halfExtents.y;
  const maxY = occluder.center.y + occluder.halfExtents.y + penumbra;
  const minZ = occluder.center.z - occluder.halfExtents.z - penumbra;
  const maxZ = occluder.center.z + occluder.halfExtents.z + penumbra;

  let tMin = 0;
  let tMax = 1;

  const clipAxis = (origin: number, dir: number, bMin: number, bMax: number): boolean => {
    if (Math.abs(dir) < 1e-7) {
      return origin >= bMin && origin <= bMax;
    }
    let t1 = (bMin - origin) / dir;
    let t2 = (bMax - origin) / dir;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    return tMin <= tMax;
  };

  const hitsPenumbra =
    clipAxis(source.x, dx, minX, maxX) &&
    clipAxis(source.y, dy, minY, maxY) &&
    clipAxis(source.z, dz, minZ, maxZ);

  if (!hitsPenumbra) {
    return { occlusionFactor: 0, cutoffHz: 19500, attenuationDb: 0 };
  }

  // Evaluate midpoint of intersection against core box to determine deep shadow vs. edge diffraction
  const tMid = (tMin + tMax) * 0.5;
  const hitX = source.x + dx * tMid;
  const hitY = source.y + dy * tMid;
  const hitZ = source.z + dz * tMid;

  const distOutsideX = Math.max(0, Math.abs(hitX - occluder.center.x) - occluder.halfExtents.x);
  const distOutsideY = Math.max(0, hitY - (occluder.center.y + occluder.halfExtents.y));
  const distOutsideZ = Math.max(0, Math.abs(hitZ - occluder.center.z) - occluder.halfExtents.z);
  const edgeDist = Math.hypot(distOutsideX, distOutsideY, distOutsideZ);

  // Smooth diffraction transition across penumbra
  const coreShadow = Math.max(0, Math.min(1, 1 - edgeDist / penumbra));
  const occlusionFactor = Number((coreShadow * 0.88).toFixed(3));

  // Logarithmic frequency roll-off due to acoustic shadow diffraction
  const cutoffHz = Math.round(19500 * Math.pow(720 / 19500, occlusionFactor));
  const attenuationDb = Number((-occlusionFactor * 14.5).toFixed(1));

  return { occlusionFactor, cutoffHz, attenuationDb };
}

/**
 * Computes exact rectangular room standing-wave eigenmodes f(nx, ny, nz)
 * and evaluates the spatial acoustic pressure eigenfunction:
 *   Psi(x,y,z) = cos(nx*pi*ux) * cos(ny*pi*uy) * cos(nz*pi*uz)
 * Corners (|Psi| -> 1) create bass antinodes (+dB boost);
 * Room center for odd modes (|Psi| -> 0) creates pressure nulls (-dB dip).
 */
export function computeStandingWaveModes(
  roomDims: RoomDimensions,
  micPos: Vec3,
  wallAbsorption: number
): StandingWaveMode[] {
  const { width, height, depth } = roomDims;
  const ux = Math.max(0, Math.min(1, (micPos.x + width * 0.5) / Math.max(0.5, width)));
  const uy = Math.max(0, Math.min(1, micPos.y / Math.max(0.5, height)));
  const uz = Math.max(0, Math.min(1, (micPos.z + depth * 0.5) / Math.max(0.5, depth)));

  // Lower wall absorption produces stronger, narrower standing-wave resonances
  const damping = Math.max(0.08, Math.min(0.95, wallAbsorption));
  const maxBoostDb = 9.5 * (1 - damping * 0.72);
  const baseQ = 3.2 + (1 - damping) * 9.5;

  const candidates: Array<{ nx: number; ny: number; nz: number; label: string; weight: number }> = [
    { nx: 1, ny: 0, nz: 0, label: 'Axial X (1,0,0)', weight: 1.0 },
    { nx: 0, ny: 0, nz: 1, label: 'Axial Z (0,0,1)', weight: 1.0 },
    { nx: 0, ny: 1, nz: 0, label: 'Axial Y (0,1,0)', weight: 0.92 },
    { nx: 2, ny: 0, nz: 0, label: 'Axial 2X (2,0,0)', weight: 0.78 },
    { nx: 0, ny: 0, nz: 2, label: 'Axial 2Z (0,0,2)', weight: 0.78 },
    { nx: 1, ny: 0, nz: 1, label: 'Tangencial XZ (1,0,1)', weight: 0.74 },
  ];

  const modes: StandingWaveMode[] = candidates.map((c) => {
    const freq =
      (SPEED_OF_SOUND_MPS * 0.5) *
      Math.sqrt(
        Math.pow(c.nx / Math.max(1, width), 2) +
          Math.pow(c.ny / Math.max(1, height), 2) +
          Math.pow(c.nz / Math.max(1, depth), 2)
      );

    const pressure = Math.abs(
      Math.cos(c.nx * Math.PI * ux) *
        Math.cos(c.ny * Math.PI * uy) *
        Math.cos(c.nz * Math.PI * uz)
    );

    // Map pressure [0..1] around RMS room average (~0.5) to [-maxBoostDb .. +maxBoostDb]
    const centered = (pressure - 0.5) * 2.0; // -1 at node, +1 at antinode
    const gainDb = Number((centered * maxBoostDb * c.weight).toFixed(1));

    return {
      label: c.label,
      nx: c.nx,
      ny: c.ny,
      nz: c.nz,
      frequencyHz: Number(Math.max(24, Math.min(480, freq)).toFixed(1)),
      pressure: Number(pressure.toFixed(3)),
      gainDb,
      qFactor: Number((baseQ * (0.75 + 0.25 * c.weight)).toFixed(1)),
    };
  });

  // Return top 3 modes with largest absolute acoustic impact at current mic position
  return modes
    .sort((a, b) => Math.abs(b.gainDb) - Math.abs(a.gainDb))
    .slice(0, 3);
}

/**
 * Evaluates full real-time spatial acoustic telemetry at the measurement microphone:
 * Haas precedence ITD/ILD/first-reflection delta, standing-wave pressure nodes/antinodes,
 * geometric obstacle occlusion, and direct-to-reverberant ratio.
 */
export function computeSpatialAcousticProbe(
  source: Vec3,
  micPos: Vec3,
  roomDims: RoomDimensions,
  roomConfig: RoomAcousticConfig,
  occluder?: AcousticOccluderBox
): SpatialAcousticProbe {
  const activeOccluder = occluder ?? getRoomAcousticOccluder(roomDims);
  const metrics = computeRoomAcousticMetrics(roomConfig);

  const dx = source.x - micPos.x;
  const dy = source.y - micPos.y;
  const dz = source.z - micPos.z;
  const directDistanceM = Math.max(0.35, Math.hypot(dx, dy, dz));
  const directDelayMs = (directDistanceM / SPEED_OF_SOUND_MPS) * 1000;

  // Azimuth angle relative to listener facing -Z (front-to-back studio perspective)
  const horizDist = Math.max(0.01, Math.hypot(dx, dz));
  const azimuthRad = Math.atan2(dx, Math.max(0.15, Math.abs(dz) + 0.35));
  const clampedAzimuth = Math.max(-Math.PI * 0.48, Math.min(Math.PI * 0.48, azimuthRad));

  // Woodworth spherical-head ITD model: ITD = (a / c) * (theta + sin(theta))
  // Positive ITD = source is to the right -> left ear delayed; Negative = source to the left -> right ear delayed
  const haasItdMs = Number(
    (((HEAD_RADIUS_M / SPEED_OF_SOUND_MPS) * (clampedAzimuth + Math.sin(clampedAzimuth))) * 1000).toFixed(3)
  );
  const stereoPan = Number(Math.max(-0.92, Math.min(0.92, dx / Math.max(1.2, horizDist))).toFixed(3));

  // Trace first-order rays to obtain exact earliest reflection time (Haas precedence gap)
  const rays = traceAcousticRays(source, micPos, roomDims, roomConfig.wallAbsorption);
  let earliestReflectionMs = directDelayMs + metrics.earlyReflectionMs;
  for (const r of rays) {
    if (r.order === 1 && r.delayMs > directDelayMs + 0.05 && r.delayMs < earliestReflectionMs) {
      earliestReflectionMs = r.delayMs;
    }
  }
  const haasDeltaMs = Number(Math.max(0.2, earliestReflectionMs - directDelayMs).toFixed(1));

  const haasZone: SpatialAcousticProbe['haasZone'] =
    haasDeltaMs < 1.2 ? 'comb_filter' : haasDeltaMs <= 35 ? 'haas_fusion' : 'discrete_echo';

  const occlusion = computeSegmentOcclusion(source, micPos, activeOccluder);
  const standingWaves = computeStandingWaveModes(roomDims, micPos, roomConfig.wallAbsorption);
  const dominantStandingWave = standingWaves[0];

  // Direct-to-Reverberant ratio (dB): 20*log10(Dc / r) + occlusion drop
  const drRatioDb = Number(
    Math.max(
      -24,
      Math.min(18, 20 * Math.log10(Math.max(0.2, metrics.criticalDistanceM) / directDistanceM) + occlusion.attenuationDb)
    ).toFixed(1)
  );

  return {
    micPosition: {
      x: Number(micPos.x.toFixed(2)),
      y: Number(micPos.y.toFixed(2)),
      z: Number(micPos.z.toFixed(2)),
    },
    directDistanceM: Number(directDistanceM.toFixed(2)),
    directDelayMs: Number(directDelayMs.toFixed(2)),
    haasItdMs,
    haasDeltaMs,
    haasZone,
    stereoPan,
    occlusionFactor: occlusion.occlusionFactor,
    occlusionCutoffHz: occlusion.cutoffHz,
    occlusionAttenuationDb: occlusion.attenuationDb,
    standingWaves,
    dominantStandingWave,
    drRatioDb,
  };
}

function createSeededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Synthesizes a spatially-resolved 48 kHz Stereo Room Impulse Response at the exact
 * 3D measurement microphone coordinate, encoding:
 * - True direct arrival with binaural Haas ITD/ILD and acoustic gobo occlusion low-pass diffraction
 * - Exact 1st- and 2nd-order image-source reflections from source -> walls -> L/R mic capsules
 * - Standing-wave eigenmode coloration weighted by Psi(micPos)
 * - Frequency-dependent diffuse Eyring late reverberation tail
 */
export function generateSpatialRoomImpulseResponse(
  roomConfig: RoomAcousticConfig,
  sourcePos: Vec3,
  micPos: Vec3,
  occluder?: AcousticOccluderBox,
  sampleRate = 48000
): ImpulseResponseData {
  const metrics = computeRoomAcousticMetrics(roomConfig);
  const roomSpec = ROOM_MATERIALS[roomConfig.materialId];
  const dims = metrics.dimensions;
  const activeOccluder = occluder ?? getRoomAcousticOccluder(dims);
  const probe = computeSpatialAcousticProbe(sourcePos, micPos, dims, roomConfig, activeOccluder);

  const rt60 = metrics.rt60Seconds;
  const durationSec = Math.max(0.35, Math.min(4.2, rt60 * 1.15));
  const length = Math.max(2048, Math.floor(durationSec * sampleRate));

  const left = new Float32Array(length);
  const right = new Float32Array(length);

  const seed =
    Math.round((micPos.x + 10) * 100) * 73856093 ^
    Math.round((micPos.y + 10) * 100) * 19349663 ^
    Math.round((micPos.z + 10) * 100) * 83492791 ^
    Math.round(roomConfig.wallAbsorption * 1000) * 2654435761;
  const rand = createSeededRandom(seed);

  // Stereo capsule positions (ORTF-like 18cm horizontal spacing around micPos)
  const capL: Vec3 = { x: micPos.x - HEAD_RADIUS_M, y: micPos.y, z: micPos.z };
  const capR: Vec3 = { x: micPos.x + HEAD_RADIUS_M, y: micPos.y, z: micPos.z };

  const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const directDistL = Math.max(0.3, dist(sourcePos, capL));
  const directDistR = Math.max(0.3, dist(sourcePos, capR));
  const minDirectDist = Math.min(directDistL, directDistR);

  // Place earliest arrival near sample 24 (0.5 ms lead-in) so DAW/convolver latency is ultra-tight
  const leadSamples = 24;
  const directSampleL = Math.min(
    length - 16,
    leadSamples + Math.round(((directDistL - minDirectDist) / SPEED_OF_SOUND_MPS) * sampleRate)
  );
  const directSampleR = Math.min(
    length - 16,
    leadSamples + Math.round(((directDistR - minDirectDist) / SPEED_OF_SOUND_MPS) * sampleRate)
  );

  // Direct impulse energy attenuated by distance + occlusion
  const occLinear = Math.pow(10, probe.occlusionAttenuationDb / 20);
  const baseDirectAmp = (1.0 / Math.max(0.75, probe.directDistanceM * 0.65)) * occLinear;
  const panRad = ((probe.stereoPan + 1) * Math.PI) / 4;
  const directGainL = baseDirectAmp * Math.cos(panRad) * 1.15;
  const directGainR = baseDirectAmp * Math.sin(panRad) * 1.15;

  // Apply occlusion diffraction smoothing kernel to direct impulse when occluded
  if (probe.occlusionFactor > 0.05) {
    const kernelLen = Math.min(18, Math.max(3, Math.round(3 + probe.occlusionFactor * 14)));
    const alpha = Math.exp((-2 * Math.PI * probe.occlusionCutoffHz) / sampleRate);
    let norm = 0;
    const weights: number[] = [];
    for (let k = 0; k < kernelLen; k++) {
      const w = (1 - alpha) * Math.pow(alpha, k);
      weights.push(w);
      norm += w;
    }
    for (let k = 0; k < kernelLen; k++) {
      const wk = weights[k] / Math.max(1e-6, norm);
      if (directSampleL + k < length) left[directSampleL + k] += directGainL * wk;
      if (directSampleR + k < length) right[directSampleR + k] += directGainR * wk;
    }
  } else {
    left[directSampleL] += directGainL;
    right[directSampleR] += directGainR;
  }

  // 1st- and 2nd-order image-source reflections computed at exact mic capsule positions
  const halfW = dims.width * 0.5;
  const halfD = dims.depth * 0.5;
  const reflectivity = Math.sqrt(Math.max(0.03, 1 - metrics.meanAbsorption));

  const images: Array<{ pos: Vec3; order: number }> = [
    // 1st-order walls + floor + ceiling
    { pos: { x: -2 * halfW - sourcePos.x, y: sourcePos.y, z: sourcePos.z }, order: 1 },
    { pos: { x: 2 * halfW - sourcePos.x, y: sourcePos.y, z: sourcePos.z }, order: 1 },
    { pos: { x: sourcePos.x, y: sourcePos.y, z: -2 * halfD - sourcePos.z }, order: 1 },
    { pos: { x: sourcePos.x, y: sourcePos.y, z: 2 * halfD - sourcePos.z }, order: 1 },
    { pos: { x: sourcePos.x, y: 2 * dims.height - sourcePos.y, z: sourcePos.z }, order: 1 },
    { pos: { x: sourcePos.x, y: -sourcePos.y, z: sourcePos.z }, order: 1 },
    // 2nd-order corner reflections
    { pos: { x: -2 * halfW - sourcePos.x, y: sourcePos.y, z: -2 * halfD - sourcePos.z }, order: 2 },
    { pos: { x: 2 * halfW - sourcePos.x, y: sourcePos.y, z: -2 * halfD - sourcePos.z }, order: 2 },
    { pos: { x: -2 * halfW - sourcePos.x, y: sourcePos.y, z: 2 * halfD - sourcePos.z }, order: 2 },
    { pos: { x: 2 * halfW - sourcePos.x, y: sourcePos.y, z: 2 * halfD - sourcePos.z }, order: 2 },
    { pos: { x: -2 * halfW - sourcePos.x, y: 2 * dims.height - sourcePos.y, z: sourcePos.z }, order: 2 },
    { pos: { x: 2 * halfW - sourcePos.x, y: 2 * dims.height - sourcePos.y, z: sourcePos.z }, order: 2 },
  ];

  for (const img of images) {
    const dL = dist(img.pos, capL);
    const dR = dist(img.pos, capR);
    const relSampleL = leadSamples + Math.round(((dL - minDirectDist) / SPEED_OF_SOUND_MPS) * sampleRate);
    const relSampleR = leadSamples + Math.round(((dR - minDirectDist) / SPEED_OF_SOUND_MPS) * sampleRate);

    const sign = rand() > 0.5 ? 1 : -1;
    const baseAmp = (Math.pow(reflectivity, img.order) * 0.92) / Math.max(0.85, ((dL + dR) * 0.5) * 0.42);
    const smear = roomSpec.diffusion * 0.32;

    if (relSampleL >= 0 && relSampleL < length - 2) {
      left[relSampleL] += baseAmp * sign;
      left[relSampleL + 1] += baseAmp * sign * smear;
    }
    if (relSampleR >= 0 && relSampleR < length - 2) {
      right[relSampleR] += baseAmp * sign;
      right[relSampleR + 1] -= baseAmp * sign * smear;
    }
  }

  // Standing-wave low-frequency room eigenmode decay signature weighted by spatial Psi(micPos)
  const modeLen = Math.min(length, Math.floor(Math.min(1.1, rt60 * 0.8) * sampleRate));
  for (const mode of probe.standingWaves) {
    if (mode.gainDb <= 0.2) continue;
    const modeAmp = Math.min(0.18, (mode.gainDb / 10) * 0.14 * reflectivity);
    const omega = (2 * Math.PI * mode.frequencyHz) / sampleRate;
    const modeDecay = 5.2 / Math.max(0.18, rt60);
    const phaseR = (probe.haasItdMs / 1000) * 2 * Math.PI * mode.frequencyHz;

    for (let i = leadSamples; i < modeLen; i++) {
      const t = (i - leadSamples) / sampleRate;
      const env = Math.exp(-modeDecay * t) * Math.min(1, t / 0.012);
      left[i] += Math.sin(omega * (i - leadSamples)) * env * modeAmp;
      right[i] += Math.sin(omega * (i - leadSamples) + phaseR) * env * modeAmp;
    }
  }

  // Diffuse Eyring late reverberation tail with material-dependent HF air/wall damping
  const decayRate = 6.907755 / Math.max(0.09, rt60);
  const highDamping = Math.min(
    0.92,
    Math.max(0.08, roomSpec.bandAbsorption.high * 0.55 + roomConfig.wallAbsorption * 0.45)
  );
  const startLateSample = Math.min(
    length - 1,
    Math.max(leadSamples + 48, leadSamples + Math.floor((probe.haasDeltaMs * 0.9 * sampleRate) / 1000))
  );

  let lpL = 0;
  let lpR = 0;
  const lateGain = 0.36 * reflectivity;

  for (let i = startLateSample; i < length; i++) {
    const t = (i - leadSamples) / sampleRate;
    const progress = (i - startLateSample) / Math.max(1, length - startLateSample);
    const onset = Math.min(1, (i - startLateSample) / (sampleRate * 0.022));
    const env = Math.exp(-decayRate * t) * onset;

    const nL = (rand() + rand() - 1) * env * lateGain;
    const nR = (rand() + rand() - 1) * env * lateGain;

    const lpCoeff = Math.min(0.95, highDamping * (0.35 + 0.65 * progress));
    lpL = lpL * lpCoeff + nL * (1 - lpCoeff);
    lpR = lpR * lpCoeff + nR * (1 - lpCoeff);

    left[i] += lpL;
    right[i] += lpR;
  }

  // Normalize stereo IR consistently to -1.5 dBFS peak headroom for DAW / game engine import
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const a = Math.abs(left[i]);
    const b = Math.abs(right[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  const normScale = peak > 1e-5 ? 0.84 / peak : 1;
  for (let i = 0; i < length; i++) {
    left[i] *= normScale;
    right[i] *= normScale;
  }

  // 128-bin normalized energy envelope for live studio IR display
  const previewBins = 128;
  const envelopePreview = new Float32Array(previewBins);
  const binSize = Math.max(1, Math.floor(length / previewBins));
  for (let b = 0; b < previewBins; b++) {
    let maxVal = 0;
    const start = b * binSize;
    const end = Math.min(length, start + binSize);
    for (let i = start; i < end; i++) {
      const m = Math.max(Math.abs(left[i]), Math.abs(right[i]));
      if (m > maxVal) maxVal = m;
    }
    envelopePreview[b] = maxVal;
  }

  return {
    left,
    right,
    sampleRate,
    durationSec,
    rt60Seconds: rt60,
    envelopePreview,
  };
}

/**
 * Generates a studio-grade Farina exponential (logarithmic) sine sweep from fStart to fEnd
 * (default 20 Hz -> 20,000 Hz at 48 kHz) with smooth Hann fade-in/out tapers.
 */
export function generateLogSineSweep(
  durationSec = 2.4,
  fStart = 20,
  fEnd = 20000,
  sampleRate = 48000
): Float32Array {
  const safeDur = Math.max(0.5, Math.min(8.0, durationSec));
  const length = Math.floor(safeDur * sampleRate);
  const out = new Float32Array(length);

  const lnRatio = Math.log(fEnd / fStart);
  const K = (2 * Math.PI * fStart * safeDur) / lnRatio;
  const fadeInSamples = Math.min(Math.floor(length * 0.08), Math.floor(sampleRate * 0.03));
  const fadeOutSamples = Math.min(Math.floor(length * 0.08), Math.floor(sampleRate * 0.04));

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const phase = K * (Math.exp((t / safeDur) * lnRatio) - 1);

    let win = 1.0;
    if (i < fadeInSamples) {
      win = 0.5 * (1 - Math.cos((Math.PI * i) / fadeInSamples));
    } else if (i >= length - fadeOutSamples) {
      const rem = length - 1 - i;
      win = 0.5 * (1 - Math.cos((Math.PI * rem) / fadeOutSamples));
    }

    out[i] = Math.sin(phase) * win * 0.55;
  }

  return out;
}

/**
 * Encodes stereo Float32Audio buffers into a standards-compliant 24-bit PCM stereo RIFF .WAV file
 * at 48 kHz (2 channels, 3 bytes/sample little-endian signed int, 288,000 bytes/sec).
 */
export function encodeStereoWav24Bit(
  left: Float32Array,
  right: Float32Array,
  sampleRate = 48000
): ArrayBuffer {
  const numFrames = Math.min(left.length, right.length);
  const numChannels = 2;
  const bitsPerSample = 24;
  const bytesPerSample = 3;
  const blockAlign = numChannels * bytesPerSample; // 6 bytes
  const byteRate = sampleRate * blockAlign;        // 288,000 B/s @ 48kHz
  const dataSize = numFrames * blockAlign;
  const totalSize = 44 + dataSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      bytes[offset + i] = text.charCodeAt(i);
    }
  };

  // RIFF Header
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');

  // fmt Subchunk (PCM = 1)
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data Subchunk
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  // Pack interleaved 24-bit signed little-endian PCM samples
  let offset = 44;
  const maxPos = 8388607;  //  2^23 - 1
  const minNeg = -8388608; // -2^23

  for (let i = 0; i < numFrames; i++) {
    const lClamped = Math.max(-1, Math.min(1, left[i]));
    const rClamped = Math.max(-1, Math.min(1, right[i]));

    const lInt = Math.max(minNeg, Math.min(maxPos, Math.round(lClamped * maxPos)));
    const rInt = Math.max(minNeg, Math.min(maxPos, Math.round(rClamped * maxPos)));

    bytes[offset++] = lInt & 0xff;
    bytes[offset++] = (lInt >> 8) & 0xff;
    bytes[offset++] = (lInt >> 16) & 0xff;

    bytes[offset++] = rInt & 0xff;
    bytes[offset++] = (rInt >> 8) & 0xff;
    bytes[offset++] = (rInt >> 16) & 0xff;
  }

  return buffer;
}
