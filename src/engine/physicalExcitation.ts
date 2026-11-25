import type { ModalPartial, PhysicalExcitationModeId, RoomMaterialId } from './types';

export interface PhysicalExcitationModeSpec {
  id: PhysicalExcitationModeId;
  shortLabel: string;
  name: string;
  description: string;
}

export const PHYSICAL_EXCITATION_MODES: PhysicalExcitationModeSpec[] = [
  {
    id: 'dual_hertz',
    shortLabel: 'Dual Hertz',
    name: 'Contacto Sólido Dual (Hertz)',
    description:
      'Excita simultáneamente los modos del objeto y del suelo/pared según su dureza elástica relativa.',
  },
  {
    id: 'elastic_cavity',
    shortLabel: 'Cavidad 850Hz',
    name: 'Cavidad Elástica (Pelota)',
    description:
      'Resonancia de cavidad interna a 850 Hz con envolvente ascendente de 20 ms por compresión de aire.',
  },
  {
    id: 'stochastic_fracture',
    shortLabel: 'Fractura Poisson',
    name: 'Fractura Estocástica (Ramas y Hojas)',
    description:
      'Proceso de Poisson en AudioWorklet a 48 kHz disparando micro-impulsos agudos según velocidad.',
  },
  {
    id: 'friedlander_shockwave',
    shortLabel: 'Choque Friedlander',
    name: 'Onda de Choque (Friedlander)',
    description:
      'Pulso no lineal de Friedlander con depresión negativa, saturación suave y paso-bajo por distancia.',
  },
];

export interface DualHertzPartition {
  objectHardness: number;
  surfaceHardness: number;
  effectiveStiffness: number;
  objectEnergyShare: number;
  surfaceEnergyShare: number;
  hertzContactMs: number;
  surfaceName: string;
}

const SURFACE_ACOUSTIC_SPECS: Record<
  RoomMaterialId,
  {
    name: string;
    hardness: number;
    baseFundamentalHz: number;
    modes: Array<{ ratio: number; gain: number; qFactor: number; decayMs: number }>;
  }
> = {
  concrete: {
    name: 'Concreto',
    hardness: 0.84,
    baseFundamentalHz: 118,
    modes: [
      { ratio: 1.0, gain: 0.92, qFactor: 14, decayMs: 75 },
      { ratio: 1.78, gain: 0.78, qFactor: 16, decayMs: 58 },
      { ratio: 2.84, gain: 0.62, qFactor: 18, decayMs: 44 },
      { ratio: 4.35, gain: 0.45, qFactor: 15, decayMs: 32 },
      { ratio: 6.4, gain: 0.3, qFactor: 12, decayMs: 24 },
      { ratio: 9.2, gain: 0.2, qFactor: 10, decayMs: 18 },
    ],
  },
  wood: {
    name: 'Madera',
    hardness: 0.5,
    baseFundamentalHz: 162,
    modes: [
      { ratio: 1.0, gain: 1.0, qFactor: 26, decayMs: 165 },
      { ratio: 1.56, gain: 0.84, qFactor: 28, decayMs: 130 },
      { ratio: 2.38, gain: 0.66, qFactor: 24, decayMs: 96 },
      { ratio: 3.42, gain: 0.48, qFactor: 20, decayMs: 72 },
      { ratio: 5.1, gain: 0.31, qFactor: 17, decayMs: 52 },
      { ratio: 7.3, gain: 0.18, qFactor: 14, decayMs: 36 },
    ],
  },
  glass: {
    name: 'Vidrio',
    hardness: 0.94,
    baseFundamentalHz: 420,
    modes: [
      { ratio: 1.0, gain: 0.96, qFactor: 95, decayMs: 420 },
      { ratio: 1.82, gain: 0.82, qFactor: 110, decayMs: 340 },
      { ratio: 2.95, gain: 0.68, qFactor: 105, decayMs: 265 },
      { ratio: 4.48, gain: 0.52, qFactor: 92, decayMs: 195 },
      { ratio: 6.3, gain: 0.36, qFactor: 78, decayMs: 145 },
      { ratio: 8.6, gain: 0.22, qFactor: 64, decayMs: 98 },
    ],
  },
  acoustic_foam: {
    name: 'Panel Acústico',
    hardness: 0.14,
    baseFundamentalHz: 92,
    modes: [
      { ratio: 1.0, gain: 0.65, qFactor: 5, decayMs: 36 },
      { ratio: 1.65, gain: 0.45, qFactor: 5, decayMs: 28 },
      { ratio: 2.5, gain: 0.28, qFactor: 4, decayMs: 22 },
      { ratio: 3.8, gain: 0.16, qFactor: 4, decayMs: 18 },
    ],
  },
};

/**
 * 1. Contacto Sólido Dual (Hertz):
 * Computes reduced Hertzian contact stiffness E* = (E1*E2)/(E1+E2), contact duration tau_H,
 * and acoustic energy partition between the colliding object and impacted floor/wall surface.
 *
 * In Hertzian impact mechanics, the softer/more compliant body experiences larger elastic
 * indentation and absorbs a larger share of structural excitation energy, while combined
 * stiffness sets the contact pulse duration (hard+hard -> ultra-short bright transient).
 */
export function computeDualHertzPartition(
  objectHardness: number,
  roomMaterialId: RoomMaterialId
): DualHertzPartition {
  const hObj = Math.max(0.08, Math.min(1.0, objectHardness));
  const surfSpec = SURFACE_ACOUSTIC_SPECS[roomMaterialId];
  const hSurf = surfSpec.hardness;

  // Map normalized hardness to relative Young's modulus proxy
  const eObj = 0.25 + hObj * hObj * 3.75;
  const eSurf = 0.25 + hSurf * hSurf * 3.75;
  const effectiveStiffness = (eObj * eSurf) / Math.max(1e-4, eObj + eSurf);

  // Relative compliance determines deformation work share; blended with impedance radiation
  const complianceObj = 1 / eObj;
  const complianceSurf = 1 / eSurf;
  const rawObjShare = complianceObj / (complianceObj + complianceSurf);

  // Clamp into [0.22, 0.78] so both bodies remain physically audible in dual resonance
  const objectEnergyShare = Number(Math.max(0.22, Math.min(0.78, 0.5 + (rawObjShare - 0.5) * 0.78)).toFixed(3));
  const surfaceEnergyShare = Number((1 - objectEnergyShare).toFixed(3));

  // Hertz contact duration scales inversely with E*^(2/5): 0.8 ms (glass/steel) .. 12 ms (foam)
  const hertzContactMs = Number(
    Math.max(0.8, Math.min(14.0, 3.8 * Math.pow(effectiveStiffness, -0.4))).toFixed(2)
  );

  return {
    objectHardness: hObj,
    surfaceHardness: hSurf,
    effectiveStiffness: Number(effectiveStiffness.toFixed(3)),
    objectEnergyShare,
    surfaceEnergyShare,
    hertzContactMs,
    surfaceName: surfSpec.name,
  };
}

/**
 * Returns the 6-mode structural modal bank of the impacted floor or wall material.
 * Wall impacts shift pitch slightly upward (~1.16x) relative to a heavier floor slab.
 */
export function computeSurfaceModalBank(
  roomMaterialId: RoomMaterialId,
  isWallImpact = false
): ModalPartial[] {
  const spec = SURFACE_ACOUSTIC_SPECS[roomMaterialId];
  const pitchShift = isWallImpact ? 1.16 : 1.0;

  return spec.modes.map((m, index) => ({
    index,
    frequencyHz: Number((spec.baseFundamentalHz * m.ratio * pitchShift).toFixed(1)),
    gain: m.gain,
    qFactor: m.qFactor,
    decayMs: m.decayMs,
  }));
}

export interface ElasticCavityParams {
  baseCavityHz: number;
  peakCavityHz: number;
  overtoneHz: number;
  overtonePeakHz: number;
  membraneThumpHz: number;
  pitchEnvelopeMs: number;
  decayMs: number;
  cavityGain: number;
}

/**
 * 2. Cavidad Elástica (Pelota):
 * Computes internal spherical air-cavity resonance anchored at 850 Hz with an upward
 * 20 ms pitch envelope proportional to collision force (simulating internal air compression
 * and elastic shell rebound).
 */
export function computeElasticCavityParams(
  impactVelocityMps: number,
  elasticity: number,
  massKg: number
): ElasticCavityParams {
  const forceNorm = Math.max(0.08, Math.min(1.0, impactVelocityMps / 7.2));
  const clampedElast = Math.max(0.08, Math.min(0.92, elasticity));
  const massFactor = Math.max(0.88, Math.min(1.12, Math.pow(4.2 / Math.max(0.4, massKg), 0.12)));

  // Anchored at 850 Hz per acoustic hollow-ball cavity mode
  const baseCavityHz = Number((850 * massFactor).toFixed(1));
  // Upward 20 ms pitch bend proportional to impact force (+4% .. +22%)
  const upwardShiftRatio = 1 + forceNorm * (0.1 + clampedElast * 0.12);
  const peakCavityHz = Number((baseCavityHz * upwardShiftRatio).toFixed(1));

  const overtoneHz = Number((baseCavityHz * 1.79).toFixed(1));
  const overtonePeakHz = Number((overtoneHz * upwardShiftRatio).toFixed(1));
  const membraneThumpHz = Number((138 * massFactor).toFixed(1));

  const decayMs = Number((110 + clampedElast * 175).toFixed(1));
  const cavityGain = Number((0.42 + forceNorm * 0.45 * (0.65 + clampedElast * 0.45)).toFixed(3));

  return {
    baseCavityHz,
    peakCavityHz,
    overtoneHz,
    overtonePeakHz,
    membraneThumpHz,
    pitchEnvelopeMs: 20,
    decayMs,
    cavityGain,
  };
}

/**
 * 3. Fractura Estocástica / Granular (Ramas y Hojas):
 * Computes inhomogeneous Poisson event rate lambda (impulses / second) from tangential
 * drag velocity, downward mass pressure, and local PBR roughness.
 */
export function computePoissonLambda(
  velocityMps: number,
  pressureKg: number,
  localRoughness: number
): number {
  const speed = Math.max(0, velocityMps);
  if (speed < 0.02) return 0;

  const speedNorm = Math.min(1.5, speed / 2.2);
  const pressureFactor = Math.max(0.45, Math.min(2.1, 0.55 + Math.sqrt(Math.max(0.2, pressureKg)) * 0.38));
  const roughFactor = 0.45 + Math.max(0.02, Math.min(1.0, localRoughness)) * 1.35;

  // 25 .. 2200 micro-impulses per second
  const lambda = Math.min(2200, Math.max(18, speedNorm * 680 * pressureFactor * roughFactor));
  return Number(lambda.toFixed(1));
}

/**
 * Pure deterministic Poisson-process stochastic fracture generator (branches/twigs/leaves)
 * usable both for unit testing and fallback continuous buffers at 48 kHz.
 */
export function generatePoissonFractureBuffer(options: {
  durationSec: number;
  lambdaHz: number;
  roughness: number;
  sampleRate?: number;
  seed?: number;
}): { samples: Float32Array; impulseCount: number } {
  const sampleRate = options.sampleRate ?? 48000;
  const length = Math.max(64, Math.floor(options.durationSec * sampleRate));
  const samples = new Float32Array(length);
  const lambda = Math.max(0, options.lambdaHz);
  if (lambda <= 0.01) {
    return { samples, impulseCount: 0 };
  }

  let rng = (options.seed ?? 0x9e3779b9) >>> 0;
  const nextRand = () => {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    return (rng >>> 0) / 4294967296;
  };

  const pTrigger = Math.min(0.22, lambda / sampleRate);
  const rough = Math.max(0.05, Math.min(1.0, options.roughness));
  let impulseCount = 0;

  // Lightweight 2-pole resonant micro-crack slots
  interface MicroCrack {
    active: boolean;
    phase: number;
    omega: number;
    amp: number;
    decay: number;
    noiseMix: number;
  }
  const voices: MicroCrack[] = Array.from({ length: 24 }, () => ({
    active: false,
    phase: 0,
    omega: 0,
    amp: 0,
    decay: 0.99,
    noiseMix: 0.5,
  }));
  let nextSlot = 0;

  for (let i = 0; i < length; i++) {
    if (nextRand() < pTrigger) {
      impulseCount += 1;
      const v = voices[nextSlot];
      nextSlot = (nextSlot + 1) % voices.length;
      const isTwigSnap = nextRand() < 0.24 + rough * 0.22;
      // High-frequency crisp snaps (2.1..9.5 kHz) + dry leaf rustle grains (4.5..13.5 kHz)
      const freqHz = isTwigSnap
        ? 1900 + nextRand() * 5200
        : 4200 + nextRand() * 8800;
      const tauSec = isTwigSnap ? 0.0022 + nextRand() * 0.0055 : 0.0007 + nextRand() * 0.002;
      v.active = true;
      v.phase = 0;
      v.omega = (2 * Math.PI * freqHz) / sampleRate;
      v.amp = (isTwigSnap ? 0.42 : 0.22) * (0.45 + nextRand() * 0.75);
      v.decay = Math.exp(-1 / (tauSec * sampleRate));
      v.noiseMix = isTwigSnap ? 0.35 : 0.78;
    }

    let acc = 0;
    for (let k = 0; k < voices.length; k++) {
      const v = voices[k];
      if (!v.active) continue;
      const tonal = Math.sin(v.phase);
      const grainNoise = nextRand() * 2 - 1;
      acc += v.amp * (tonal * (1 - v.noiseMix) + grainNoise * v.noiseMix);
      v.phase += v.omega;
      v.amp *= v.decay;
      if (v.amp < 0.0005) {
        v.active = false;
      }
    }
    samples[i] = Math.tanh(acc * 1.15);
  }

  return { samples, impulseCount };
}

/**
 * Inline ES module source code for the 48 kHz Web Audio `PoissonFractureProcessor` AudioWorklet.
 * Runs exclusively on the real-time audio rendering thread with zero garbage collection.
 */
export const POISSON_FRACTURE_WORKLET_CODE = `
class PoissonFractureProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'lambda', defaultValue: 0, minValue: 0, maxValue: 2600, automationRate: 'k-rate' },
      { name: 'roughness', defaultValue: 0.5, minValue: 0.02, maxValue: 1.0, automationRate: 'k-rate' },
      { name: 'gain', defaultValue: 0, minValue: 0, maxValue: 2.0, automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    this.rng = 0x243f6a88;
    this.maxVoices = 24;
    this.active = new Uint8Array(this.maxVoices);
    this.phase = new Float32Array(this.maxVoices);
    this.omega = new Float32Array(this.maxVoices);
    this.amp = new Float32Array(this.maxVoices);
    this.decay = new Float32Array(this.maxVoices);
    this.noiseMix = new Float32Array(this.maxVoices);
    this.slot = 0;
    this.hpPrevX = 0;
    this.hpPrevY = 0;
  }

  nextRand() {
    let x = this.rng | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    return this.rng / 4294967296;
  }

  process(_inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const ch0 = output[0];
    const ch1 = output.length > 1 ? output[1] : null;

    const lambda = parameters.lambda[0];
    const roughness = parameters.roughness[0];
    const outGain = parameters.gain[0];
    const pTrigger = Math.min(0.22, lambda / sampleRate);

    for (let i = 0; i < ch0.length; i++) {
      if (pTrigger > 0.00001 && this.nextRand() < pTrigger) {
        const s = this.slot;
        this.slot = (this.slot + 1) % this.maxVoices;
        const isTwigSnap = this.nextRand() < (0.24 + roughness * 0.24);
        const freqHz = isTwigSnap
          ? 1850 + this.nextRand() * 5400
          : 4400 + this.nextRand() * 9200;
        const tauSec = isTwigSnap
          ? 0.002 + this.nextRand() * 0.0055
          : 0.0006 + this.nextRand() * 0.002;
        this.active[s] = 1;
        this.phase[s] = 0;
        this.omega[s] = (6.28318530718 * freqHz) / sampleRate;
        this.amp[s] = (isTwigSnap ? 0.55 : 0.28) * (0.4 + this.nextRand() * 0.8);
        this.decay[s] = Math.exp(-1 / (tauSec * sampleRate));
        this.noiseMix[s] = isTwigSnap ? 0.34 : 0.78;
      }

      let sum = 0;
      for (let v = 0; v < this.maxVoices; v++) {
        if (!this.active[v]) continue;
        const a = this.amp[v];
        const tonal = Math.sin(this.phase[v]);
        const n = this.nextRand() * 2 - 1;
        const nm = this.noiseMix[v];
        sum += a * (tonal * (1 - nm) + n * nm);
        this.phase[v] += this.omega[v];
        const nextAmp = a * this.decay[v];
        this.amp[v] = nextAmp;
        if (nextAmp < 0.0004) this.active[v] = 0;
      }

      // Crisp 1-pole high-pass (~900 Hz) to keep foliage/twig crackles airy & articulate
      const hp = 0.88 * (this.hpPrevY + sum - this.hpPrevX);
      this.hpPrevX = sum;
      this.hpPrevY = hp;

      const sample = Math.tanh(hp * 1.35) * outGain;
      ch0[i] = sample;
      if (ch1) ch1[i] = sample * (0.94 + 0.06 * Math.sin(i * 0.13));
    }

    return true;
  }
}

registerProcessor('poisson-fracture-processor', PoissonFractureProcessor);
`;

export interface FriedlanderShockwaveResult {
  samples: Float32Array;
  sampleRate: number;
  positivePhaseMs: number;
  peakPositive: number;
  minNegative: number;
  distanceCutoffHz: number;
}

/**
 * Computes atmospheric distance-dependent low-pass cutoff (Hz) for nonlinear shockwaves.
 * Near-field blasts preserve sharp supersonic crack (>12 kHz); distant waves lose HF via
 * air absorption and nonlinear shock thickening (~1.2..5 kHz).
 */
export function computeShockwaveDistanceCutoffHz(distanceMeters: number): number {
  const d = Math.max(0.4, Math.min(40, distanceMeters));
  // Exponential atmospheric HF attenuation model
  const cutoff = 1150 + 15800 * Math.exp(-d * 0.32);
  return Math.round(Math.max(850, Math.min(18000, cutoff)));
}

/**
 * 4. Onda de Choque (Friedlander / Explosión):
 * Synthesizes a nonlinear Friedlander blast overpressure waveform:
 *   p(t) = P_s * (1 - t / t_pos) * exp(-b * t / t_pos)
 * featuring an instantaneous Mach shock front (<0.35 ms), positive overpressure phase,
 * authentic negative rarefaction/depression trough (t > t_pos), nonlinear soft saturation,
 * and distance-dependent atmospheric low-pass filtering.
 */
export function generateFriedlanderShockwave(options: {
  distanceMeters: number;
  intensity?: number; // 0.3 .. 1.5
  sampleRate?: number;
  durationSec?: number;
}): FriedlanderShockwaveResult {
  const sampleRate = options.sampleRate ?? 48000;
  const intensity = Math.max(0.3, Math.min(1.5, options.intensity ?? 1.0));
  const dist = Math.max(0.4, options.distanceMeters);
  const durationSec = options.durationSec ?? 0.42;
  const length = Math.max(512, Math.floor(durationSec * sampleRate));
  const samples = new Float32Array(length);

  // Positive phase duration t+ stretches slightly with propagation distance (shock broadening)
  const positivePhaseSec = (0.009 + Math.min(0.022, dist * 0.0022)) * (0.85 + intensity * 0.3);
  const decayParamB = 1.65; // Standard blast waveform parameter controlling negative trough depth
  const riseSec = 0.00028;  // Near-instantaneous 0.28 ms Mach front
  const drive = 1.9 + intensity * 1.4;

  // Deterministic crackle PRNG for supersonic shock-front air turbulence
  let rng = 0x51a7b3c1;
  const nextRand = () => {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    return ((rng >>> 0) / 4294967296) * 2 - 1;
  };

  // One-pole low-pass matched to atmospheric distance cutoff
  const distanceCutoffHz = computeShockwaveDistanceCutoffHz(dist);
  const rc = 1 / (2 * Math.PI * distanceCutoffHz);
  const dt = 1 / sampleRate;
  const lpAlpha = dt / (rc + dt);
  let lpState = 0;

  let peakPositive = 0;
  let minNegative = 0;

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const u = t / positivePhaseSec;

    // Instantaneous rise envelope (0 -> 1 in 0.28 ms)
    const rise = t < riseSec ? t / riseSec : 1.0;

    // Canonical Friedlander pressure wave: positive spike followed by negative depression
    const friedlander = (1 - u) * Math.exp(-decayParamB * u);

    // Sub-bass shock rumble & supersonic crackle localized right behind Mach front
    const crackleEnv = Math.exp(-t / 0.018);
    const rumbleEnv = Math.exp(-t / 0.14);
    const crackle = nextRand() * 0.28 * crackleEnv;
    const subRumble = Math.sin(2 * Math.PI * 52 * t) * 0.16 * rumbleEnv;

    const raw = rise * (friedlander * 1.32 + crackle + subRumble) * intensity;

    // Soft nonlinear saturation (tanh waveshaper with 0.96 peak headroom)
    const saturated = Math.tanh(raw * drive) * 0.96;

    // Distance-dependent atmospheric low-pass filter
    lpState += lpAlpha * (saturated - lpState);

    // Smooth tail taper on final 15 ms to guarantee zero end-click
    const remain = length - 1 - i;
    const tailFade = remain < sampleRate * 0.015 ? remain / (sampleRate * 0.015) : 1.0;
    const out = lpState * tailFade;

    samples[i] = out;
    if (out > peakPositive) peakPositive = out;
    if (out < minNegative) minNegative = out;
  }

  return {
    samples,
    sampleRate,
    positivePhaseMs: Number((positivePhaseSec * 1000).toFixed(2)),
    peakPositive: Number(peakPositive.toFixed(3)),
    minNegative: Number(minNegative.toFixed(3)),
    distanceCutoffHz,
  };
}
