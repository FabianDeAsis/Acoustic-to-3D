import { ROOM_MATERIALS } from './materials';
import {
  computeDualHertzPartition,
  computeShockwaveDistanceCutoffHz,
  computeSurfaceModalBank,
} from './physicalExcitation';
import type {
  DspEngineConfig,
  ModalPartial,
  ObjectPhysicsConfig,
  PbrMaterialSpec,
  RoomAcousticConfig,
  RoomAcousticMetrics,
  SpatialAcousticProbe,
} from './types';

export type RecordingTrackMode = 'mix' | 'dry' | 'wet';

export interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export interface CppPresetExportInput {
  objectConfig: ObjectPhysicsConfig;
  materialSpec: PbrMaterialSpec;
  modalBank: ModalPartial[];
  roomConfig: RoomAcousticConfig;
  roomMetrics: RoomAcousticMetrics;
  dspConfig: DspEngineConfig;
  spatialProbe: SpatialAcousticProbe;
  sampleRate?: number;
}

/**
 * Computes normalized 2nd-order Biquad Bandpass coefficients (constant 0 dB peak gain)
 * using Robert Bristow-Johnson's Audio EQ Cookbook formulas at `sampleRate` (default 48 kHz).
 * Difference equation (Direct Form II Transposed):
 *   y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
 */
export function computeBiquadBandpassCoeffs(
  freqHz: number,
  qFactor: number,
  sampleRate = 48000
): BiquadCoefficients {
  const f = Math.max(20, Math.min(sampleRate * 0.46, freqHz));
  const q = Math.max(0.25, Math.min(400, qFactor));
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * q);

  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * Computes normalized 2nd-order Biquad Peaking EQ coefficients (RBJ Audio EQ Cookbook).
 */
export function computeBiquadPeakingCoeffs(
  freqHz: number,
  qFactor: number,
  gainDb: number,
  sampleRate = 48000
): BiquadCoefficients {
  const f = Math.max(20, Math.min(sampleRate * 0.46, freqHz));
  const q = Math.max(0.25, Math.min(60, qFactor));
  const A = Math.pow(10, Math.max(-24, Math.min(24, gainDb)) / 40);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * q);

  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0,
    b1: (-2 * cosW0) / a0,
    b2: (1 - alpha * A) / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha / A) / a0,
  };
}

/**
 * Computes normalized 2nd-order Biquad Low-Pass coefficients (RBJ Audio EQ Cookbook).
 */
export function computeBiquadLowpassCoeffs(
  cutoffHz: number,
  qFactor = 0.7071,
  sampleRate = 48000
): BiquadCoefficients {
  const f = Math.max(40, Math.min(sampleRate * 0.46, cutoffHz));
  const q = Math.max(0.3, Math.min(20, qFactor));
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * q);

  const a0 = 1 + alpha;
  return {
    b0: ((1 - cosW0) * 0.5) / a0,
    b1: (1 - cosW0) / a0,
    b2: ((1 - cosW0) * 0.5) / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * Evaluates complex magnitude response |H(e^{j*2*pi*f/fs})| of a normalized biquad filter.
 * Used for DSP verification and unit testing.
 */
export function evaluateBiquadMagnitude(
  c: BiquadCoefficients,
  freqHz: number,
  sampleRate = 48000
): number {
  const w = (2 * Math.PI * freqHz) / sampleRate;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);

  const numRe = c.b0 + c.b1 * cos1 + c.b2 * cos2;
  const numIm = -(c.b1 * sin1 + c.b2 * sin2);
  const denRe = 1 + c.a1 * cos1 + c.a2 * cos2;
  const denIm = -(c.a1 * sin1 + c.a2 * sin2);

  const numMag = Math.hypot(numRe, numIm);
  const denMag = Math.max(1e-12, Math.hypot(denRe, denIm));
  return numMag / denMag;
}

/**
 * Concatenates recorded stereo Float32Array chunks into contiguous Left and Right channel buffers.
 */
export function concatStereoChunks(
  leftChunks: Float32Array[],
  rightChunks: Float32Array[]
): { left: Float32Array; right: Float32Array; totalSamples: number; peakLinear: number } {
  const count = Math.min(leftChunks.length, rightChunks.length);
  let totalSamples = 0;
  for (let i = 0; i < count; i++) {
    totalSamples += Math.min(leftChunks[i].length, rightChunks[i].length);
  }

  const left = new Float32Array(totalSamples);
  const right = new Float32Array(totalSamples);
  let offset = 0;
  let peakLinear = 0;

  for (let i = 0; i < count; i++) {
    const lChunk = leftChunks[i];
    const rChunk = rightChunks[i];
    const len = Math.min(lChunk.length, rChunk.length);
    for (let s = 0; s < len; s++) {
      const lv = lChunk[s];
      const rv = rChunk[s];
      left[offset + s] = lv;
      right[offset + s] = rv;
      const absMax = Math.max(Math.abs(lv), Math.abs(rv));
      if (absMax > peakLinear) peakLinear = absMax;
    }
    offset += len;
  }

  return { left, right, totalSamples, peakLinear };
}

/**
 * Inline ES module for a dedicated real-time 48 kHz Stereo PCM Recorder AudioWorklet.
 * Accumulates 2048-sample stereo blocks on the audio thread and transfers ownership via
 * Transferable ArrayBuffers only while armed, guaranteeing zero GC pressure when idle.
 */
export const STEREO_PCM_RECORDER_WORKLET_CODE = `
class StereoPcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.chunkSize = 2048;
    this.leftBuf = new Float32Array(this.chunkSize);
    this.rightBuf = new Float32Array(this.chunkSize);
    this.writeOffset = 0;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'start') {
        this.writeOffset = 0;
        this.recording = true;
      } else if (msg.type === 'stop') {
        if (this.recording && this.writeOffset > 0) {
          const lOut = this.leftBuf.slice(0, this.writeOffset);
          const rOut = this.rightBuf.slice(0, this.writeOffset);
          this.port.postMessage(
            { type: 'chunk', left: lOut, right: rOut },
            [lOut.buffer, rOut.buffer]
          );
        }
        this.recording = false;
        this.writeOffset = 0;
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    // Pass-through silence on output (sink stays muted)
    if (output) {
      for (let ch = 0; ch < output.length; ch++) {
        output[ch].fill(0);
      }
    }

    if (!this.recording || !input || input.length === 0) {
      return true;
    }

    const inL = input[0];
    const inR = input.length > 1 ? input[1] : input[0];
    if (!inL) return true;

    const frames = inL.length;
    for (let i = 0; i < frames; i++) {
      this.leftBuf[this.writeOffset] = inL[i];
      this.rightBuf[this.writeOffset] = inR ? inR[i] : inL[i];
      this.writeOffset += 1;

      if (this.writeOffset >= this.chunkSize) {
        const lSend = this.leftBuf;
        const rSend = this.rightBuf;
        this.leftBuf = new Float32Array(this.chunkSize);
        this.rightBuf = new Float32Array(this.chunkSize);
        this.writeOffset = 0;
        this.port.postMessage(
          { type: 'chunk', left: lSend, right: rSend },
          [lSend.buffer, rSend.buffer]
        );
      }
    }

    return true;
  }
}

registerProcessor('stereo-pcm-recorder-processor', StereoPcmRecorderProcessor);
`;

function escapeCppString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
}

function fmtFloat(value: number, digits = 6): string {
  if (!Number.isFinite(value)) return '0.0f';
  const rounded = Number(value.toFixed(digits));
  const str = rounded.toFixed(digits).replace(/\.?0+$/, '');
  return str.includes('.') ? `${str}f` : `${str}.0f`;
}

function fmtCoeff(value: number): string {
  if (!Number.isFinite(value)) return '0.00000000f';
  return `${value.toFixed(8)}f`;
}

/**
 * Generates a complete, self-contained C++20 `AcousticPreset.h` header file ready for direct
 * integration into native C++20 / OpenGL / Unreal / FMOD / ASIS Engine DSP pipelines.
 */
export function generateCppAcousticPresetHeader(input: CppPresetExportInput): string {
  const {
    objectConfig,
    materialSpec,
    modalBank,
    roomConfig,
    roomMetrics,
    dspConfig,
    spatialProbe,
  } = input;
  const sampleRate = input.sampleRate ?? 48000;
  const roomSpec = ROOM_MATERIALS[roomConfig.materialId];
  const hertz = computeDualHertzPartition(objectConfig.hardness, roomConfig.materialId);
  const surfaceModes = computeSurfaceModalBank(roomConfig.materialId, false);
  const occlusionLp = computeBiquadLowpassCoeffs(spatialProbe.occlusionCutoffHz, 0.72, sampleRate);
  const shockCutoffHz = computeShockwaveDistanceCutoffHz(spatialProbe.directDistanceM);
  const shockLp = computeBiquadLowpassCoeffs(shockCutoffHz, 0.78, sampleRate);
  const neuralFormant = computeBiquadPeakingCoeffs(
    materialSpec.neuralFormantHz,
    1.6,
    4.5 * dspConfig.neuralConditioning,
    sampleRate
  );

  const swModes = spatialProbe.standingWaves.slice(0, 3);
  while (swModes.length < 3) {
    swModes.push({
      label: '(0,0,0)',
      nx: 0,
      ny: 0,
      nz: 0,
      frequencyHz: 80,
      pressure: 0,
      gainDb: 0,
      qFactor: 6,
    });
  }

  const modalEntries = modalBank
    .map((m) => {
      const c = computeBiquadBandpassCoeffs(m.frequencyHz, m.qFactor, sampleRate);
      return `        { ${fmtFloat(m.frequencyHz, 2)}, ${fmtFloat(m.gain, 4)}, ${fmtFloat(m.qFactor, 2)}, ${fmtFloat(m.decayMs, 2)}, { ${fmtCoeff(c.b0)}, ${fmtCoeff(c.b1)}, ${fmtCoeff(c.b2)}, ${fmtCoeff(c.a1)}, ${fmtCoeff(c.a2)} } }`;
    })
    .join(',\n');

  const surfaceEntries = surfaceModes
    .map((m) => {
      const c = computeBiquadBandpassCoeffs(m.frequencyHz, m.qFactor, sampleRate);
      return `        { ${fmtFloat(m.frequencyHz, 2)}, ${fmtFloat(m.gain, 4)}, ${fmtFloat(m.qFactor, 2)}, ${fmtFloat(m.decayMs, 2)}, { ${fmtCoeff(c.b0)}, ${fmtCoeff(c.b1)}, ${fmtCoeff(c.b2)}, ${fmtCoeff(c.a1)}, ${fmtCoeff(c.a2)} } }`;
    })
    .join(',\n');

  const standingWaveEntries = swModes
    .map((sw) => {
      const c = computeBiquadPeakingCoeffs(sw.frequencyHz, sw.qFactor, sw.gainDb, sampleRate);
      return `        { "${escapeCppString(sw.label)}", ${fmtFloat(sw.frequencyHz, 2)}, ${fmtFloat(sw.gainDb, 3)}, ${fmtFloat(sw.qFactor, 2)}, { ${fmtCoeff(c.b0)}, ${fmtCoeff(c.b1)}, ${fmtCoeff(c.b2)}, ${fmtCoeff(c.a1)}, ${fmtCoeff(c.a2)} } }`;
    })
    .join(',\n');

  const generatedIso = new Date().toISOString();

  return `// =============================================================================
// AcousticPreset.h — Acoustic-to-3D Neural Foley & Spatial Engine (C++20)
// Generated: ${generatedIso}
// Sample Rate: ${sampleRate} Hz | Material: ${escapeCppString(materialSpec.name)} | Room: ${escapeCppString(roomSpec.name)}
// =============================================================================
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace acoustic3d::preset {

// Normalized 2nd-order Biquad coefficients (a0 = 1.0f, Direct Form II Transposed)
// y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
struct BiquadCoeffs {
    float b0;
    float b1;
    float b2;
    float a1;
    float a2;
};

struct BiquadState {
    float z1 = 0.0f;
    float z2 = 0.0f;
};

// Zero-allocation real-time Direct Form II Transposed biquad step (48 kHz)
inline constexpr float processBiquadDF2T(float x, const BiquadCoeffs& c, BiquadState& s) noexcept {
    const float y = c.b0 * x + s.z1;
    s.z1 = c.b1 * x - c.a1 * y + s.z2;
    s.z2 = c.b2 * x - c.a2 * y;
    return y;
}

struct ModalResonatorMode {
    float frequencyHz;
    float gain;
    float qFactor;
    float decayMs;
    BiquadCoeffs biquad; // Bandpass (constant 0 dB peak gain) at ${sampleRate} Hz
};

struct StandingWaveFilter {
    std::string_view modeLabel;
    float frequencyHz;
    float gainDb;
    float qFactor;
    BiquadCoeffs biquad; // Peaking EQ at ${sampleRate} Hz
};

struct ObjectPbrPhysics {
    std::string_view materialId;
    std::string_view materialName;
    std::string_view excitationMode;
    float massKg;
    float densityKgM3;
    float roughness;
    float hardness;
    float elasticity;
    float frictionCoeff;
    float volumePitchScale;
    float neuralConditioning;
    float neuralHarmonicDrive;
    float neuralFormantHz;
    float hertzObjectEnergyShare;
    float hertzSurfaceEnergyShare;
    float hertzContactMs;
    BiquadCoeffs neuralFormantBiquad;
};

struct RoomAcousticParams {
    std::string_view materialId;
    std::string_view materialName;
    std::string_view sizePreset;
    float widthM;
    float heightM;
    float depthM;
    float volumeM3;
    float surfaceAreaM2;
    float wallAbsorption;
    float absorptionLow125Hz;
    float absorptionMid1kHz;
    float absorptionHigh4kHz;
    float diffusion;
    float rt60Seconds;
    float earlyReflectionMs;
    float criticalDistanceM;
    float dryWetMix;
};

struct SpatialMicState {
    float micX;
    float micY;
    float micZ;
    float directDistanceM;
    float haasItdMs;
    float stereoPan;
    float occlusionFactor;
    float occlusionCutoffHz;
    float occlusionAttenuationDb;
    float shockwaveDistanceCutoffHz;
    BiquadCoeffs occlusionLowpass;
    BiquadCoeffs shockwaveLowpass;
    std::array<StandingWaveFilter, 3> standingWaves;
};

inline constexpr uint32_t kSampleRateHz = ${sampleRate}u;
inline constexpr std::size_t kObjectModalCount = ${modalBank.length}u;
inline constexpr std::size_t kSurfaceModalCount = ${surfaceModes.length}u;

inline constexpr ObjectPbrPhysics kObjectPhysics = {
    "${escapeCppString(materialSpec.id)}",
    "${escapeCppString(materialSpec.name)}",
    "${escapeCppString(dspConfig.excitationMode)}",
    ${fmtFloat(objectConfig.massKg, 4)},
    ${fmtFloat(materialSpec.densityKgM3, 2)},
    ${fmtFloat(objectConfig.roughness, 4)},
    ${fmtFloat(objectConfig.hardness, 4)},
    ${fmtFloat(objectConfig.elasticity, 4)},
    ${fmtFloat(materialSpec.frictionCoeff, 4)},
    ${fmtFloat(objectConfig.customVolumePitchScale ?? 1.0, 4)},
    ${fmtFloat(dspConfig.neuralConditioning, 4)},
    ${fmtFloat(materialSpec.neuralHarmonicDrive, 4)},
    ${fmtFloat(materialSpec.neuralFormantHz, 2)},
    ${fmtFloat(hertz.objectEnergyShare, 4)},
    ${fmtFloat(hertz.surfaceEnergyShare, 4)},
    ${fmtFloat(hertz.hertzContactMs, 3)},
    { ${fmtCoeff(neuralFormant.b0)}, ${fmtCoeff(neuralFormant.b1)}, ${fmtCoeff(neuralFormant.b2)}, ${fmtCoeff(neuralFormant.a1)}, ${fmtCoeff(neuralFormant.a2)} }
};

inline constexpr std::array<ModalResonatorMode, kObjectModalCount> kObjectModalBank = {{
${modalEntries}
}};

inline constexpr std::array<ModalResonatorMode, kSurfaceModalCount> kSurfaceModalBank = {{
${surfaceEntries}
}};

inline constexpr RoomAcousticParams kRoomAcoustics = {
    "${escapeCppString(roomConfig.materialId)}",
    "${escapeCppString(roomSpec.name)}",
    "${escapeCppString(roomConfig.sizePreset)}",
    ${fmtFloat(roomMetrics.dimensions.width, 3)},
    ${fmtFloat(roomMetrics.dimensions.height, 3)},
    ${fmtFloat(roomMetrics.dimensions.depth, 3)},
    ${fmtFloat(roomMetrics.volumeM3, 3)},
    ${fmtFloat(roomMetrics.surfaceAreaM2, 3)},
    ${fmtFloat(roomConfig.wallAbsorption, 4)},
    ${fmtFloat(roomSpec.bandAbsorption.low, 4)},
    ${fmtFloat(roomSpec.bandAbsorption.mid, 4)},
    ${fmtFloat(roomSpec.bandAbsorption.high, 4)},
    ${fmtFloat(roomSpec.diffusion, 4)},
    ${fmtFloat(roomMetrics.rt60Seconds, 4)},
    ${fmtFloat(roomMetrics.earlyReflectionMs, 3)},
    ${fmtFloat(roomMetrics.criticalDistanceM, 3)},
    ${fmtFloat(roomConfig.dryWet, 4)}
};

inline constexpr SpatialMicState kSpatialMic = {
    ${fmtFloat(spatialProbe.micPosition.x, 4)},
    ${fmtFloat(spatialProbe.micPosition.y, 4)},
    ${fmtFloat(spatialProbe.micPosition.z, 4)},
    ${fmtFloat(spatialProbe.directDistanceM, 4)},
    ${fmtFloat(spatialProbe.haasItdMs, 4)},
    ${fmtFloat(spatialProbe.stereoPan, 4)},
    ${fmtFloat(spatialProbe.occlusionFactor, 4)},
    ${fmtFloat(spatialProbe.occlusionCutoffHz, 2)},
    ${fmtFloat(spatialProbe.occlusionAttenuationDb, 3)},
    ${fmtFloat(shockCutoffHz, 2)},
    { ${fmtCoeff(occlusionLp.b0)}, ${fmtCoeff(occlusionLp.b1)}, ${fmtCoeff(occlusionLp.b2)}, ${fmtCoeff(occlusionLp.a1)}, ${fmtCoeff(occlusionLp.a2)} },
    { ${fmtCoeff(shockLp.b0)}, ${fmtCoeff(shockLp.b1)}, ${fmtCoeff(shockLp.b2)}, ${fmtCoeff(shockLp.a1)}, ${fmtCoeff(shockLp.a2)} },
    {{
${standingWaveEntries}
    }}
};

} // namespace acoustic3d::preset
`;
}
