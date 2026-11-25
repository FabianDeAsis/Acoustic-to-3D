import { resolvePbrMaterialSpec, ROOM_MATERIALS } from './materials';
import { computeRoomAcousticMetrics, SPEED_OF_SOUND_MPS } from './physics';
import type {
  ModalPartial,
  ObjectPhysicsConfig,
  PbrMaterialSpec,
  RoomAcousticConfig,
} from './types';

/**
 * Computes the real-time modal filter bank (frequencies, gains, Q factors, decay ms)
 * directly from PBR physical material properties (supports built-in 8-mode and AI 12-mode specs).
 *
 * Physics scaling:
 * - Fundamental frequency scales inversely with cube-root of mass (f ~ m^-1/3)
 *   and rises with square-root of hardness (stiffness / Young's modulus proxy).
 * - Surface roughness damps ultra-high modal Q slightly while increasing
 *   broadband micro-impact excitation.
 */
export function computeModalBank(
  config: ObjectPhysicsConfig,
  materialSpec?: PbrMaterialSpec
): ModalPartial[] {
  const spec = materialSpec ?? resolvePbrMaterialSpec(config.materialId);
  const clampedMass = Math.max(0.2, Math.min(25, config.massKg));
  const clampedHardness = Math.max(0.1, Math.min(1.0, config.hardness));
  const clampedRoughness = Math.max(0.02, Math.min(1.0, config.roughness));

  // Mass & stiffness scaling relative to material reference
  const massFactor = Math.pow(spec.defaultMassKg / clampedMass, 0.33);
  const stiffnessFactor = 0.65 + 0.55 * Math.sqrt(clampedHardness / Math.max(0.15, spec.defaultHardness));

  // Shape subtly shifts modal spacing; imported 3D meshes scale fundamental by (V_ref / V_approx)^(1/3)
  const shapePitchFactor =
    config.shapeId === 'imported_mesh' &&
    typeof config.customVolumePitchScale === 'number' &&
    Number.isFinite(config.customVolumePitchScale)
      ? Math.max(0.32, Math.min(2.65, config.customVolumePitchScale))
      : config.shapeId === 'composite_orb'
      ? 1.12
      : config.shapeId === 'acoustic_cylinder'
      ? 1.04
      : 0.96;

  const fundamentalHz = spec.baseFundamentalHz * massFactor * stiffnessFactor * shapePitchFactor;
  const maxAudibleHz = 18500;

  return spec.modes.map((mode, index) => {
    const rawFreq = fundamentalHz * mode.ratio;
    const frequencyHz = Math.max(42, Math.min(maxAudibleHz, rawFreq));

    // Higher roughness slightly broadens Q and dampens high partials
    const roughnessDamping = 1 - clampedRoughness * 0.28 * (index / spec.modes.length);
    const hardnessResonance = 0.72 + clampedHardness * 0.42;
    const qFactor = Math.max(5, Math.min(340, mode.qFactor * roughnessDamping * hardnessResonance));

    // Modal decay time T60_i = 2.2 * Q / f (in seconds), clamped for musical stability
    const baseDecaySec = (2.15 * qFactor) / Math.max(60, frequencyHz);
    const decayMs = Math.max(18, Math.min(3200, baseDecaySec * 1000 * mode.decayWeight));

    // Roll off partials near Nyquist to prevent aliasing harshness
    const nyquistTaper = frequencyHz > 14000 ? Math.max(0.2, 1 - (frequencyHz - 14000) / 5500) : 1;
    const gain = Math.max(0.03, Math.min(1.0, mode.amplitude * nyquistTaper));

    return {
      index,
      frequencyHz: Number(frequencyHz.toFixed(1)),
      gain: Number(gain.toFixed(3)),
      qFactor: Number(qFactor.toFixed(1)),
      decayMs: Number(decayMs.toFixed(1)),
    };
  });
}

export interface ImpulseResponseData {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  durationSec: number;
  rt60Seconds: number;
  envelopePreview: Float32Array; // 128-point normalized energy envelope for UI IR graph
}

/**
 * Deterministic PRNG (Mulberry32) so Impulse Response synthesis is repeatable & testable.
 */
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
 * Generates a physically-modeled stereo Room Impulse Response (48kHz) combining:
 * 1. Exact geometric early reflections (1st & 2nd order image-source taps with stereo panning)
 * 2. Frequency-dependent late diffuse reverb tail shaped by wall absorption and Eyring RT60.
 */
export function generateRoomImpulseResponse(
  roomConfig: RoomAcousticConfig,
  sampleRate = 48000
): ImpulseResponseData {
  const metrics = computeRoomAcousticMetrics(roomConfig);
  const roomSpec = ROOM_MATERIALS[roomConfig.materialId];
  const { width, height, depth } = metrics.dimensions;
  const rt60 = metrics.rt60Seconds;

  // Tail duration covers full -60dB decay plus safety margin, bounded for low memory/latency
  const durationSec = Math.max(0.28, Math.min(4.2, rt60 * 1.15));
  const length = Math.max(1024, Math.floor(durationSec * sampleRate));

  const left = new Float32Array(length);
  const right = new Float32Array(length);

  const seed =
    Math.round(width * 100) * 73856093 ^
    Math.round(height * 100) * 19349663 ^
    Math.round(depth * 100) * 83492791 ^
    Math.round(roomConfig.wallAbsorption * 1000) * 2654435761;
  const rand = createSeededRandom(seed);

  const reflectivity = Math.sqrt(Math.max(0.03, 1 - metrics.meanAbsorption));

  // 1. Geometric Early Reflections (1st & 2nd order axial/tangential taps)
  const earlyTapDistances: Array<{ distM: number; pan: number; order: number }> = [
    { distM: width * 0.45, pan: -0.75, order: 1 },
    { distM: width * 0.55, pan: 0.72, order: 1 },
    { distM: depth * 0.52, pan: -0.22, order: 1 },
    { distM: depth * 0.64, pan: 0.25, order: 1 },
    { distM: height * 0.88, pan: 0.04, order: 1 },
    { distM: Math.hypot(width, depth) * 0.58, pan: -0.62, order: 2 },
    { distM: Math.hypot(width, depth) * 0.63, pan: 0.64, order: 2 },
    { distM: Math.hypot(width, height) * 0.75, pan: -0.45, order: 2 },
    { distM: Math.hypot(depth, height) * 0.82, pan: 0.48, order: 2 },
    { distM: Math.hypot(width, height, depth) * 0.68, pan: -0.18, order: 2 },
    { distM: Math.hypot(width, height, depth) * 0.76, pan: 0.21, order: 2 },
  ];

  for (const tap of earlyTapDistances) {
    const sampleIdx = Math.min(
      length - 4,
      Math.max(12, Math.floor((tap.distM / SPEED_OF_SOUND_MPS) * sampleRate))
    );
    const amp = (Math.pow(reflectivity, tap.order) * 0.85) / Math.max(1.0, tap.distM * 0.35);
    const sign = rand() > 0.5 ? 1 : -1;
    const gainL = Math.cos(((tap.pan + 1) * Math.PI) / 4) * amp * sign;
    const gainR = Math.sin(((tap.pan + 1) * Math.PI) / 4) * amp * sign;

    left[sampleIdx] += gainL;
    right[sampleIdx] += gainR;
    // Short micro-diffusion smear for non-specular walls
    const smear = roomSpec.diffusion * 0.35;
    left[sampleIdx + 1] += gainL * smear;
    right[sampleIdx + 1] -= gainR * smear;
  }

  // 2. Late Diffuse Reverberation Tail with frequency-dependent damping
  // High frequencies decay faster when wall absorption / high-band absorption is high
  const decayRate = 6.907755 / Math.max(0.09, rt60); // ln(1000) / RT60 -> -60 dB at t = RT60
  const highDamping = Math.min(
    0.92,
    Math.max(0.08, roomSpec.bandAbsorption.high * 0.55 + roomConfig.wallAbsorption * 0.45)
  );
  const startLateSample = Math.min(
    length - 1,
    Math.max(64, Math.floor((metrics.earlyReflectionMs * 0.65 * sampleRate) / 1000))
  );

  // One-pole low-pass state per channel for natural air & wall HF absorption
  let lpL = 0;
  let lpR = 0;
  const lateGain = 0.42 * reflectivity;

  for (let i = startLateSample; i < length; i++) {
    const t = i / sampleRate;
    const progress = (i - startLateSample) / Math.max(1, length - startLateSample);
    // Smooth fade-in of diffuse density so early reflections stay crisp
    const onset = Math.min(1, (i - startLateSample) / (sampleRate * 0.025));
    const env = Math.exp(-decayRate * t) * onset;

    // White Gaussian-like noise via sum of 2 uniforms
    const nL = (rand() + rand() - 1) * env * lateGain;
    const nR = (rand() + rand() - 1) * env * lateGain;

    // Dynamic lowpass coefficient increases over time (air + porous wall absorption)
    const lpCoeff = Math.min(0.95, highDamping * (0.35 + 0.65 * progress));
    lpL = lpL * lpCoeff + nL * (1 - lpCoeff);
    lpR = lpR * lpCoeff + nR * (1 - lpCoeff);

    left[i] += lpL;
    right[i] += lpR;
  }

  // Normalize IR energy consistently so Dry/Wet balance stays predictable across rooms
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const a = Math.abs(left[i]);
    const b = Math.abs(right[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  const normScale = peak > 1e-5 ? 0.82 / peak : 1;
  for (let i = 0; i < length; i++) {
    left[i] *= normScale;
    right[i] *= normScale;
  }

  // Compute 128-bin preview envelope for the studio IR display
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
 * Computes Peak dBFS, RMS dBFS, and Momentary LUFS approximation from a time-domain frame.
 */
export function computeAudioLevels(samples: Float32Array): {
  peakDb: number;
  rmsDb: number;
  lufsMomentary: number;
} {
  if (samples.length === 0) {
    return { peakDb: -96, rmsDb: -96, lufsMomentary: -96 };
  }

  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
    sumSq += v * v;
  }

  const rms = Math.sqrt(sumSq / samples.length);
  const toDb = (val: number) => (val <= 1e-5 ? -96 : Math.max(-96, 20 * Math.log10(val)));

  const peakDb = toDb(peak);
  const rmsDb = toDb(rms);
  // K-weighted momentary LUFS approximation (-0.691 dB ITU-R BS.1770 offset)
  const lufsMomentary = rms <= 1e-5 ? -96 : Math.max(-96, rmsDb - 0.691);

  return {
    peakDb: Number(peakDb.toFixed(1)),
    rmsDb: Number(rmsDb.toFixed(1)),
    lufsMomentary: Number(lufsMomentary.toFixed(1)),
  };
}
