import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  Download,
  FileCode2,
  Loader2,
  MoveHorizontal,
  RotateCcw,
  Square,
  Upload,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import { ControlRack, type MicPositionPresetId } from './components/ControlRack';
import { SpectrumAnalyzer } from './components/SpectrumAnalyzer';
import { AcousticAudioEngine } from './engine/audioEngine';
import { computeModalBank } from './engine/dspMath';
import { PBR_MATERIALS, resolvePbrMaterialSpec, ROOM_MATERIALS } from './engine/materials';
import {
  computePoissonLambda,
  type FriedlanderShockwaveResult,
} from './engine/physicalExcitation';
import {
  computeRoomAcousticMetrics,
  createInitialBodyState,
  getEffectiveRoomDimensions,
} from './engine/physics';
import { AcousticSceneController } from './engine/sceneController';
import {
  generateCppAcousticPresetHeader,
  type RecordingTrackMode,
} from './engine/sessionExport';
import { computeSpatialAcousticProbe, getRoomAcousticOccluder } from './engine/spatialAcoustics';
import {
  createInitialFoleySceneState,
  DEFAULT_FOLEY_SCENE_CONFIG,
  type FoleySceneSimState,
} from './engine/foleyScenes';
import type {
  AnalyzerViewId,
  ConsoleTabId,
  ContactEvent,
  DspEngineConfig,
  FoleySceneAudioTrigger,
  FoleySceneConfig,
  ImportedModelStats,
  MeasuredIrSummary,
  ObjectPhysicsConfig,
  PbrMaterialId,
  PbrMaterialSpec,
  PhysicsBodyState,
  RoomAcousticConfig,
  RoomMaterialId,
  RoomSizePresetId,
  SpatialAcousticProbe,
} from './engine/types';

const INITIAL_OBJECT_CONFIG: ObjectPhysicsConfig = {
  materialId: 'metal',
  shapeId: 'resonator_block',
  massKg: PBR_MATERIALS.metal.defaultMassKg,
  roughness: PBR_MATERIALS.metal.defaultRoughness,
  hardness: PBR_MATERIALS.metal.defaultHardness,
  elasticity: PBR_MATERIALS.metal.defaultElasticity,
};

const INITIAL_ROOM_CONFIG: RoomAcousticConfig = {
  materialId: 'concrete',
  sizePreset: 'studio',
  scaleMultiplier: 1.0,
  wallAbsorption: ROOM_MATERIALS.concrete.defaultAbsorption,
  dryWet: 0.42,
};

const INITIAL_DSP_CONFIG: DspEngineConfig = {
  excitationMode: 'dual_hertz',
  neuralConditioning: 0.55,
  frictionGain: 1.0,
  showAcousticRays: true,
  masterGainDb: 0,
};

export default function App() {
  const [activeTab, setActiveTab] = useState<ConsoleTabId>('material');
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [audioActive, setAudioActive] = useState(false);
  const [autoDragActive, setAutoDragActive] = useState(false);
  const [irVersion, setIrVersion] = useState(1);

  const [objectConfig, setObjectConfig] = useState<ObjectPhysicsConfig>(INITIAL_OBJECT_CONFIG);
  const [customMaterials, setCustomMaterials] = useState<Record<string, PbrMaterialSpec>>({});
  const [isGeneratingMaterial, setIsGeneratingMaterial] = useState(false);
  const [generatorError, setGeneratorError] = useState<string | null>(null);
  const [roomConfig, setRoomConfig] = useState<RoomAcousticConfig>(INITIAL_ROOM_CONFIG);
  const [dspConfig, setDspConfig] = useState<DspEngineConfig>(INITIAL_DSP_CONFIG);
  const [bodyTelemetry, setBodyTelemetry] = useState<PhysicsBodyState>(createInitialBodyState);
  const [spatialProbe, setSpatialProbe] = useState<SpatialAcousticProbe>(() => {
    const dims = getEffectiveRoomDimensions(INITIAL_ROOM_CONFIG);
    return computeSpatialAcousticProbe(
      { x: 0, y: 0.32, z: 0 },
      { x: -2.2, y: 1.45, z: 1.6 },
      dims,
      INITIAL_ROOM_CONFIG,
      getRoomAcousticOccluder(dims)
    );
  });
  const [isSweeping, setIsSweeping] = useState(false);
  const [measuredIrSummary, setMeasuredIrSummary] = useState<MeasuredIrSummary | null>(null);
  const [analyzerViewTrigger, setAnalyzerViewTrigger] = useState<{
    view: AnalyzerViewId;
    nonce: number;
  } | null>(null);
  const [importedModelStats, setImportedModelStats] = useState<ImportedModelStats | null>(null);
  const [isImportingModel, setIsImportingModel] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [lastShockwaveInfo, setLastShockwaveInfo] = useState<
    Pick<
      FriedlanderShockwaveResult,
      'positivePhaseMs' | 'distanceCutoffHz' | 'peakPositive' | 'minNegative'
    > | null
  >(null);
  const [recordingTrackMode, setRecordingTrackMode] = useState<RecordingTrackMode>('mix');
  const [isRecording, setIsRecording] = useState(false);
  const [recordingElapsedSec, setRecordingElapsedSec] = useState(0);
  const [lastRecordedTake, setLastRecordedTake] = useState<{
    filename: string;
    durationSec: number;
    trackMode: RecordingTrackMode;
  } | null>(null);
  const [cppExportFlash, setCppExportFlash] = useState(false);
  const [foleySceneConfig, setFoleySceneConfig] = useState<FoleySceneConfig>(
    DEFAULT_FOLEY_SCENE_CONFIG
  );
  const [foleySimTelemetry, setFoleySimTelemetry] = useState<FoleySceneSimState>(
    createInitialFoleySceneState
  );

  const viewportMountRef = useRef<HTMLDivElement | null>(null);
  const modelFileInputRef = useRef<HTMLInputElement | null>(null);
  const sceneRef = useRef<AcousticSceneController | null>(null);
  const audioEngineRef = useRef<AcousticAudioEngine | null>(null);
  if (!audioEngineRef.current) {
    audioEngineRef.current = new AcousticAudioEngine(
      INITIAL_OBJECT_CONFIG,
      INITIAL_ROOM_CONFIG,
      INITIAL_DSP_CONFIG
    );
  }

  const activeMaterialSpec = useMemo(
    () => resolvePbrMaterialSpec(objectConfig.materialId, customMaterials),
    [objectConfig.materialId, customMaterials]
  );
  const customMaterialList = useMemo(() => Object.values(customMaterials), [customMaterials]);
  const roomMetrics = useMemo(() => computeRoomAcousticMetrics(roomConfig), [roomConfig]);
  const modalBank = useMemo(
    () => computeModalBank(objectConfig, activeMaterialSpec),
    [objectConfig, activeMaterialSpec]
  );

  const ensureAudioStarted = useCallback(async () => {
    const engine = audioEngineRef.current;
    if (!engine) return false;
    if (!engine.getIsRunning()) {
      const ok = await engine.start();
      if (ok) {
        setAudioActive(true);
      }
      return ok;
    }
    return true;
  }, []);

  const handleToggleAudio = useCallback(async () => {
    const engine = audioEngineRef.current;
    if (!engine) return;
    if (audioActive) {
      if (isRecording) {
        setIsRecording(false);
        setRecordingElapsedSec(0);
      }
      await engine.stop();
      setAudioActive(false);
    } else {
      const ok = await engine.start();
      setAudioActive(ok);
    }
  }, [audioActive, isRecording]);

  // Live elapsed timer while recording foley session
  useEffect(() => {
    if (!isRecording) return;
    const startedMs = performance.now();
    const timer = window.setInterval(() => {
      setRecordingElapsedSec((performance.now() - startedMs) / 1000);
    }, 100);
    return () => window.clearInterval(timer);
  }, [isRecording]);

  // Mount Three.js scene controller once inside isolated canvas container
  useEffect(() => {
    const container = viewportMountRef.current;
    const audioEngine = audioEngineRef.current;
    if (!container || !audioEngine) return;

    const controller = new AcousticSceneController(
      container,
      INITIAL_OBJECT_CONFIG,
      INITIAL_ROOM_CONFIG,
      INITIAL_DSP_CONFIG,
      {
        onContactEvent: (event: ContactEvent, roomWidth: number) => {
          if (event.type === 'impact') {
            audioEngine.triggerImpact(event, roomWidth);
          } else {
            audioEngine.updateFriction(event, roomWidth);
          }
        },
        onFrictionEnd: () => {
          audioEngine.updateFriction(null);
        },
        onFoleySceneTrigger: (trigger: FoleySceneAudioTrigger, roomWidth: number) => {
          audioEngine.triggerFoleySceneEvent(trigger, roomWidth);
        },
        onSpatialProbeChange: (probe, sourcePos, refreshConvolverIr) => {
          audioEngine.applySpatialProbe(probe, sourcePos, refreshConvolverIr);
          setSpatialProbe(probe);
          if (refreshConvolverIr) {
            setIrVersion((v) => v + 1);
          }
        },
        onTelemetry: ({ bodyState, spatialProbe: latestProbe, foleySceneState }) => {
          setBodyTelemetry(bodyState);
          setFoleySimTelemetry(foleySceneState);
          if (latestProbe) {
            setSpatialProbe(latestProbe);
          }
        },
      }
    );

    sceneRef.current = controller;

    return () => {
      controller.dispose();
      sceneRef.current = null;
    };
  }, []);

  // Stop Web Audio cleanly on full page unmount
  useEffect(() => {
    return () => {
      void audioEngineRef.current?.stop();
    };
  }, []);

  // Sync object config + custom AI material spec to both 3D viewport & modal synthesizer
  useEffect(() => {
    sceneRef.current?.applyObjectConfig(objectConfig, activeMaterialSpec);
    audioEngineRef.current?.applyObjectConfig(objectConfig, activeMaterialSpec);
  }, [objectConfig, activeMaterialSpec]);

  // Sync room acoustics changes to 3D chamber & 48kHz convolution reverb IR
  useEffect(() => {
    sceneRef.current?.applyRoomConfig(roomConfig);
    audioEngineRef.current?.applyRoomConfig(roomConfig);
    setIrVersion((v) => v + 1);
  }, [roomConfig]);

  // Sync DSP config changes
  useEffect(() => {
    sceneRef.current?.applyDspConfig(dspConfig);
    audioEngineRef.current?.applyDspConfig(dspConfig);
  }, [dspConfig]);

  // Highlight 3D measurement microphone when entering Acústica de Sala tab
  useEffect(() => {
    sceneRef.current?.setRoomAcousticsMode(activeTab === 'room');
  }, [activeTab]);

  // Sync Escenas Foley state & enable/disable 3D animated scene rigs cleanly
  useEffect(() => {
    sceneRef.current?.setFoleySceneConfig(foleySceneConfig);
  }, [foleySceneConfig]);

  const handleSelectConsoleTab = useCallback(
    async (nextTab: ConsoleTabId) => {
      setActiveTab(nextTab);
      if (!consoleOpen) setConsoleOpen(true);

      if (nextTab === 'scenes') {
        setAutoDragActive(false);
        setFoleySceneConfig((prev) => ({
          ...prev,
          enabled: true,
          playing: true,
        }));
        await ensureAudioStarted();
      } else {
        setFoleySceneConfig((prev) => (prev.enabled ? { ...prev, enabled: false } : prev));
      }
    },
    [consoleOpen, ensureAudioStarted]
  );

  const handleChangeFoleySceneConfig = useCallback(
    (patch: Partial<FoleySceneConfig>) => {
      void ensureAudioStarted();
      setFoleySceneConfig((prev) => ({ ...prev, ...patch, enabled: true }));
    },
    [ensureAudioStarted]
  );

  const handleToggleFoleyPlayback = useCallback(async () => {
    await ensureAudioStarted();
    setFoleySceneConfig((prev) => ({ ...prev, playing: !prev.playing }));
  }, [ensureAudioStarted]);

  const handleResetFoleyScene = useCallback(() => {
    sceneRef.current?.resetFoleyScene();
    setFoleySimTelemetry(createInitialFoleySceneState());
  }, []);

  // Physical actions
  const handleDropObject = useCallback(async () => {
    await ensureAudioStarted();
    setAutoDragActive(false);
    sceneRef.current?.triggerDrop(2.45);
  }, [ensureAudioStarted]);

  const handleToggleAutoDrag = useCallback(async () => {
    await ensureAudioStarted();
    setAutoDragActive((prev) => {
      const next = !prev;
      sceneRef.current?.setAutoDrag(next);
      return next;
    });
  }, [ensureAudioStarted]);

  const handleManualImpulse = useCallback(async () => {
    await ensureAudioStarted();
    sceneRef.current?.triggerManualImpulse();
  }, [ensureAudioStarted]);

  const handleResetCamera = useCallback(() => {
    sceneRef.current?.resetCamera();
  }, []);

  // Keyboard shortcuts: Space (drop), D (drag), H (toggle studio console)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.code === 'Space') {
        e.preventDefault();
        void handleDropObject();
      } else if (e.key === 'h' || e.key === 'H') {
        setConsoleOpen((v) => !v);
      } else if (e.key === 'd' || e.key === 'D') {
        void handleToggleAutoDrag();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleDropObject, handleToggleAutoDrag]);

  const handleSelectObjectMaterial = useCallback(
    (materialId: PbrMaterialId) => {
      const spec = resolvePbrMaterialSpec(materialId, customMaterials);
      setGeneratorError(null);
      setObjectConfig((prev) => ({
        ...prev,
        materialId: spec.id,
        massKg: spec.defaultMassKg,
        roughness: spec.defaultRoughness,
        hardness: spec.defaultHardness,
        elasticity: spec.defaultElasticity,
      }));
    },
    [customMaterials]
  );

  const handleGenerateAiMaterial = useCallback(async (prompt: string) => {
    setIsGeneratingMaterial(true);
    setGeneratorError(null);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 56_000);
    try {
      const response = await fetch('/api/generate-material', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => ({}))) as {
        material?: PbrMaterialSpec;
        error?: string;
      };

      if (!response.ok || !payload.material) {
        throw new Error(
          payload.error || 'No se pudo generar el material con Gemini API.'
        );
      }

      const spec = payload.material;
      sceneRef.current?.registerCustomMaterial(spec);

      setCustomMaterials((prev) => {
        const next = { ...prev, [spec.id]: spec };
        // Keep up to 4 most recent custom AI materials so the selector stays clean
        const keys = Object.keys(next);
        if (keys.length > 4) {
          delete next[keys[0]];
        }
        return next;
      });

      setObjectConfig((prev) => ({
        ...prev,
        materialId: spec.id,
        massKg: spec.defaultMassKg,
        roughness: spec.defaultRoughness,
        hardness: spec.defaultHardness,
        elasticity: spec.defaultElasticity,
      }));
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const message = isAbort
        ? 'Tiempo de espera agotado al calcular el material. Inténtalo de nuevo.'
        : err instanceof Error
          ? err.message
          : 'Error de conexión al generar el material.';
      setGeneratorError(message);
    } finally {
      window.clearTimeout(timeoutId);
      setIsGeneratingMaterial(false);
    }
  }, []);

  const handleSelectRoomMaterial = useCallback((materialId: RoomMaterialId) => {
    const spec = ROOM_MATERIALS[materialId];
    setMeasuredIrSummary(null);
    setRoomConfig((prev) => ({
      ...prev,
      materialId,
      wallAbsorption: spec.defaultAbsorption,
    }));
  }, []);

  const handleSelectRoomSize = useCallback((sizePreset: RoomSizePresetId) => {
    setMeasuredIrSummary(null);
    setRoomConfig((prev) => ({
      ...prev,
      sizePreset,
      scaleMultiplier: 1.0,
    }));
  }, []);

  const handleChangeMicHeight = useCallback((heightMeters: number) => {
    sceneRef.current?.setMicHeight(heightMeters);
  }, []);

  const handleSelectMicPreset = useCallback(
    (preset: MicPositionPresetId) => {
      const dims = roomMetrics.dimensions;
      const halfW = dims.width * 0.5;
      const halfD = dims.depth * 0.5;
      if (preset === 'front') {
        sceneRef.current?.resetMicPosition();
        return;
      }
      if (preset === 'corner') {
        // Back-left room corner: strong low-frequency standing-wave pressure antinode
        sceneRef.current?.setMicPosition(
          {
            x: -(halfW - 0.52),
            y: Math.min(1.55, dims.height - 0.45),
            z: -(halfD - 0.52),
          },
          true
        );
        return;
      }
      // Behind freestanding acoustic gobo panel: direct line-of-sight acoustic occlusion
      const occ = getRoomAcousticOccluder(dims);
      sceneRef.current?.setMicPosition(
        {
          x: Math.min(halfW - 0.55, occ.center.x + 0.55),
          y: Math.min(1.15, occ.center.y),
          z: Math.max(-(halfD - 0.55), occ.center.z - 0.72),
        },
        true
      );
    },
    [roomMetrics.dimensions]
  );

  const handleTriggerSineSweep = useCallback(async () => {
    const engine = audioEngineRef.current;
    const controller = sceneRef.current;
    if (!engine || !controller || isSweeping) return;

    setIsSweeping(true);
    setAnalyzerViewTrigger({ view: 'spectrum', nonce: Date.now() });
    const ctx = controller.getSpatialMeasurementContext();
    controller.triggerSweepVisual();

    try {
      await engine.triggerSineSweep(
        ctx.sourcePos,
        ctx.micPos,
        ctx.occluder,
        (completedSummary) => {
          setMeasuredIrSummary(completedSummary);
          setIrVersion((v) => v + 1);
          setIsSweeping(false);
          setAnalyzerViewTrigger({ view: 'ir', nonce: Date.now() + 1 });
        }
      );
      setAudioActive(engine.getIsRunning());
    } catch {
      setIsSweeping(false);
    }
  }, [isSweeping]);

  const triggerFileDownload = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1200);
  }, []);

  const handleDownloadIrWav = useCallback(() => {
    const engine = audioEngineRef.current;
    if (!engine) return;
    const { wavBuffer, filename } = engine.exportMeasuredIrWav24Bit();
    triggerFileDownload(new Blob([wavBuffer], { type: 'audio/wav' }), filename);
  }, [triggerFileDownload]);

  const handleSelectRecordingTrack = useCallback((mode: RecordingTrackMode) => {
    setRecordingTrackMode(mode);
    audioEngineRef.current?.setRecordingTrackMode(mode);
  }, []);

  const handleToggleRecording = useCallback(async () => {
    const engine = audioEngineRef.current;
    if (!engine) return;

    if (!isRecording) {
      const ok = await engine.startSessionRecording(recordingTrackMode);
      if (ok) {
        setAudioActive(true);
        setRecordingElapsedSec(0);
        setIsRecording(true);
      }
      return;
    }

    setIsRecording(false);
    const exported = await engine.stopSessionRecording();
    if (exported) {
      setLastRecordedTake({
        filename: exported.filename,
        durationSec: exported.durationSec,
        trackMode: exported.trackMode,
      });
      triggerFileDownload(new Blob([exported.wavBuffer], { type: 'audio/wav' }), exported.filename);
    }
  }, [isRecording, recordingTrackMode, triggerFileDownload]);

  const handleRedownloadLastWav = useCallback(() => {
    const exported = audioEngineRef.current?.getLastRecordingExport();
    if (!exported) return;
    triggerFileDownload(new Blob([exported.wavBuffer], { type: 'audio/wav' }), exported.filename);
  }, [triggerFileDownload]);

  const handleExportCppPreset = useCallback(() => {
    const headerContent = generateCppAcousticPresetHeader({
      objectConfig,
      materialSpec: activeMaterialSpec,
      modalBank,
      roomConfig,
      roomMetrics,
      dspConfig,
      spatialProbe,
      sampleRate: 48000,
    });
    triggerFileDownload(
      new Blob([headerContent], { type: 'text/x-c++hdr;charset=utf-8' }),
      'AcousticPreset.h'
    );
    setCppExportFlash(true);
    window.setTimeout(() => setCppExportFlash(false), 2200);
  }, [
    objectConfig,
    activeMaterialSpec,
    modalBank,
    roomConfig,
    roomMetrics,
    dspConfig,
    spatialProbe,
    triggerFileDownload,
  ]);

  const handleTriggerShockwave = useCallback(async () => {
    const engine = audioEngineRef.current;
    const controller = sceneRef.current;
    if (!engine || !controller) return;

    const ctx = controller.getSpatialMeasurementContext();
    controller.triggerShockwaveVisual();
    const result = await engine.triggerFriedlanderShockwave(
      ctx.sourcePos,
      roomMetrics.dimensions.width,
      1.18
    );
    setAudioActive(engine.getIsRunning());
    setLastShockwaveInfo({
      positivePhaseMs: result.positivePhaseMs,
      distanceCutoffHz: result.distanceCutoffHz,
      peakPositive: result.peakPositive,
      minNegative: result.minNegative,
    });
  }, [roomMetrics.dimensions.width]);

  const handleImportModelFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const controller = sceneRef.current;
      if (!controller) return;

      setIsImportingModel(true);
      setImportError(null);
      setAutoDragActive(false);

      try {
        const stats = await controller.importCustomModel(files);
        setImportedModelStats(stats);
        setObjectConfig((prev) => ({
          ...prev,
          shapeId: 'imported_mesh',
          customVolumePitchScale: stats.volumePitchScale,
          roughness:
            typeof stats.meanSampledRoughness === 'number'
              ? stats.meanSampledRoughness
              : prev.roughness,
        }));
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : 'No se pudo cargar el modelo 3D (.OBJ / .GLTF).';
        setImportError(message);
      } finally {
        setIsImportingModel(false);
        if (modelFileInputRef.current) {
          modelFileInputRef.current.value = '';
        }
      }
    },
    []
  );

  const currentMatSpec = activeMaterialSpec;
  const currentRoomSpec = ROOM_MATERIALS[roomConfig.materialId];
  const livePoissonLambda =
    dspConfig.excitationMode === 'stochastic_fracture'
      ? computePoissonLambda(
          bodyTelemetry.currentFrictionSpeed,
          objectConfig.massKg,
          bodyTelemetry.currentLocalRoughness
        )
      : 0;
  const poissonBackend = audioEngineRef.current?.getPoissonBackend() ?? 'audioworklet';

  return (
    <div
      className="h-screen w-screen flex flex-col bg-[#0b0d11] text-[#e6eaf0] overflow-hidden"
      data-audio-active={audioActive ? 'true' : 'false'}
      data-material={objectConfig.materialId}
      data-room={roomConfig.materialId}
    >
      {/* Top Studio Header — Brand + Workspace Navigation + Recording/C++ Export + Master Audio */}
      <header className="h-13 shrink-0 flex items-center justify-between gap-4 px-4 bg-[#0f131a] border-b border-white/8 z-20">
        {/* Zone 1: Single-line brand wordmark */}
        <h1 className="text-sm sm:text-base font-semibold tracking-tight text-white whitespace-nowrap shrink-0">
          Acoustic-to-3D Studio
        </h1>

        {/* Zone 2: Clean single-line workspace navigation links */}
        <nav className="flex items-center gap-4 text-xs sm:text-sm font-medium" aria-label="Módulos del motor">
          {(
            [
              { id: 'material', label: 'Material PBR' },
              { id: 'room', label: 'Acústica de Sala' },
              { id: 'dsp', label: 'Síntesis Modal' },
              { id: 'scenes', label: 'Escenas Foley' },
            ] as Array<{ id: ConsoleTabId; label: string }>
          ).map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => void handleSelectConsoleTab(tab.id)}
                className={`py-1.5 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'border-amber-500 text-white'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Studio Recording (WAV 48kHz Dry/Wet/Mix), C++20 AcousticPreset.h & Audio Engine */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Live 48kHz Foley Session Recorder */}
          <div
            className="flex items-center gap-1.5 pr-2 border-r border-white/10"
            data-testid="header-export-bar"
          >
            <div
              role="group"
              aria-label="Pista de grabación WAV"
              className="flex items-center rounded-md bg-[#121722] border border-white/10 p-0.5"
            >
              {(
                [
                  { id: 'mix', label: 'Mezcla', title: 'Exportar Mezcla Final (Seco + Reverb)' },
                  { id: 'dry', label: 'Dry', title: 'Exportar pista Seca / Dry (sin reverberación)' },
                  { id: 'wet', label: 'Wet', title: 'Exportar Solo Reverb / Wet (cola de sala)' },
                ] as Array<{ id: RecordingTrackMode; label: string; title: string }>
              ).map((opt) => {
                const active = recordingTrackMode === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    aria-pressed={active}
                    title={opt.title}
                    onClick={() => handleSelectRecordingTrack(opt.id)}
                    className={`px-2 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      active
                        ? 'bg-[#232b3b] text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              aria-pressed={isRecording}
              data-recording={isRecording ? 'true' : 'false'}
              title={
                isRecording
                  ? 'Detener grabación y descargar sesión .WAV 48kHz 24-bit'
                  : 'Grabar sesión de foley en vivo a 48 kHz (.WAV)'
              }
              onClick={() => void handleToggleRecording()}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer font-mono tabular-nums ${
                isRecording
                  ? 'bg-rose-600 border-rose-400 text-white hover:bg-rose-500'
                  : 'bg-[#1c1419] border-rose-500/45 text-rose-200 hover:bg-[#281b22]'
              }`}
            >
              {isRecording ? (
                <>
                  <Square className="w-3 h-3 fill-current" />
                  <span>
                    {String(Math.floor(recordingElapsedSec / 60)).padStart(2, '0')}:
                    {String(Math.floor(recordingElapsedSec % 60)).padStart(2, '0')}
                  </span>
                </>
              ) : (
                <>
                  <Circle className="w-3 h-3 fill-rose-500 text-rose-500" />
                  <span className="font-sans">Grabar WAV</span>
                </>
              )}
            </button>

            {lastRecordedTake && !isRecording && (
              <button
                type="button"
                data-testid="redownload-wav-btn"
                title={`Descargar nuevamente ${lastRecordedTake.filename}`}
                onClick={handleRedownloadLastWav}
                className="flex items-center gap-1 px-2 py-1.5 text-[11px] font-mono tabular-nums rounded-md bg-[#141d29] border border-sky-500/40 text-sky-200 hover:bg-[#1c293a] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-3 h-3 text-sky-300" />
                <span>{lastRecordedTake.durationSec.toFixed(1)}s</span>
              </button>
            )}
          </div>

          {/* C++20 AcousticPreset.h Native Engine Header Exporter */}
          <button
            type="button"
            data-testid="export-cpp-header-btn"
            title="Exportar AcousticPreset.h en C++20 con coeficientes biquad (48 kHz), masa, rugosidad y parámetros de sala"
            onClick={handleExportCppPreset}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              cppExportFlash
                ? 'bg-[#162922] border-emerald-400/70 text-emerald-200'
                : 'bg-[#141a24] border-white/12 text-slate-200 hover:bg-[#1c2433] hover:border-white/25'
            }`}
          >
            {cppExportFlash ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <FileCode2 className="w-3.5 h-3.5 text-sky-400" />
            )}
            <span>{cppExportFlash ? 'Exportado .h' : 'AcousticPreset.h'}</span>
          </button>

          {/* Master 48 kHz Audio Context Toggle */}
          <button
            type="button"
            onClick={() => void handleToggleAudio()}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              audioActive
                ? 'bg-amber-500 text-slate-950 hover:bg-amber-400'
                : 'bg-[#1c2331] text-amber-300 border border-amber-500/40 hover:bg-[#242d3f]'
            }`}
          >
            {audioActive ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
            <span>{audioActive ? '48 kHz Activo' : 'Audio 48 kHz'}</span>
          </button>
        </div>
      </header>

      {/* Main 3D Acoustic Viewport (Unobstructed Center) */}
      <main className="flex-1 relative min-h-0 flex flex-col">
        <div className="flex-1 relative min-h-0 bg-[#0c0f15]">
          {/* Isolated WebGL Mount Container */}
          <div ref={viewportMountRef} className="w-full h-full" />

          {/* Top-Left Physical Action Bar (contextual for Foley Scenes vs Rigid-Body Workspace) */}
          <div className="absolute top-3.5 left-4 z-10 flex flex-wrap items-center gap-2">
            {activeTab === 'scenes' ? (
              <>
                <button
                  type="button"
                  onClick={() => void handleToggleFoleyPlayback()}
                  className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-md bg-amber-500 text-slate-950 hover:bg-amber-400 transition-colors shadow-sm whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <span>{foleySceneConfig.playing ? 'Pausar Escena' : 'Reproducir Escena'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleResetFoleyScene}
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md bg-[#11151e]/95 border border-white/12 text-slate-200 hover:bg-[#19202d] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-amber-400" />
                  <span>Reiniciar</span>
                </button>

                <button
                  type="button"
                  onClick={handleResetCamera}
                  aria-label="Centrar cámara"
                  title="Centrar cámara"
                  className="flex items-center justify-center p-2 text-xs rounded-md bg-[#11151e]/95 border border-white/12 text-slate-300 hover:text-white hover:bg-[#19202d] transition-colors shrink-0 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void handleDropObject()}
                  className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-md bg-amber-500 text-slate-950 hover:bg-amber-400 transition-colors shadow-sm whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <ArrowDownToLine className="w-3.5 h-3.5" />
                  <span>Soltar Objeto</span>
                </button>

                <button
                  type="button"
                  aria-pressed={autoDragActive}
                  onClick={() => void handleToggleAutoDrag()}
                  className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    autoDragActive
                      ? 'bg-[#1a2838] border-sky-400 text-sky-200'
                      : 'bg-[#11151e]/95 border-white/12 text-slate-200 hover:bg-[#19202d]'
                  }`}
                >
                  <MoveHorizontal className="w-3.5 h-3.5" />
                  <span>{autoDragActive ? 'Detener Arrastre' : 'Arrastre Continuo'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => void handleManualImpulse()}
                  className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md bg-[#11151e]/95 border border-white/12 text-slate-200 hover:bg-[#19202d] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Zap className="w-3.5 h-3.5 text-amber-400" />
                  <span>Impulso</span>
                </button>

                <button
                  type="button"
                  onClick={handleResetCamera}
                  aria-label="Centrar cámara"
                  title="Centrar cámara"
                  className="flex items-center justify-center p-2 text-xs rounded-md bg-[#11151e]/95 border border-white/12 text-slate-300 hover:text-white hover:bg-[#19202d] transition-colors shrink-0 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>

                <input
                  ref={modelFileInputRef}
                  type="file"
                  accept=".obj,.gltf,.glb,.mtl,.bin,.png,.jpg,.jpeg,.webp"
                  multiple
                  aria-label="Seleccionar archivo de modelo 3D (.OBJ o .GLTF)"
                  data-testid="model-file-input"
                  className="hidden"
                  onChange={(e) => void handleImportModelFiles(e.target.files)}
                />
                <button
                  type="button"
                  disabled={isImportingModel}
                  onClick={() => modelFileInputRef.current?.click()}
                  className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-wait ${
                    objectConfig.shapeId === 'imported_mesh' && importedModelStats
                      ? 'bg-[#172334]/95 border-sky-400/75 text-sky-200 hover:bg-[#1e2f46]'
                      : 'bg-[#11151e]/95 border-white/12 text-slate-200 hover:bg-[#19202d]'
                  }`}
                >
                  {isImportingModel ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-300" />
                  ) : (
                    <Upload className="w-3.5 h-3.5 text-sky-400" />
                  )}
                  <span>
                    {isImportingModel
                      ? 'Importando malla...'
                      : 'Importar Modelo 3D (.OBJ / .GLTF)'}
                  </span>
                </button>
              </>
            )}
          </div>

          {importError && (
            <div
              role="alert"
              className="absolute top-14 left-4 z-10 max-w-md flex items-center justify-between gap-3 px-3 py-1.5 rounded-md bg-[#1a1116]/95 border border-rose-500/40 text-xs text-rose-300"
            >
              <span>{importError}</span>
              <button
                type="button"
                onClick={() => setImportError(null)}
                className="text-rose-200 hover:text-white font-medium cursor-pointer"
              >
                Cerrar
              </button>
            </div>
          )}

          {/* Top-Right Clean Unboxed Telemetry Readout */}
          <div
            data-testid="viewport-telemetry"
            className="hidden xl:flex absolute top-4 right-4 z-10 items-center gap-2.5 px-3 py-1.5 rounded-md bg-[#0f131a]/90 border border-white/8 text-xs font-mono tabular-nums text-slate-300 pointer-events-none"
          >
            {activeTab === 'scenes' ? (
              <>
                <span className="text-amber-300 font-medium">
                  {foleySceneConfig.sceneId === 'basketball'
                    ? 'Baloncesto'
                    : foleySceneConfig.sceneId === 'footsteps'
                      ? 'Caminata Terrenos'
                      : 'Percusión Modal'}
                </span>
                <span aria-hidden="true" className="text-slate-600">·</span>
                <span>
                  {foleySceneConfig.sceneId === 'basketball'
                    ? foleySceneConfig.basketballFloor === 'wood'
                      ? 'Parqué de Madera'
                      : 'Concreto'
                    : foleySceneConfig.sceneId === 'footsteps'
                      ? foleySceneConfig.footstepTerrain === 'gravel_branches'
                        ? 'Grava / Ramas'
                        : foleySceneConfig.footstepTerrain === 'wood'
                          ? 'Madera'
                          : foleySceneConfig.footstepTerrain === 'metal'
                            ? 'Metal'
                            : 'Vidrio'
                      : `${foleySceneConfig.percussionBpm} BPM`}
                </span>
                <span aria-hidden="true" className="text-slate-600">·</span>
                <span>RT60 {roomMetrics.rt60Seconds.toFixed(2)}s</span>
                <span aria-hidden="true" className="text-slate-600">·</span>
                <span>
                  {foleySceneConfig.sceneId === 'basketball'
                    ? `Botes: ${foleySimTelemetry.basketball.bounceCount}`
                    : foleySceneConfig.sceneId === 'footsteps'
                      ? `Pasos: ${foleySimTelemetry.footsteps.stepCount}`
                      : `Golpes: ${foleySimTelemetry.percussion.hitCount}`}
                </span>
              </>
            ) : (
              <>
                <span className="text-amber-300 font-medium">
                  {objectConfig.shapeId === 'imported_mesh' && importedModelStats
                    ? importedModelStats.fileName
                    : currentMatSpec.name}
                </span>
                <span aria-hidden="true" className="text-slate-600">·</span>
                {objectConfig.shapeId === 'imported_mesh' && importedModelStats ? (
                  <>
                    <span>Vol {importedModelStats.approximateVolumeM3.toFixed(3)}m³</span>
                    <span aria-hidden="true" className="text-slate-600">·</span>
                    <span>f₀ {modalBank[0]?.frequencyHz.toFixed(0)}Hz</span>
                    {importedModelStats.hasRoughnessMap && (
                      <>
                        <span aria-hidden="true" className="text-slate-600">·</span>
                        <span className="text-sky-300">
                          R px {bodyTelemetry.currentLocalRoughness.toFixed(2)}
                        </span>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <span>{currentRoomSpec.name}</span>
                    <span aria-hidden="true" className="text-slate-600">·</span>
                    <span>RT60 {roomMetrics.rt60Seconds.toFixed(2)}s</span>
                  </>
                )}
                <span aria-hidden="true" className="text-slate-600">·</span>
                <span>Impactos: {bodyTelemetry.impactCount}</span>
                <span aria-hidden="true" className="text-slate-600">·</span>
                <span>Fricción: {bodyTelemetry.currentFrictionSpeed.toFixed(2)} m/s</span>
              </>
            )}
          </div>

          {/* Subtle Bottom-Left Interaction Hint */}
          <div className="hidden md:block absolute bottom-3 left-4 z-10 text-[11px] text-slate-400 bg-[#0d1017]/85 px-2.5 py-1 rounded border border-white/6 pointer-events-none">
            {activeTab === 'room'
              ? 'Arrastra el micrófono en 3D (Shift para altura Y) · Detrás del gobo para oclusión · Esquinas para ondas estacionarias'
              : activeTab === 'scenes'
                ? 'Arrastra el micrófono en 3D (Shift para altura Y) · Arrastra el fondo para orbitar · Rueda para zoom'
                : 'Arrastra el objeto o el micrófono en 3D · Arrastra el fondo para orbitar · Espacio para soltar'}
          </div>

          {/* Collapsible Bottom Console Toggle Handle */}
          <button
            type="button"
            onClick={() => setConsoleOpen((v) => !v)}
            aria-expanded={consoleOpen}
            className="absolute bottom-2.5 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md bg-[#131823]/95 border border-white/12 text-slate-300 hover:text-white hover:border-white/25 transition-colors whitespace-nowrap cursor-pointer"
          >
            {consoleOpen ? (
              <>
                <ChevronDown className="w-3.5 h-3.5" />
                <span>Ocultar Consola</span>
              </>
            ) : (
              <>
                <ChevronUp className="w-3.5 h-3.5" />
                <span>Mostrar Consola</span>
              </>
            )}
          </button>
        </div>

        {/* Collapsible Bottom Studio Console (FabFilter Spectrum + PBR/Acoustics Rack) */}
        {consoleOpen && (
          <section
            aria-label="Consola de análisis y parámetros"
            className="h-[312px] sm:h-[304px] shrink-0 grid grid-cols-1 lg:grid-cols-12 bg-[#0e1219] border-t border-white/10"
          >
            <div className="lg:col-span-6 h-full min-h-0 border-b lg:border-b-0 lg:border-r border-white/8">
              <SpectrumAnalyzer
                audioEngine={audioEngineRef.current}
                audioActive={audioActive}
                modalBank={modalBank}
                rt60Seconds={roomMetrics.rt60Seconds}
                irVersion={irVersion}
                measuredIrSummary={measuredIrSummary}
                viewTrigger={analyzerViewTrigger}
              />
            </div>
            <div className="lg:col-span-6 h-full min-h-0">
              <ControlRack
                activeTab={activeTab}
                objectConfig={objectConfig}
                activeMaterialSpec={activeMaterialSpec}
                customMaterials={customMaterialList}
                isGeneratingMaterial={isGeneratingMaterial}
                generatorError={generatorError}
                roomConfig={roomConfig}
                dspConfig={dspConfig}
                roomMetrics={roomMetrics}
                spatialProbe={spatialProbe}
                isSweeping={isSweeping}
                measuredIrSummary={measuredIrSummary}
                modalBank={modalBank}
                importedModelStats={importedModelStats}
                liveLocalRoughness={bodyTelemetry.currentLocalRoughness}
                liveRoughnessSource={bodyTelemetry.currentRoughnessSource}
                livePoissonLambda={livePoissonLambda}
                poissonBackend={poissonBackend}
                lastShockwaveInfo={lastShockwaveInfo}
                onSelectObjectMaterial={handleSelectObjectMaterial}
                onGenerateAiMaterial={handleGenerateAiMaterial}
                onChangeObjectConfig={(patch) =>
                  setObjectConfig((prev) => ({ ...prev, ...patch }))
                }
                onSelectRoomMaterial={handleSelectRoomMaterial}
                onSelectRoomSize={handleSelectRoomSize}
                onChangeRoomConfig={(patch) => {
                  setMeasuredIrSummary(null);
                  setRoomConfig((prev) => ({ ...prev, ...patch }));
                }}
                onChangeMicHeight={handleChangeMicHeight}
                onSelectMicPreset={handleSelectMicPreset}
                onTriggerSineSweep={handleTriggerSineSweep}
                onDownloadIrWav={handleDownloadIrWav}
                onTriggerShockwave={handleTriggerShockwave}
                onChangeDspConfig={(patch) =>
                  setDspConfig((prev) => ({ ...prev, ...patch }))
                }
                foleySceneConfig={foleySceneConfig}
                foleySceneTelemetry={{
                  eventLabel: foleySimTelemetry.lastEventLabel,
                  bounceCount: foleySimTelemetry.basketball.bounceCount,
                  lastImpactVelocity: foleySimTelemetry.basketball.lastImpactVelocity,
                  stepCount: foleySimTelemetry.footsteps.stepCount,
                  percussionHits: foleySimTelemetry.percussion.hitCount,
                  lastInstrument: foleySimTelemetry.percussion.lastInstrument,
                }}
                onChangeFoleySceneConfig={handleChangeFoleySceneConfig}
                onToggleFoleyPlayback={handleToggleFoleyPlayback}
                onResetFoleyScene={handleResetFoleyScene}
              />
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
