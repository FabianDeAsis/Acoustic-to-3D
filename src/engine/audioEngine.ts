import { computeAudioLevels, computeModalBank, type ImpulseResponseData } from './dspMath';
import { resolvePbrMaterialSpec } from './materials';
import { getEffectiveRoomDimensions } from './physics';
import {
  computeDualHertzPartition,
  computeElasticCavityParams,
  computePoissonLambda,
  computeSurfaceModalBank,
  generateFriedlanderShockwave,
  generatePoissonFractureBuffer,
  POISSON_FRACTURE_WORKLET_CODE,
  type FriedlanderShockwaveResult,
} from './physicalExcitation';
import {
  concatStereoChunks,
  STEREO_PCM_RECORDER_WORKLET_CODE,
  type RecordingTrackMode,
} from './sessionExport';
import {
  computeSpatialAcousticProbe,
  encodeStereoWav24Bit,
  generateLogSineSweep,
  generateSpatialRoomImpulseResponse,
  getRoomAcousticOccluder,
} from './spatialAcoustics';
import type {
  AcousticOccluderBox,
  AudioMeterSnapshot,
  ContactEvent,
  DspEngineConfig,
  FoleySceneAudioTrigger,
  MeasuredIrSummary,
  ModalPartial,
  ObjectPhysicsConfig,
  PbrMaterialSpec,
  RoomAcousticConfig,
  SpatialAcousticProbe,
  Vec3,
} from './types';

/**
 * Real-time 48kHz Web Audio API Foley & Spatial Synthesis Engine.
 *
 * Signal topology:
 *   [Impact Exciter -> 8-Band Modal Bank] ──┐
 *                                           ├─> [Neural Timbre Conditioning (DDSP Shaper + Formant)] ─> [Stereo Panner]
 *   [Friction Noise + Stick-Slip Modulator ─┘                                                               │
 *    -> Roughness BP + Modal Resonators]                                                                    │
 *                                                                            ┌── Dry Gain ──────────────────┤
 *                                                                            │                              │
 *                                                                            └── Convolver (Dynamic 48k IR) ─> Wet Gain
 *                                                                                                           │
 *                                                                            [Master Gain -> Dynamics Limiter -> AnalyserNode -> Out]
 */
export class AcousticAudioEngine {
  private ctx: AudioContext | null = null;
  private isRunning = false;

  // Routing & master nodes
  private preFxBus: GainNode | null = null;
  private neuralDryGain: GainNode | null = null;
  private neuralWetGain: GainNode | null = null;
  private neuralShaper: WaveShaperNode | null = null;
  private neuralFormant: BiquadFilterNode | null = null;
  private panner: StereoPannerNode | null = null;

  private dryGain: GainNode | null = null;
  private wetGain: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private masterGain: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private analyser: AnalyserNode | null = null;

  // Real-time spatial listener stage (Occlusion LP + Standing-Wave Modal EQ + Binaural Haas ITD/ILD)
  private occlusionFilter: BiquadFilterNode | null = null;
  private directDistanceGain: GainNode | null = null;
  private standingWaveFilters: BiquadFilterNode[] = [];
  private haasDelayL: DelayNode | null = null;
  private haasDelayR: DelayNode | null = null;
  private haasGainL: GainNode | null = null;
  private haasGainR: GainNode | null = null;
  private haasMerger: ChannelMergerNode | null = null;

  // Continuous friction synthesizer (always allocated when active, gain smoothly modulated)
  private frictionSource: AudioBufferSourceNode | null = null;
  private frictionBaseFilter: BiquadFilterNode | null = null;
  private frictionResonatorA: BiquadFilterNode | null = null;
  private frictionResonatorB: BiquadFilterNode | null = null;
  private frictionGain: GainNode | null = null;
  private frictionGrainGain: GainNode | null = null;

  // Real-time 48kHz Stochastic Poisson Fracture engine (AudioWorklet with continuous-buffer fallback)
  private poissonWorkletNode: AudioWorkletNode | null = null;
  private poissonFallbackSrc: AudioBufferSourceNode | null = null;
  private poissonFallbackGain: GainNode | null = null;
  private poissonFallbackFilter: BiquadFilterNode | null = null;
  private poissonBackend: 'audioworklet' | 'buffer' = 'buffer';
  private currentPoissonLambda = 0;

  // Real-time 48kHz Live Stereo PCM Recorder (Dry / Wet / Mix bus matrix)
  private recorderDryBus: GainNode | null = null;
  private recorderWetBus: GainNode | null = null;
  private recorderMixBus: GainNode | null = null;
  private recorderSumBus: GainNode | null = null;
  private recorderWorkletNode: AudioWorkletNode | null = null;
  private recorderFallbackNode: ScriptProcessorNode | null = null;
  private recorderSilentSink: GainNode | null = null;
  private recordingActive = false;
  private recordingTrackMode: RecordingTrackMode = 'mix';
  private recordedChunksL: Float32Array[] = [];
  private recordedChunksR: Float32Array[] = [];
  private recordedSampleCount = 0;
  private recorderStopResolver: (() => void) | null = null;
  private lastRecordingExport: {
    wavBuffer: ArrayBuffer;
    filename: string;
    durationSec: number;
    sampleRate: number;
    trackMode: RecordingTrackMode;
    peakDb: number;
  } | null = null;

  // Cached noise buffers
  private whiteNoiseBuffer: AudioBuffer | null = null;
  private pinkNoiseBuffer: AudioBuffer | null = null;
  private activeSweepSource: AudioBufferSourceNode | null = null;

  // Analysis scratch buffers (zero GC in animation loop)
  private freqBins: Float32Array<ArrayBuffer> = new Float32Array(2048);
  private timeBins: Float32Array<ArrayBuffer> = new Float32Array(2048);

  // Current DSP state
  private objectConfig: ObjectPhysicsConfig;
  private activeMaterialSpec: PbrMaterialSpec;
  private roomConfig: RoomAcousticConfig;
  private dspConfig: DspEngineConfig;
  private modalBank: ModalPartial[];
  private latestIr: ImpulseResponseData;
  private measuredIr: ImpulseResponseData | null = null;
  private measuredIrSummary: MeasuredIrSummary | null = null;
  private currentSourcePos: Vec3 = { x: 0, y: 0.35, z: 0 };
  private currentMicPos: Vec3 = { x: -2.2, y: 1.45, z: 1.6 };
  private latestProbe: SpatialAcousticProbe;
  private lastIrUpdateMs = 0;
  private activeVoiceCount = 0;

  constructor(
    objectConfig: ObjectPhysicsConfig,
    roomConfig: RoomAcousticConfig,
    dspConfig: DspEngineConfig
  ) {
    this.objectConfig = objectConfig;
    this.activeMaterialSpec = resolvePbrMaterialSpec(objectConfig.materialId);
    this.roomConfig = roomConfig;
    this.dspConfig = dspConfig;
    this.modalBank = computeModalBank(objectConfig, this.activeMaterialSpec);

    const dims = getEffectiveRoomDimensions(roomConfig);
    const occluder = getRoomAcousticOccluder(dims);
    this.latestProbe = computeSpatialAcousticProbe(
      this.currentSourcePos,
      this.currentMicPos,
      dims,
      roomConfig,
      occluder
    );
    this.latestIr = generateSpatialRoomImpulseResponse(
      roomConfig,
      this.currentSourcePos,
      this.currentMicPos,
      occluder,
      48000
    );
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  public getLatestIr(): ImpulseResponseData {
    return this.measuredIr ?? this.latestIr;
  }

  public getPoissonBackend(): 'audioworklet' | 'buffer' {
    return this.poissonBackend;
  }

  public getCurrentPoissonLambda(): number {
    return this.currentPoissonLambda;
  }

  public getMeasuredIrSummary(): MeasuredIrSummary | null {
    return this.measuredIrSummary;
  }

  public getModalBank(): ModalPartial[] {
    return this.modalBank;
  }

  public async start(): Promise<boolean> {
    if (this.isRunning && this.ctx) {
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      return true;
    }

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return false;

    const ctx = new AudioCtx({
      sampleRate: 48000,
      latencyHint: 'interactive',
    });
    this.ctx = ctx;

    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    // Create shared noise buffers (2s looping stereo/mono buffers)
    this.whiteNoiseBuffer = this.createNoiseBuffer(ctx, 2.0, 'white');
    this.pinkNoiseBuffer = this.createNoiseBuffer(ctx, 2.0, 'pink');

    // Main buses
    this.preFxBus = ctx.createGain();
    this.preFxBus.gain.value = 1.0;

    // Neural Timbre Conditioning parallel stage (DDSP harmonic coloration + formant resonance)
    this.neuralDryGain = ctx.createGain();
    this.neuralWetGain = ctx.createGain();
    this.neuralShaper = ctx.createWaveShaper();
    this.neuralShaper.oversample = '2x';
    this.neuralFormant = ctx.createBiquadFilter();
    this.neuralFormant.type = 'peaking';
    this.neuralFormant.Q.value = 1.6;
    this.neuralFormant.gain.value = 4.5;

    this.panner = ctx.createStereoPanner();
    this.panner.pan.value = 0;

    // Spatial Listener Stage: Occlusion Lowpass -> Distance Gain -> 3 Standing-Wave EQ Filters -> Haas Binaural ITD/ILD
    this.occlusionFilter = ctx.createBiquadFilter();
    this.occlusionFilter.type = 'lowpass';
    this.occlusionFilter.frequency.value = 19500;
    this.occlusionFilter.Q.value = 0.72;

    this.directDistanceGain = ctx.createGain();
    this.directDistanceGain.gain.value = 1.0;

    this.standingWaveFilters = [0, 1, 2].map(() => {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = 80;
      f.Q.value = 6.0;
      f.gain.value = 0;
      return f;
    });

    this.haasDelayL = ctx.createDelay(0.05);
    this.haasDelayR = ctx.createDelay(0.05);
    this.haasGainL = ctx.createGain();
    this.haasGainR = ctx.createGain();
    this.haasMerger = ctx.createChannelMerger(2);

    this.dryGain = ctx.createGain();
    this.wetGain = ctx.createGain();
    this.convolver = ctx.createConvolver();
    this.convolver.normalize = true;

    this.masterGain = ctx.createGain();

    // Transparent studio peak limiter to guarantee clean headroom on heavy impacts
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3.0;
    this.limiter.knee.value = 6.0;
    this.limiter.ratio.value = 12.0;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.085;

    // FabFilter-grade 4096-point FFT analyzer
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.78;
    this.analyser.minDecibels = -96;
    this.analyser.maxDecibels = 0;
    this.freqBins = new Float32Array(this.analyser.frequencyBinCount);
    this.timeBins = new Float32Array(this.analyser.fftSize);

    // Connect Neural Conditioning Stage
    this.preFxBus.connect(this.neuralDryGain);
    this.preFxBus.connect(this.neuralShaper);
    this.neuralShaper.connect(this.neuralFormant);
    this.neuralFormant.connect(this.neuralWetGain);

    this.neuralDryGain.connect(this.panner);
    this.neuralWetGain.connect(this.panner);

    // Direct path: Panner -> Occlusion LP -> Distance Gain -> Standing-Wave Modal EQ -> Binaural Haas ITD/ILD -> Dry Gain
    this.panner.connect(this.occlusionFilter);
    this.occlusionFilter.connect(this.directDistanceGain);
    this.directDistanceGain.connect(this.standingWaveFilters[0]);
    this.standingWaveFilters[0].connect(this.standingWaveFilters[1]);
    this.standingWaveFilters[1].connect(this.standingWaveFilters[2]);

    const swOut = this.standingWaveFilters[2];
    swOut.connect(this.haasDelayL);
    swOut.connect(this.haasDelayR);
    this.haasDelayL.connect(this.haasGainL);
    this.haasDelayR.connect(this.haasGainR);
    this.haasGainL.connect(this.haasMerger, 0, 0);
    this.haasGainR.connect(this.haasMerger, 0, 1);
    this.haasMerger.connect(this.dryGain);

    // Reverberant path: Panner -> Spatial Convolver (already encodes position-dependent early reflections & modes) -> Wet Gain
    this.panner.connect(this.convolver);
    this.convolver.connect(this.wetGain);

    this.dryGain.connect(this.masterGain);
    this.wetGain.connect(this.masterGain);
    this.masterGain.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    // Initialize Continuous Friction Synthesizer, Poisson AudioWorklet & Stereo PCM Session Recorder
    this.initFrictionChain(ctx);
    await this.initPoissonFractureChain(ctx);
    await this.initSessionRecorderChain(ctx);

    // Apply initial configs and upload 48kHz spatial IR
    this.applyObjectConfig(this.objectConfig, this.activeMaterialSpec);
    this.applyRoomConfig(this.roomConfig, true);
    this.applySpatialProbe(this.latestProbe, this.currentSourcePos, true);
    this.applyDspConfig(this.dspConfig);

    this.isRunning = true;
    return true;
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    this.currentPoissonLambda = 0;
    if (this.activeSweepSource) {
      try {
        this.activeSweepSource.stop();
        this.activeSweepSource.disconnect();
      } catch {
        // Ignore already stopped sweep
      }
      this.activeSweepSource = null;
    }
    if (this.frictionSource) {
      try {
        this.frictionSource.stop();
        this.frictionSource.disconnect();
      } catch {
        // Ignore already stopped source
      }
      this.frictionSource = null;
    }
    if (this.poissonWorkletNode) {
      try {
        this.poissonWorkletNode.disconnect();
      } catch {
        // Ignore
      }
      this.poissonWorkletNode = null;
    }
    if (this.poissonFallbackSrc) {
      try {
        this.poissonFallbackSrc.stop();
        this.poissonFallbackSrc.disconnect();
      } catch {
        // Ignore
      }
      this.poissonFallbackSrc = null;
      this.poissonFallbackGain = null;
      this.poissonFallbackFilter = null;
    }
    if (this.recorderWorkletNode) {
      try {
        this.recorderWorkletNode.port.postMessage({ type: 'stop' });
        this.recorderWorkletNode.disconnect();
      } catch {
        // Ignore
      }
      this.recorderWorkletNode = null;
    }
    if (this.recorderFallbackNode) {
      try {
        this.recorderFallbackNode.onaudioprocess = null;
        this.recorderFallbackNode.disconnect();
      } catch {
        // Ignore
      }
      this.recorderFallbackNode = null;
    }
    this.recorderDryBus = null;
    this.recorderWetBus = null;
    this.recorderMixBus = null;
    this.recorderSumBus = null;
    this.recorderSilentSink = null;
    this.recordingActive = false;
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
    }
    this.activeVoiceCount = 0;
  }

  /**
   * Initializes the glitch-free 3-bus stereo tap (Dry / Wet / Mix) feeding a real-time 48 kHz
   * Stereo PCM Recorder AudioWorklet (with ScriptProcessorNode fallback).
   */
  private async initSessionRecorderChain(ctx: AudioContext): Promise<void> {
    if (!this.haasMerger || !this.convolver || !this.limiter) return;

    const dryBus = ctx.createGain();
    const wetBus = ctx.createGain();
    const mixBus = ctx.createGain();
    const sumBus = ctx.createGain();
    const silentSink = ctx.createGain();
    silentSink.gain.value = 0;

    this.haasMerger.connect(dryBus);
    this.convolver.connect(wetBus);
    this.limiter.connect(mixBus);

    dryBus.connect(sumBus);
    wetBus.connect(sumBus);
    mixBus.connect(sumBus);

    this.recorderDryBus = dryBus;
    this.recorderWetBus = wetBus;
    this.recorderMixBus = mixBus;
    this.recorderSumBus = sumBus;
    this.recorderSilentSink = silentSink;
    this.applyRecordingBusRouting(this.recordingTrackMode);

    if (typeof AudioWorkletNode !== 'undefined' && ctx.audioWorklet) {
      let blobUrl: string | null = null;
      try {
        const blob = new Blob([STEREO_PCM_RECORDER_WORKLET_CODE], {
          type: 'application/javascript',
        });
        blobUrl = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(blobUrl);
        const recNode = new AudioWorkletNode(ctx, 'stereo-pcm-recorder-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 2,
          channelCountMode: 'explicit',
          outputChannelCount: [2],
        });
        recNode.port.onmessage = (event: MessageEvent) => {
          const msg = event.data as
            | { type: 'chunk'; left: Float32Array; right: Float32Array }
            | { type: 'stopped' };
          if (!msg) return;
          if (msg.type === 'chunk') {
            this.recordedChunksL.push(msg.left);
            this.recordedChunksR.push(msg.right);
            this.recordedSampleCount += msg.left.length;
          } else if (msg.type === 'stopped') {
            this.recorderStopResolver?.();
            this.recorderStopResolver = null;
          }
        };
        sumBus.connect(recNode);
        recNode.connect(silentSink);
        silentSink.connect(ctx.destination);
        this.recorderWorkletNode = recNode;
        return;
      } catch {
        // Fall back transparently to ScriptProcessorNode
      } finally {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      }
    }

    if (typeof ctx.createScriptProcessor === 'function') {
      const sp = ctx.createScriptProcessor(2048, 2, 2);
      sp.onaudioprocess = (ev) => {
        if (!this.recordingActive) return;
        const inL = ev.inputBuffer.getChannelData(0);
        const inR =
          ev.inputBuffer.numberOfChannels > 1 ? ev.inputBuffer.getChannelData(1) : inL;
        this.recordedChunksL.push(new Float32Array(inL));
        this.recordedChunksR.push(new Float32Array(inR));
        this.recordedSampleCount += inL.length;
      };
      sumBus.connect(sp);
      sp.connect(silentSink);
      silentSink.connect(ctx.destination);
      this.recorderFallbackNode = sp;
    }
  }

  private applyRecordingBusRouting(mode: RecordingTrackMode): void {
    this.recordingTrackMode = mode;
    if (!this.ctx || !this.recorderDryBus || !this.recorderWetBus || !this.recorderMixBus) return;
    const now = this.ctx.currentTime;
    this.recorderDryBus.gain.setTargetAtTime(mode === 'dry' ? 1.0 : 0.0, now, 0.005);
    this.recorderWetBus.gain.setTargetAtTime(mode === 'wet' ? 1.0 : 0.0, now, 0.005);
    this.recorderMixBus.gain.setTargetAtTime(mode === 'mix' ? 1.0 : 0.0, now, 0.005);
  }

  /**
   * Initializes the 48kHz Poisson-process granular fracture generator on a dedicated AudioWorklet
   * thread (falling back transparently to a pre-synthesized looping Poisson impulse buffer if
   * AudioWorklet is unavailable in a restricted context).
   */
  private async initPoissonFractureChain(ctx: AudioContext): Promise<void> {
    if (!this.preFxBus) return;

    if (typeof AudioWorkletNode !== 'undefined' && ctx.audioWorklet) {
      let blobUrl: string | null = null;
      try {
        const blob = new Blob([POISSON_FRACTURE_WORKLET_CODE], {
          type: 'application/javascript',
        });
        blobUrl = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(blobUrl);
        const node = new AudioWorkletNode(ctx, 'poisson-fracture-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        node.connect(this.preFxBus);
        this.poissonWorkletNode = node;
        this.poissonBackend = 'audioworklet';
        return;
      } catch {
        // Fall through cleanly to continuous buffer generator
      } finally {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      }
    }

    // Continuous Poisson buffer fallback (zero allocations at runtime)
    const generated = generatePoissonFractureBuffer({
      durationSec: 2.0,
      lambdaHz: 480,
      roughness: 0.72,
      sampleRate: ctx.sampleRate,
    });
    const buf = ctx.createBuffer(1, generated.samples.length, ctx.sampleRate);
    buf.copyToChannel(new Float32Array(generated.samples), 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 1400;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.preFxBus);
    src.start();

    this.poissonFallbackSrc = src;
    this.poissonFallbackFilter = filter;
    this.poissonFallbackGain = gain;
    this.poissonBackend = 'buffer';
  }

  private initFrictionChain(ctx: AudioContext): void {
    if (!this.pinkNoiseBuffer || !this.preFxBus) return;

    const src = ctx.createBufferSource();
    src.buffer = this.pinkNoiseBuffer;
    src.loop = true;

    const baseFilter = ctx.createBiquadFilter();
    baseFilter.type = 'bandpass';
    baseFilter.frequency.value = 900;
    baseFilter.Q.value = 1.4;

    const resA = ctx.createBiquadFilter();
    resA.type = 'peaking';
    resA.frequency.value = 420;
    resA.Q.value = 8.0;
    resA.gain.value = 9.0;

    const resB = ctx.createBiquadFilter();
    resB.type = 'peaking';
    resB.frequency.value = 1650;
    resB.Q.value = 10.0;
    resB.gain.value = 7.5;

    const grainGain = ctx.createGain();
    grainGain.gain.value = 1.0;

    const masterFrictionGain = ctx.createGain();
    masterFrictionGain.gain.value = 0.0;

    src.connect(baseFilter);
    baseFilter.connect(resA);
    resA.connect(resB);
    resB.connect(grainGain);
    grainGain.connect(masterFrictionGain);
    masterFrictionGain.connect(this.preFxBus);

    src.start();

    this.frictionSource = src;
    this.frictionBaseFilter = baseFilter;
    this.frictionResonatorA = resA;
    this.frictionResonatorB = resB;
    this.frictionGrainGain = grainGain;
    this.frictionGain = masterFrictionGain;
  }

  private createNoiseBuffer(
    ctx: AudioContext,
    durationSec: number,
    color: 'white' | 'pink'
  ): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * durationSec);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    if (color === 'white') {
      for (let i = 0; i < length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      return buffer;
    }

    // Paul Kellet's refined pink noise filter for organic acoustic grain
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
    return buffer;
  }

  private buildWaveshaperCurve(drive: number): Float32Array<ArrayBuffer> {
    const samples = 1024;
    const curve = new Float32Array(samples);
    const k = Math.max(0.5, drive * 18);
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      // Soft asymmetric harmonic saturation mimicking physical material nonlinearity
      curve[i] = Math.tanh(k * x + 0.08 * x * x) / Math.tanh(k);
    }
    return curve;
  }

  public applyObjectConfig(config: ObjectPhysicsConfig, materialSpec?: PbrMaterialSpec): void {
    this.objectConfig = config;
    this.activeMaterialSpec = materialSpec ?? resolvePbrMaterialSpec(config.materialId);
    this.modalBank = computeModalBank(config, this.activeMaterialSpec);

    if (!this.ctx || !this.neuralFormant || !this.neuralShaper) return;

    const spec = this.activeMaterialSpec;
    const now = this.ctx.currentTime;
    this.neuralFormant.frequency.setTargetAtTime(spec.neuralFormantHz, now, 0.02);
    this.neuralShaper.curve = this.buildWaveshaperCurve(
      spec.neuralHarmonicDrive * (0.4 + this.dspConfig.neuralConditioning)
    );

    // Retune continuous friction modal resonators immediately to match the active PBR material
    if (this.frictionResonatorA && this.frictionResonatorB && this.modalBank.length >= 3) {
      this.frictionResonatorA.frequency.setTargetAtTime(this.modalBank[0].frequencyHz, now, 0.02);
      this.frictionResonatorA.Q.setTargetAtTime(
        Math.min(22, Math.max(3, this.modalBank[0].qFactor * 0.12)),
        now,
        0.02
      );
      this.frictionResonatorB.frequency.setTargetAtTime(this.modalBank[2].frequencyHz, now, 0.02);
      this.frictionResonatorB.Q.setTargetAtTime(
        Math.min(26, Math.max(3.5, this.modalBank[2].qFactor * 0.11)),
        now,
        0.02
      );
    }
  }

  private uploadIrToConvolver(ir: ImpulseResponseData): void {
    if (!this.ctx || !this.convolver) return;
    const irBuffer = this.ctx.createBuffer(2, ir.left.length, ir.sampleRate);
    irBuffer.copyToChannel(new Float32Array(ir.left), 0);
    irBuffer.copyToChannel(new Float32Array(ir.right), 1);
    this.convolver.buffer = irBuffer;
  }

  public applyRoomConfig(config: RoomAcousticConfig, forceRegenerateIr = false): void {
    const needsIr =
      forceRegenerateIr ||
      config.materialId !== this.roomConfig.materialId ||
      config.sizePreset !== this.roomConfig.sizePreset ||
      Math.abs(config.scaleMultiplier - this.roomConfig.scaleMultiplier) > 0.015 ||
      Math.abs(config.wallAbsorption - this.roomConfig.wallAbsorption) > 0.015;

    this.roomConfig = config;

    const sampleRate = this.ctx ? this.ctx.sampleRate : 48000;
    if (needsIr) {
      const dims = getEffectiveRoomDimensions(config);
      const occluder = getRoomAcousticOccluder(dims);
      this.latestIr = generateSpatialRoomImpulseResponse(
        config,
        this.currentSourcePos,
        this.currentMicPos,
        occluder,
        sampleRate
      );
      this.measuredIr = null;
      this.uploadIrToConvolver(this.latestIr);
    }

    if (this.ctx && this.dryGain && this.wetGain) {
      const now = this.ctx.currentTime;
      const wet = Math.max(0, Math.min(1, config.dryWet));
      // Equal-power Dry/Wet crossfade
      const dryVal = Math.cos(wet * Math.PI * 0.5);
      const wetVal = Math.sin(wet * Math.PI * 0.5) * 1.15;
      this.dryGain.gain.setTargetAtTime(dryVal, now, 0.02);
      this.wetGain.gain.setTargetAtTime(wetVal, now, 0.02);
    }
  }

  /**
   * Updates live binaural Haas ITD/ILD, standing-wave modal filters, occlusion lowpass,
   * and (throttled) spatially-resolved convolver IR as the user drags the 3D measurement mic.
   */
  public applySpatialProbe(
    probe: SpatialAcousticProbe,
    sourcePos: Vec3,
    refreshConvolverIr = false
  ): void {
    this.latestProbe = probe;
    this.currentSourcePos = { ...sourcePos };
    this.currentMicPos = { ...probe.micPosition };

    if (this.ctx) {
      const now = this.ctx.currentTime;

      // 1. Acoustic Occlusion Lowpass Filter & Direct Distance/Occlusion Attenuation
      if (this.occlusionFilter) {
        this.occlusionFilter.frequency.setTargetAtTime(
          Math.max(450, Math.min(19800, probe.occlusionCutoffHz)),
          now,
          0.025
        );
      }

      if (this.directDistanceGain) {
        const distGain = Math.min(1.2, Math.max(0.22, 1.55 / Math.max(0.75, probe.directDistanceM)));
        const occGain = Math.pow(10, probe.occlusionAttenuationDb / 20);
        this.directDistanceGain.gain.setTargetAtTime(distGain * occGain, now, 0.025);
      }

      // 2. Real-time Standing-Wave Room Eigenmode Filters (boost at corners, dips at nodes)
      for (let i = 0; i < this.standingWaveFilters.length; i++) {
        const filter = this.standingWaveFilters[i];
        const mode = probe.standingWaves[i];
        if (mode) {
          filter.frequency.setTargetAtTime(mode.frequencyHz, now, 0.03);
          filter.Q.setTargetAtTime(mode.qFactor, now, 0.03);
          filter.gain.setTargetAtTime(mode.gainDb, now, 0.03);
        } else {
          filter.gain.setTargetAtTime(0, now, 0.03);
        }
      }

      // 3. Binaural Haas Effect (ITD in seconds + ILD gain asymmetry)
      if (this.haasDelayL && this.haasDelayR && this.haasGainL && this.haasGainR) {
        const itdSec = Math.abs(probe.haasItdMs) / 1000;
        const delayL = probe.haasItdMs > 0 ? itdSec : 0;
        const delayR = probe.haasItdMs < 0 ? itdSec : 0;
        this.haasDelayL.delayTime.setTargetAtTime(delayL, now, 0.015);
        this.haasDelayR.delayTime.setTargetAtTime(delayR, now, 0.015);

        const panAngle = ((probe.stereoPan + 1) * Math.PI) / 4;
        const ildL = Math.cos(panAngle) * 1.25;
        const ildR = Math.sin(panAngle) * 1.25;
        this.haasGainL.gain.setTargetAtTime(ildL, now, 0.02);
        this.haasGainR.gain.setTargetAtTime(ildR, now, 0.02);
      }
    }

    const nowMs = performance.now();
    if (refreshConvolverIr && nowMs - this.lastIrUpdateMs > 180) {
      this.lastIrUpdateMs = nowMs;
      const sampleRate = this.ctx ? this.ctx.sampleRate : 48000;
      const dims = getEffectiveRoomDimensions(this.roomConfig);
      const occluder = getRoomAcousticOccluder(dims);
      this.latestIr = generateSpatialRoomImpulseResponse(
        this.roomConfig,
        this.currentSourcePos,
        this.currentMicPos,
        occluder,
        sampleRate
      );
      this.uploadIrToConvolver(this.latestIr);
    }
  }

  /**
   * Emits a real audible 20 Hz -> 20 kHz logarithmic sine sweep through the live spatial room chain
   * and computes the exact spatially-resolved 48 kHz stereo Impulse Response at the current mic coordinate.
   */
  public async triggerSineSweep(
    sourcePos: Vec3,
    micPos: Vec3,
    occluder?: AcousticOccluderBox,
    onComplete?: (summary: MeasuredIrSummary) => void
  ): Promise<MeasuredIrSummary> {
    const started = await this.start();
    this.currentSourcePos = { ...sourcePos };
    this.currentMicPos = { ...micPos };

    const dims = getEffectiveRoomDimensions(this.roomConfig);
    const activeOccluder = occluder ?? getRoomAcousticOccluder(dims);
    const probe = computeSpatialAcousticProbe(
      sourcePos,
      micPos,
      dims,
      this.roomConfig,
      activeOccluder
    );

    // Always compute the exact 48 kHz studio-standard stereo IR for DAW / game engine export
    const measured = generateSpatialRoomImpulseResponse(
      this.roomConfig,
      sourcePos,
      micPos,
      activeOccluder,
      48000
    );
    this.latestIr = measured;
    this.measuredIr = measured;

    const summary: MeasuredIrSummary = {
      micPosition: { ...probe.micPosition },
      roomMaterialId: this.roomConfig.materialId,
      roomSizePreset: this.roomConfig.sizePreset,
      rt60Seconds: measured.rt60Seconds,
      durationSec: measured.durationSec,
      sampleRate: 48000,
      bitDepth: 24,
      channels: 2,
      measuredAtMs: Date.now(),
    };
    this.measuredIrSummary = summary;

    // Upload the freshly measured spatial IR to the live convolver & apply probe DSP
    this.applySpatialProbe(probe, sourcePos, false);
    this.uploadIrToConvolver(measured);

    // Emit the audible 20Hz -> 20kHz exponential sine sweep through the live room acoustics chain
    const sweepDurSec = 1.8;
    let completed = false;
    let fallbackTimerId: number | null = null;
    const finishSweep = () => {
      if (completed) return;
      completed = true;
      if (fallbackTimerId !== null) {
        window.clearTimeout(fallbackTimerId);
        fallbackTimerId = null;
      }
      onComplete?.(summary);
    };

    if (started && this.ctx && this.panner) {
      if (this.activeSweepSource) {
        try {
          this.activeSweepSource.stop();
          this.activeSweepSource.disconnect();
        } catch {
          // Ignore
        }
        this.activeSweepSource = null;
      }

      const ctx = this.ctx;
      const sweepSamples = generateLogSineSweep(sweepDurSec, 20, 20000, ctx.sampleRate);
      const sweepBuffer = ctx.createBuffer(1, sweepSamples.length, ctx.sampleRate);
      sweepBuffer.copyToChannel(new Float32Array(sweepSamples), 0);

      const src = ctx.createBufferSource();
      src.buffer = sweepBuffer;

      const sweepGain = ctx.createGain();
      sweepGain.gain.value = 0.72;

      src.connect(sweepGain);
      sweepGain.connect(this.panner);

      this.activeSweepSource = src;
      this.activeVoiceCount += 1;

      src.onended = () => {
        try {
          src.disconnect();
          sweepGain.disconnect();
        } catch {
          // Ignore
        }
        if (this.activeSweepSource === src) {
          this.activeSweepSource = null;
        }
        this.activeVoiceCount = Math.max(0, this.activeVoiceCount - 1);
        finishSweep();
      };

      src.start(ctx.currentTime + 0.01);
      // Safety fallback in case audio clock lags slightly behind wall clock
      fallbackTimerId = window.setTimeout(finishSweep, Math.round(sweepDurSec * 1000) + 320);
    } else {
      fallbackTimerId = window.setTimeout(finishSweep, 450);
    }

    return summary;
  }

  /**
   * Exports the active or measured spatially-resolved Impulse Response as a 24-bit / 48 kHz
   * stereo PCM .WAV ArrayBuffer ready for download into any DAW or game engine.
   */
  public exportMeasuredIrWav24Bit(): {
    wavBuffer: ArrayBuffer;
    filename: string;
    summary: MeasuredIrSummary;
  } {
    const ir = this.measuredIr ?? this.latestIr;
    const wavBuffer = encodeStereoWav24Bit(ir.left, ir.right, 48000);
    const pos = this.measuredIrSummary?.micPosition ?? this.currentMicPos;
    const roomTag = `${this.roomConfig.sizePreset}_${this.roomConfig.materialId}`;
    const coordTag = `X${pos.x.toFixed(1)}_Y${pos.y.toFixed(1)}_Z${pos.z.toFixed(1)}`;
    const filename = `IR_${roomTag}_${coordTag}_48kHz_24bit.wav`;

    const summary: MeasuredIrSummary = this.measuredIrSummary ?? {
      micPosition: { ...pos },
      roomMaterialId: this.roomConfig.materialId,
      roomSizePreset: this.roomConfig.sizePreset,
      rt60Seconds: ir.rt60Seconds,
      durationSec: ir.durationSec,
      sampleRate: 48000,
      bitDepth: 24,
      channels: 2,
      measuredAtMs: Date.now(),
    };

    return { wavBuffer, filename, summary };
  }

  public setRecordingTrackMode(mode: RecordingTrackMode): void {
    this.applyRecordingBusRouting(mode);
  }

  public getIsRecording(): boolean {
    return this.recordingActive;
  }

  public getLastRecordingExport() {
    return this.lastRecordingExport;
  }

  /**
   * Arms real-time 48 kHz stereo PCM capture on the selected signal tap:
   *  - 'dry': Direct foley + binaural Haas + occlusion (0% room reverb)
   *  - 'wet': Pure 100% spatial room convolution reverb tail
   *  - 'mix': Final mastered stereo output post-limiter
   */
  public async startSessionRecording(mode: RecordingTrackMode): Promise<boolean> {
    const started = await this.start();
    if (!started || !this.ctx) return false;

    this.applyRecordingBusRouting(mode);
    this.recordedChunksL = [];
    this.recordedChunksR = [];
    this.recordedSampleCount = 0;
    this.recordingActive = true;

    if (this.recorderWorkletNode) {
      this.recorderWorkletNode.port.postMessage({ type: 'start' });
    }
    return true;
  }

  /**
   * Stops live PCM capture, flushes any pending AudioWorklet tail frames, and encodes a
   * standards-compliant 24-bit / 48 kHz Stereo PCM .WAV file ready for DAW import.
   */
  public async stopSessionRecording(): Promise<{
    wavBuffer: ArrayBuffer;
    filename: string;
    durationSec: number;
    sampleRate: number;
    trackMode: RecordingTrackMode;
    peakDb: number;
  } | null> {
    if (!this.recordingActive) return this.lastRecordingExport;
    this.recordingActive = false;

    if (this.recorderWorkletNode) {
      await new Promise<void>((resolve) => {
        const timeoutId = window.setTimeout(() => {
          this.recorderStopResolver = null;
          resolve();
        }, 140);
        this.recorderStopResolver = () => {
          window.clearTimeout(timeoutId);
          resolve();
        };
        this.recorderWorkletNode?.port.postMessage({ type: 'stop' });
      });
    }

    const sampleRate = this.ctx ? this.ctx.sampleRate : 48000;
    let { left, right, totalSamples, peakLinear } = concatStereoChunks(
      this.recordedChunksL,
      this.recordedChunksR
    );

    // Guarantee a valid short silent header if user clicked Stop instantaneously (<1 block)
    if (totalSamples === 0) {
      const fallbackLen = Math.round(sampleRate * 0.1);
      left = new Float32Array(fallbackLen);
      right = new Float32Array(fallbackLen);
      totalSamples = fallbackLen;
      peakLinear = 0;
    }

    const wavBuffer = encodeStereoWav24Bit(left, right, sampleRate);
    const durationSec = Number((totalSamples / sampleRate).toFixed(2));
    const peakDb =
      peakLinear > 1e-6 ? Number((20 * Math.log10(peakLinear)).toFixed(1)) : -96;

    const trackLabel =
      this.recordingTrackMode === 'dry'
        ? 'Dry'
        : this.recordingTrackMode === 'wet'
          ? 'WetReverb'
          : 'Mix';
    const matSlug = this.activeMaterialSpec.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `Foley_${matSlug}_${trackLabel}_${Math.round(sampleRate / 1000)}kHz_24bit.wav`;

    const exported = {
      wavBuffer,
      filename,
      durationSec,
      sampleRate,
      trackMode: this.recordingTrackMode,
      peakDb,
    };
    this.lastRecordingExport = exported;
    return exported;
  }

  public applyDspConfig(config: DspEngineConfig): void {
    this.dspConfig = config;
    if (!this.ctx || !this.masterGain || !this.neuralDryGain || !this.neuralWetGain) return;

    const now = this.ctx.currentTime;
    const linearMaster = Math.pow(10, config.masterGainDb / 20);
    this.masterGain.gain.setTargetAtTime(linearMaster, now, 0.02);

    const neuralMix = Math.max(0, Math.min(1, config.neuralConditioning));
    this.neuralDryGain.gain.setTargetAtTime(1 - neuralMix * 0.55, now, 0.02);
    this.neuralWetGain.gain.setTargetAtTime(neuralMix * 0.85, now, 0.02);

    if (this.neuralShaper) {
      const spec = this.activeMaterialSpec;
      this.neuralShaper.curve = this.buildWaveshaperCurve(
        spec.neuralHarmonicDrive * (0.4 + neuralMix)
      );
    }

    if (config.excitationMode !== 'stochastic_fracture') {
      this.setPoissonParams(0, this.objectConfig.roughness, 0);
    }
  }

  private setPoissonParams(lambdaHz: number, roughness: number, gain: number): void {
    this.currentPoissonLambda = Number(Math.max(0, lambdaHz).toFixed(1));
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    if (this.poissonWorkletNode) {
      const pLambda = this.poissonWorkletNode.parameters.get('lambda');
      const pRough = this.poissonWorkletNode.parameters.get('roughness');
      const pGain = this.poissonWorkletNode.parameters.get('gain');
      pLambda?.setTargetAtTime(Math.max(0, Math.min(2600, lambdaHz)), now, 0.015);
      pRough?.setTargetAtTime(Math.max(0.02, Math.min(1.0, roughness)), now, 0.02);
      pGain?.setTargetAtTime(Math.max(0, Math.min(1.8, gain)), now, 0.018);
    } else if (this.poissonFallbackGain && this.poissonFallbackFilter && this.poissonFallbackSrc) {
      const rateScale = Math.max(0.45, Math.min(2.2, 0.6 + lambdaHz / 950));
      this.poissonFallbackSrc.playbackRate.setTargetAtTime(rateScale, now, 0.03);
      this.poissonFallbackFilter.frequency.setTargetAtTime(
        1100 + roughness * 2400,
        now,
        0.025
      );
      this.poissonFallbackGain.gain.setTargetAtTime(Math.max(0, Math.min(1.4, gain)), now, 0.02);
    }
  }

  /**
   * 4. Onda de Choque (Friedlander / Explosión):
   * Injects a nonlinear Friedlander blast pressure waveform (instantaneous positive shock front
   * + negative rarefaction phase + soft saturation + distance-dependent atmospheric LP filter)
   * directly into the live 3D spatial room path (Haas + Occlusion + Standing Waves + Convolution Reverb).
   */
  public async triggerFriedlanderShockwave(
    sourcePos?: Vec3,
    roomWidth = 8,
    intensity = 1.15
  ): Promise<FriedlanderShockwaveResult> {
    const started = await this.start();
    const pos = sourcePos ?? this.currentSourcePos;
    const distanceM = Math.max(
      0.5,
      Math.hypot(
        pos.x - this.currentMicPos.x,
        pos.y - this.currentMicPos.y,
        pos.z - this.currentMicPos.z
      )
    );

    const sampleRate = this.ctx ? this.ctx.sampleRate : 48000;
    const blast = generateFriedlanderShockwave({
      distanceMeters: distanceM,
      intensity,
      sampleRate,
      durationSec: 0.45,
    });

    if (!started || !this.ctx || !this.panner) {
      return blast;
    }

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const pan = Math.max(-0.85, Math.min(0.85, pos.x / Math.max(2, roomWidth * 0.45)));
    this.panner.pan.setTargetAtTime(pan, now, 0.008);

    const buf = ctx.createBuffer(1, blast.samples.length, ctx.sampleRate);
    buf.copyToChannel(new Float32Array(blast.samples), 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;

    // Additional live biquad distance low-pass + soft low-end shock punch before entering 3D room chain
    const distLp = ctx.createBiquadFilter();
    distLp.type = 'lowpass';
    distLp.frequency.setValueAtTime(blast.distanceCutoffHz, now);
    distLp.Q.value = 0.78;

    const blastGain = ctx.createGain();
    blastGain.gain.value = 1.05;

    src.connect(distLp);
    distLp.connect(blastGain);
    blastGain.connect(this.panner);

    this.activeVoiceCount += 1;
    src.onended = () => {
      try {
        src.disconnect();
        distLp.disconnect();
        blastGain.disconnect();
      } catch {
        // Ignore
      }
      this.activeVoiceCount = Math.max(0, this.activeVoiceCount - 1);
    };
    src.start(now);

    return blast;
  }

  /**
   * Triggers a real-time physical modal impact voice dispatched through the active
   * "Modo de Excitación Física" (Dual Hertz, Elastic Cavity 850Hz, Stochastic Fracture, or Friedlander).
   */
  public triggerImpact(event: ContactEvent, roomWidth = 8): void {
    if (!this.isRunning || !this.ctx || !this.preFxBus || !this.whiteNoiseBuffer) return;

    const modeId = this.dspConfig.excitationMode;
    if (modeId === 'friedlander_shockwave') {
      const intensity = Math.max(0.45, Math.min(1.4, event.velocity / 5.5));
      void this.triggerFriedlanderShockwave(event.position, roomWidth, intensity);
      return;
    }

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const velocityNorm = Math.max(0.08, Math.min(1.0, event.velocity / 7.5));
    const energyGain = Math.pow(velocityNorm, 1.35) * (0.65 + event.contactArea * 0.35);

    // Spatial stereo panning from 3D X coordinate
    if (this.panner) {
      const pan = Math.max(-0.85, Math.min(0.85, event.position.x / Math.max(2, roomWidth * 0.45)));
      this.panner.pan.setTargetAtTime(pan, now, 0.01);
    }

    const voiceGain = ctx.createGain();
    voiceGain.gain.value = energyGain * 0.88;
    voiceGain.connect(this.preFxBus);

    const activeNodes: AudioNode[] = [voiceGain];
    let longestDecaySec = 0.16;

    // 1. Dual Hertz partition (always computed for Dual Hertz; object-dominant for other modes)
    const isWallImpact = Math.abs(event.normal.y) < 0.5;
    const hertz = computeDualHertzPartition(this.objectConfig.hardness, this.roomConfig.materialId);
    const objectShare =
      modeId === 'dual_hertz'
        ? hertz.objectEnergyShare * 1.45
        : modeId === 'elastic_cavity'
        ? 0.42
        : 0.52;
    const surfaceShare = modeId === 'dual_hertz' ? hertz.surfaceEnergyShare * 1.45 : 0;

    // Contact Transient Exciter shaped by Hertzian contact duration & PBR roughness
    const transientDur =
      modeId === 'dual_hertz'
        ? Math.max(0.004, hertz.hertzContactMs / 1000)
        : 0.008 + (1 - this.objectConfig.hardness) * 0.026;
    const transientSrc = ctx.createBufferSource();
    transientSrc.buffer = this.whiteNoiseBuffer;

    const transientFilter = ctx.createBiquadFilter();
    transientFilter.type = 'lowpass';
    const cutoffHz =
      950 + this.objectConfig.hardness * 8500 + event.localRoughness * 2600 * velocityNorm;
    transientFilter.frequency.setValueAtTime(Math.min(16000, cutoffHz), now);
    transientFilter.Q.value = 0.8 + this.objectConfig.hardness * 1.4;

    const transientEnv = ctx.createGain();
    transientEnv.gain.setValueAtTime(0.0001, now);
    transientEnv.gain.linearRampToValueAtTime(0.85 + event.localRoughness * 0.4, now + 0.0012);
    transientEnv.gain.exponentialRampToValueAtTime(0.0001, now + transientDur);

    transientSrc.connect(transientFilter);
    transientFilter.connect(transientEnv);
    transientEnv.connect(voiceGain);
    transientSrc.start(now, Math.random() * 1.5, transientDur + 0.02);
    activeNodes.push(transientSrc, transientFilter, transientEnv);

    // 2. Object Parallel Modal Synthesis Bank (8 or 12 eigenmodes)
    for (let i = 0; i < this.modalBank.length; i++) {
      const mode = this.modalBank[i];
      const modeVelScale = Math.pow(velocityNorm, 0.7 + i * 0.14);
      const amp = mode.gain * modeVelScale * 0.28 * objectShare;
      if (amp < 0.002) continue;

      const decaySec = Math.max(0.03, mode.decayMs / 1000);
      if (decaySec > longestDecaySec) longestDecaySec = decaySec;

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const pitchBend = 1 + 0.012 * velocityNorm * (1 - this.objectConfig.hardness * 0.5);
      osc.frequency.setValueAtTime(Math.min(19500, mode.frequencyHz * pitchBend), now);
      osc.frequency.exponentialRampToValueAtTime(mode.frequencyHz, now + 0.018);

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, now);
      env.gain.linearRampToValueAtTime(amp, now + 0.0015 + i * 0.0002);
      env.gain.exponentialRampToValueAtTime(0.0001, now + decaySec);

      osc.connect(env);
      env.connect(voiceGain);

      osc.start(now);
      osc.stop(now + decaySec + 0.025);
      activeNodes.push(osc, env);
    }

    // 2B. Engine 1: Dual Hertz — Simultaneously excite the impacted floor/wall surface modal bank
    if (modeId === 'dual_hertz' && surfaceShare > 0.05) {
      const surfaceModes = computeSurfaceModalBank(this.roomConfig.materialId, isWallImpact);
      for (let i = 0; i < surfaceModes.length; i++) {
        const sMode = surfaceModes[i];
        const amp = sMode.gain * Math.pow(velocityNorm, 0.75 + i * 0.12) * 0.3 * surfaceShare;
        if (amp < 0.002) continue;

        const decaySec = Math.max(0.025, sMode.decayMs / 1000);
        if (decaySec > longestDecaySec) longestDecaySec = decaySec;

        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(sMode.frequencyHz, now);

        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, now);
        env.gain.linearRampToValueAtTime(amp, now + 0.0018);
        env.gain.exponentialRampToValueAtTime(0.0001, now + decaySec);

        osc.connect(env);
        env.connect(voiceGain);
        osc.start(now);
        osc.stop(now + decaySec + 0.02);
        activeNodes.push(osc, env);
      }
    }

    // 2C. Engine 2: Cavidad Elástica (Pelota) — 850 Hz internal air cavity + 20 ms upward pitch envelope
    if (modeId === 'elastic_cavity') {
      const cav = computeElasticCavityParams(
        event.velocity,
        this.objectConfig.elasticity,
        this.objectConfig.massKg
      );
      const cavDecaySec = cav.decayMs / 1000;
      const envRampSec = cav.pitchEnvelopeMs / 1000; // 20 ms upward air-compression chirp
      if (cavDecaySec > longestDecaySec) longestDecaySec = cavDecaySec;

      // Primary 850 Hz spherical air-cavity resonance with 20 ms upward pitch envelope
      const cavOsc = ctx.createOscillator();
      cavOsc.type = 'sine';
      cavOsc.frequency.setValueAtTime(cav.baseCavityHz, now);
      cavOsc.frequency.exponentialRampToValueAtTime(cav.peakCavityHz, now + envRampSec);
      cavOsc.frequency.exponentialRampToValueAtTime(
        cav.baseCavityHz * 1.015,
        now + Math.min(cavDecaySec, envRampSec + 0.075)
      );

      const cavEnv = ctx.createGain();
      cavEnv.gain.setValueAtTime(0.0001, now);
      cavEnv.gain.linearRampToValueAtTime(cav.cavityGain, now + 0.003);
      cavEnv.gain.exponentialRampToValueAtTime(0.0001, now + cavDecaySec);

      cavOsc.connect(cavEnv);
      cavEnv.connect(voiceGain);
      cavOsc.start(now);
      cavOsc.stop(now + cavDecaySec + 0.025);
      activeNodes.push(cavOsc, cavEnv);

      // Secondary hollow-cavity overtone (~1520 Hz)
      const ovOsc = ctx.createOscillator();
      ovOsc.type = 'sine';
      ovOsc.frequency.setValueAtTime(cav.overtoneHz, now);
      ovOsc.frequency.exponentialRampToValueAtTime(cav.overtonePeakHz, now + envRampSec);

      const ovEnv = ctx.createGain();
      ovEnv.gain.setValueAtTime(0.0001, now);
      ovEnv.gain.linearRampToValueAtTime(cav.cavityGain * 0.32, now + 0.0025);
      ovEnv.gain.exponentialRampToValueAtTime(0.0001, now + cavDecaySec * 0.65);

      ovOsc.connect(ovEnv);
      ovEnv.connect(voiceGain);
      ovOsc.start(now);
      ovOsc.stop(now + cavDecaySec * 0.65 + 0.02);
      activeNodes.push(ovOsc, ovEnv);

      // Rubber shell membrane low thump (~138 Hz)
      const thumpOsc = ctx.createOscillator();
      thumpOsc.type = 'triangle';
      thumpOsc.frequency.setValueAtTime(cav.membraneThumpHz * 1.25, now);
      thumpOsc.frequency.exponentialRampToValueAtTime(cav.membraneThumpHz * 0.78, now + 0.045);

      const thumpEnv = ctx.createGain();
      thumpEnv.gain.setValueAtTime(0.0001, now);
      thumpEnv.gain.linearRampToValueAtTime(cav.cavityGain * 0.62, now + 0.002);
      thumpEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.095);

      thumpOsc.connect(thumpEnv);
      thumpEnv.connect(voiceGain);
      thumpOsc.start(now);
      thumpOsc.stop(now + 0.11);
      activeNodes.push(thumpOsc, thumpEnv);
    }

    // 2D. Engine 3: Fractura Estocástica (Ramas y Hojas) — Crisp Poisson crush burst on impact/pressure
    if (modeId === 'stochastic_fracture') {
      const burstLambda = computePoissonLambda(
        event.velocity * 1.3,
        this.objectConfig.massKg,
        Math.max(0.55, event.localRoughness)
      );
      const burst = generatePoissonFractureBuffer({
        durationSec: 0.16,
        lambdaHz: burstLambda,
        roughness: Math.max(0.45, event.localRoughness),
        sampleRate: ctx.sampleRate,
        seed: Math.floor(now * 100000) ^ 0x4a7b2c1d,
      });
      const bBuf = ctx.createBuffer(1, burst.samples.length, ctx.sampleRate);
      bBuf.copyToChannel(new Float32Array(burst.samples), 0);

      const bSrc = ctx.createBufferSource();
      bSrc.buffer = bBuf;
      const bEnv = ctx.createGain();
      bEnv.gain.setValueAtTime(0.95, now);
      bEnv.gain.exponentialRampToValueAtTime(0.001, now + 0.155);

      bSrc.connect(bEnv);
      bEnv.connect(voiceGain);
      bSrc.start(now);
      activeNodes.push(bSrc, bEnv);
    }

    // 3. Resonant Biquad Body Filter excited by roughness burst
    const bodyFilter = ctx.createBiquadFilter();
    bodyFilter.type = 'bandpass';
    bodyFilter.frequency.setValueAtTime(this.modalBank[0]?.frequencyHz ?? 320, now);
    bodyFilter.Q.setValueAtTime(Math.min(28, (this.modalBank[0]?.qFactor ?? 16) * 0.22), now);

    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.75 * (0.4 + event.localRoughness * 0.8), now);
    transientEnv.connect(bodyFilter);
    bodyFilter.connect(bodyGain);
    bodyGain.connect(voiceGain);
    activeNodes.push(bodyFilter, bodyGain);

    this.activeVoiceCount += 1;
    const cleanupMs = Math.ceil((longestDecaySec + 0.12) * 1000);
    window.setTimeout(() => {
      for (const node of activeNodes) {
        try {
          node.disconnect();
        } catch {
          // Already disconnected
        }
      }
      this.activeVoiceCount = Math.max(0, this.activeVoiceCount - 1);
    }, cleanupMs);
  }

  /**
   * Real-time 48 kHz procedural DSP synthesizer for the animated 3D "Escenas Foley" rigs:
   *  - Basketball: Cavidad 850Hz + 20ms velocity-modulated upward pitch-envelope + Dual floor impact
   *  - Footsteps: Heel-to-toe impacts on Wood / Gravel+Twigs (Poisson fracture) / Metal / Glass
   *  - Percussion: Dual-mode Snare membrane, Brass Cymbal metallic bank, and Hollow Woodblock
   */
  public triggerFoleySceneEvent(trigger: FoleySceneAudioTrigger, roomWidth = 8): void {
    if (!this.isRunning || !this.ctx || !this.preFxBus || !this.whiteNoiseBuffer) return;

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const activeNodes: AudioNode[] = [];
    let longestDecaySec = 0.25;

    if (this.panner) {
      const pan = Math.max(
        -0.85,
        Math.min(0.85, trigger.position.x / Math.max(2, roomWidth * 0.45))
      );
      this.panner.pan.setTargetAtTime(pan, now, 0.008);
    }

    const voiceGain = ctx.createGain();
    voiceGain.gain.value = Math.min(1.25, 0.48 + trigger.intensity * 0.56);
    voiceGain.connect(this.preFxBus);
    activeNodes.push(voiceGain);

    const spawnTone = (
      startHz: number,
      endHz: number,
      amp: number,
      decaySec: number,
      type: OscillatorType = 'sine',
      rampSec = 0.02
    ) => {
      if (amp < 0.002) return;
      longestDecaySec = Math.max(longestDecaySec, decaySec);
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(Math.min(19200, Math.max(24, startHz)), now);
      if (Math.abs(endHz - startHz) > 0.5) {
        osc.frequency.exponentialRampToValueAtTime(
          Math.min(19200, Math.max(24, endHz)),
          now + Math.max(0.005, rampSec)
        );
      }
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, now);
      env.gain.linearRampToValueAtTime(amp, now + 0.0018);
      env.gain.exponentialRampToValueAtTime(0.0001, now + decaySec);
      osc.connect(env);
      env.connect(voiceGain);
      osc.start(now);
      osc.stop(now + decaySec + 0.02);
      activeNodes.push(osc, env);
    };

    const spawnNoiseBurst = (
      filterType: BiquadFilterType,
      freqHz: number,
      qVal: number,
      amp: number,
      durSec: number
    ) => {
      longestDecaySec = Math.max(longestDecaySec, durSec);
      const src = ctx.createBufferSource();
      src.buffer = this.whiteNoiseBuffer!;
      const filt = ctx.createBiquadFilter();
      filt.type = filterType;
      filt.frequency.setValueAtTime(Math.min(18000, freqHz), now);
      filt.Q.value = qVal;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, now);
      env.gain.linearRampToValueAtTime(amp, now + 0.0015);
      env.gain.exponentialRampToValueAtTime(0.0001, now + durSec);
      src.connect(filt);
      filt.connect(env);
      env.connect(voiceGain);
      src.start(now, Math.random() * 1.2, durSec + 0.02);
      activeNodes.push(src, filt, env);
    };

    if (trigger.kind === 'basketball_bounce') {
      // Engine 2: Cavidad Elástica 850Hz + 20 ms upward pitch-envelope proportional to impact speed
      const cav = computeElasticCavityParams(trigger.velocity, 0.85, 0.62);
      const envRampSec = cav.pitchEnvelopeMs / 1000;
      const cavDecaySec = cav.decayMs / 1000;

      spawnTone(cav.baseCavityHz, cav.peakCavityHz, cav.cavityGain * 0.72, cavDecaySec, 'sine', envRampSec);
      spawnTone(cav.overtoneHz, cav.overtonePeakHz, cav.cavityGain * 0.24, cavDecaySec * 0.6, 'sine', envRampSec);
      spawnTone(cav.membraneThumpHz * 1.32, cav.membraneThumpHz * 0.74, cav.cavityGain * 0.52, 0.095, 'triangle', 0.045);

      // Dual Hertz floor excitation (Wood Parquet vs Concrete slab)
      const floorModes = computeSurfaceModalBank(trigger.surfaceMaterial, false);
      const floorScale = trigger.surfaceMaterial === 'wood' ? 0.26 : 0.2;
      for (let i = 0; i < Math.min(5, floorModes.length); i++) {
        const fm = floorModes[i];
        spawnTone(fm.frequencyHz, fm.frequencyHz, fm.gain * floorScale * trigger.intensity, fm.decayMs / 1000);
      }
      spawnNoiseBurst('bandpass', trigger.surfaceMaterial === 'wood' ? 1450 : 2400, 1.3, 0.36 * trigger.intensity, 0.018);
    } else if (trigger.kind === 'basketball_hand_catch') {
      spawnTone(345, 290, 0.14 * trigger.intensity, 0.055, 'sine', 0.025);
      spawnNoiseBurst('bandpass', 1850, 1.8, 0.28 * trigger.intensity, 0.022);
    } else if (trigger.kind === 'footstep_heel' || trigger.kind === 'footstep_toe') {
      const isHeel = trigger.kind === 'footstep_heel';
      const terrain = trigger.terrain ?? 'wood';

      // Shoe boot sole low impact thud
      spawnTone(isHeel ? 132 : 168, isHeel ? 68 : 96, (isHeel ? 0.38 : 0.24) * trigger.intensity, 0.08, 'triangle', 0.04);

      if (terrain === 'gravel_branches') {
        // Engine 3: Stochastic Poisson Fracture burst simulating gravel crunch & dry twigs
        const lambda = computePoissonLambda(
          trigger.velocity * (isHeel ? 1.05 : 0.85),
          68,
          isHeel ? 0.88 : 0.74
        );
        const burst = generatePoissonFractureBuffer({
          durationSec: isHeel ? 0.18 : 0.14,
          lambdaHz: Math.max(480, lambda),
          roughness: 0.86,
          sampleRate: ctx.sampleRate,
          seed: Math.floor(now * 100000) ^ (isHeel ? 0x2f1a8c33 : 0x7b4c91e5),
        });
        const bBuf = ctx.createBuffer(1, burst.samples.length, ctx.sampleRate);
        bBuf.copyToChannel(new Float32Array(burst.samples), 0);
        const bSrc = ctx.createBufferSource();
        bSrc.buffer = bBuf;
        const bEnv = ctx.createGain();
        bEnv.gain.setValueAtTime(0.85 * trigger.intensity, now);
        bEnv.gain.exponentialRampToValueAtTime(0.001, now + (isHeel ? 0.175 : 0.135));
        bSrc.connect(bEnv);
        bEnv.connect(voiceGain);
        bSrc.start(now);
        longestDecaySec = Math.max(longestDecaySec, 0.2);
        activeNodes.push(bSrc, bEnv);
        spawnNoiseBurst('highpass', 1750, 0.9, 0.32 * trigger.intensity, 0.09);
      } else {
        const floorModes = computeSurfaceModalBank(trigger.surfaceMaterial, false);
        const pitchMult = terrain === 'glass' ? 1.45 : terrain === 'metal' ? 1.28 : 1.0;
        const decayScale = terrain === 'glass' ? 0.85 : terrain === 'metal' ? 1.35 : 0.9;
        for (let i = 0; i < floorModes.length; i++) {
          const m = floorModes[i];
          spawnTone(
            m.frequencyHz * pitchMult,
            m.frequencyHz * pitchMult,
            m.gain * 0.22 * trigger.intensity * (isHeel ? 1.0 : 0.72),
            Math.max(0.03, (m.decayMs / 1000) * decayScale)
          );
        }
        const transientHz = terrain === 'glass' ? 4200 : terrain === 'metal' ? 3100 : 1200;
        spawnNoiseBurst('bandpass', transientHz, 1.4, 0.4 * trigger.intensity, isHeel ? 0.025 : 0.018);
      }
    } else if (trigger.kind === 'percussion_snare') {
      // Dual-mode Snare: Drumhead membrane modes + wooden shell + crisp snare wire rattle
      spawnTone(215, 178, 0.56 * trigger.intensity, 0.16, 'sine', 0.025);
      spawnTone(342, 326, 0.34 * trigger.intensity, 0.13, 'sine', 0.02);
      spawnTone(518, 512, 0.18 * trigger.intensity, 0.1, 'sine', 0.015);
      spawnNoiseBurst('highpass', 2400, 0.85, 0.68 * trigger.intensity, 0.17);
      spawnNoiseBurst('bandpass', 5200, 1.6, 0.42 * trigger.intensity, 0.12);
    } else if (trigger.kind === 'percussion_cymbal') {
      // Dual-mode Metallic Bronze Cymbal: Inharmonic modal bank + shimmering HF noise tail
      const cymbalHz = [542, 838, 1215, 1840, 2710, 3960, 5620, 7980];
      cymbalHz.forEach((hz, idx) => {
        const amp = (0.16 / (1 + idx * 0.28)) * trigger.intensity;
        const dec = 0.72 - idx * 0.055;
        spawnTone(hz, hz, amp, Math.max(0.24, dec), 'sine');
      });
      spawnNoiseBurst('bandpass', 6400, 0.9, 0.56 * trigger.intensity, 0.68);
      spawnNoiseBurst('highpass', 9200, 0.7, 0.34 * trigger.intensity, 0.52);
    } else if (trigger.kind === 'percussion_woodblock') {
      // Dual-mode Hollow Slotted Woodblock + hickory stick ping
      const wbHz = [742, 1490, 2365, 3580];
      wbHz.forEach((hz, idx) => {
        spawnTone(hz, hz, (0.42 / (1 + idx * 0.75)) * trigger.intensity, 0.11 - idx * 0.018, 'sine');
      });
      const woodShell = computeSurfaceModalBank('wood', false);
      spawnTone(woodShell[0].frequencyHz * 2.1, woodShell[0].frequencyHz * 2.1, 0.2 * trigger.intensity, 0.09);
      spawnNoiseBurst('bandpass', 2250, 2.2, 0.32 * trigger.intensity, 0.016);
    }

    this.activeVoiceCount += 1;
    const cleanupMs = Math.ceil((longestDecaySec + 0.14) * 1000);
    window.setTimeout(() => {
      for (const node of activeNodes) {
        try {
          node.disconnect();
        } catch {
          // Already disconnected
        }
      }
      this.activeVoiceCount = Math.max(0, this.activeVoiceCount - 1);
    }, cleanupMs);
  }

  /**
   * Updates continuous floor friction synthesis from tangential velocity & PBR roughness heightfield.
   * When in `stochastic_fracture` mode, drives the 48kHz AudioWorklet Poisson impulse generator.
   */
  public updateFriction(event: ContactEvent | null, roomWidth = 8): void {
    if (
      !this.isRunning ||
      !this.ctx ||
      !this.frictionGain ||
      !this.frictionBaseFilter ||
      !this.frictionGrainGain
    ) {
      return;
    }

    const now = this.ctx.currentTime;
    if (!event || event.velocity < 0.03) {
      this.frictionGain.gain.setTargetAtTime(0, now, 0.035);
      this.setPoissonParams(0, this.objectConfig.roughness, 0);
      return;
    }

    if (this.panner) {
      const pan = Math.max(-0.85, Math.min(0.85, event.position.x / Math.max(2, roomWidth * 0.45)));
      this.panner.pan.setTargetAtTime(pan, now, 0.025);
    }

    const speedNorm = Math.min(1.0, event.velocity / 3.8);
    const massPressure = Math.min(1.6, 0.65 + Math.sqrt(this.objectConfig.massKg) * 0.3);
    const roughnessEnergy = 0.28 + event.localRoughness * 1.25;

    // Engine 3: Stochastic Poisson Fracture (Ramas y Hojas) driven live by drag velocity & pressure
    if (this.dspConfig.excitationMode === 'stochastic_fracture') {
      const lambdaHz = computePoissonLambda(
        event.velocity,
        this.objectConfig.massKg,
        event.localRoughness
      );
      const poissonGain = Math.min(1.35, (0.35 + speedNorm * 0.95) * this.dspConfig.frictionGain);
      this.setPoissonParams(lambdaHz, event.localRoughness, poissonGain);

      // Subtle dry foliage bed underneath the crisp Poisson micro-fractures
      this.frictionGain.gain.setTargetAtTime(
        Math.min(0.32, speedNorm * 0.24 * this.dspConfig.frictionGain),
        now,
        0.02
      );
      this.frictionBaseFilter.frequency.setTargetAtTime(2400 + speedNorm * 2800, now, 0.025);
      this.frictionBaseFilter.Q.setTargetAtTime(0.9, now, 0.03);
      return;
    }

    // Silence Poisson worklet when in other excitation modes
    this.setPoissonParams(0, event.localRoughness, 0);

    const targetGain =
      Math.min(1.0, speedNorm * roughnessEnergy * massPressure * 0.78) *
      this.dspConfig.frictionGain;

    // Higher tangential speed & hardness shift scraping centroid upward
    const centerHz = Math.max(
      180,
      Math.min(
        9500,
        340 + speedNorm * 2400 + this.objectConfig.hardness * 1400 + event.localRoughness * 900
      )
    );

    // Smooth glass/metal scrapes have narrower resonant whine; concrete has broad gritty spectrum
    const qVal = Math.max(0.65, Math.min(9.0, 5.2 * (1 - event.localRoughness * 0.82)));

    // Micro-asperity stick-slip modulation derived directly from heightfield sample
    const stickSlipMod = 0.72 + event.asperityImpulse * 0.95;

    this.frictionGain.gain.setTargetAtTime(targetGain, now, 0.02);
    this.frictionBaseFilter.frequency.setTargetAtTime(centerHz, now, 0.025);
    this.frictionBaseFilter.Q.setTargetAtTime(qVal, now, 0.03);
    this.frictionGrainGain.gain.setTargetAtTime(stickSlipMod, now, 0.012);
  }

  /**
   * Reads live FFT spectrum (dB), waveform time-domain samples, and Peak/RMS/LUFS meters.
   */
  public sampleAnalyzer(): {
    frequencyDb: Float32Array;
    timeDomain: Float32Array;
    meters: AudioMeterSnapshot;
  } {
    if (!this.isRunning || !this.ctx || !this.analyser) {
      this.freqBins.fill(-96);
      this.timeBins.fill(0);
      return {
        frequencyDb: this.freqBins,
        timeDomain: this.timeBins,
        meters: {
          peakDb: -96,
          rmsDb: -96,
          lufsMomentary: -96,
          sampleRate: 48000,
          latencyMs: 0,
          activeVoices: 0,
        },
      };
    }

    this.analyser.getFloatFrequencyData(this.freqBins);
    this.analyser.getFloatTimeDomainData(this.timeBins);
    const levels = computeAudioLevels(this.timeBins);

    const baseLat = typeof this.ctx.baseLatency === 'number' ? this.ctx.baseLatency : 0.008;
    const outLat = typeof this.ctx.outputLatency === 'number' ? this.ctx.outputLatency : 0.004;

    return {
      frequencyDb: this.freqBins,
      timeDomain: this.timeBins,
      meters: {
        peakDb: levels.peakDb,
        rmsDb: levels.rmsDb,
        lufsMomentary: levels.lufsMomentary,
        sampleRate: this.ctx.sampleRate,
        latencyMs: Number(((baseLat + outLat) * 1000).toFixed(1)),
        activeVoices: this.activeVoiceCount,
      },
    };
  }
}
