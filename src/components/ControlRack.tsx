import React, { useState } from 'react';
import { AudioWaveform, Download, Flame, Loader2, Pause, Play, RotateCcw, Wand2 } from 'lucide-react';
import { getFootstepCadenceHz } from '../engine/foleyScenes';
import { PBR_MATERIAL_LIST, ROOM_MATERIAL_LIST, ROOM_SIZE_LIST } from '../engine/materials';
import {
  computeDualHertzPartition,
  computeShockwaveDistanceCutoffHz,
  PHYSICAL_EXCITATION_MODES,
  type FriedlanderShockwaveResult,
} from '../engine/physicalExcitation';
import type {
  BasketballCadenceId,
  BasketballFloorId,
  ConsoleTabId,
  DspEngineConfig,
  FoleySceneConfig,
  FoleySceneId,
  FootstepTerrainId,
  ImportedModelStats,
  MeasuredIrSummary,
  ModalPartial,
  ObjectPhysicsConfig,
  ObjectShapeId,
  PbrMaterialId,
  PbrMaterialSpec,
  RoomAcousticConfig,
  RoomAcousticMetrics,
  RoomMaterialId,
  RoomSizePresetId,
  SpatialAcousticProbe,
} from '../engine/types';
import { StudioSlider } from './StudioSlider';

export type MicPositionPresetId = 'front' | 'corner' | 'occluded';

interface ControlRackProps {
  activeTab: ConsoleTabId;
  objectConfig: ObjectPhysicsConfig;
  activeMaterialSpec: PbrMaterialSpec;
  customMaterials: PbrMaterialSpec[];
  isGeneratingMaterial: boolean;
  generatorError: string | null;
  roomConfig: RoomAcousticConfig;
  dspConfig: DspEngineConfig;
  roomMetrics: RoomAcousticMetrics;
  spatialProbe: SpatialAcousticProbe;
  isSweeping: boolean;
  measuredIrSummary: MeasuredIrSummary | null;
  modalBank: ModalPartial[];
  importedModelStats: ImportedModelStats | null;
  liveLocalRoughness: number;
  liveRoughnessSource?: 'procedural' | 'pbr_texture';
  livePoissonLambda: number;
  poissonBackend: 'audioworklet' | 'buffer';
  lastShockwaveInfo: Pick<
    FriedlanderShockwaveResult,
    'positivePhaseMs' | 'distanceCutoffHz' | 'peakPositive' | 'minNegative'
  > | null;
  onSelectObjectMaterial: (id: PbrMaterialId) => void;
  onGenerateAiMaterial: (prompt: string) => Promise<void>;
  onChangeObjectConfig: (patch: Partial<ObjectPhysicsConfig>) => void;
  onSelectRoomMaterial: (id: RoomMaterialId) => void;
  onSelectRoomSize: (id: RoomSizePresetId) => void;
  onChangeRoomConfig: (patch: Partial<RoomAcousticConfig>) => void;
  onChangeMicHeight: (heightMeters: number) => void;
  onSelectMicPreset: (preset: MicPositionPresetId) => void;
  onTriggerSineSweep: () => Promise<void>;
  onDownloadIrWav: () => void;
  onTriggerShockwave: () => Promise<void>;
  onChangeDspConfig: (patch: Partial<DspEngineConfig>) => void;
  foleySceneConfig: FoleySceneConfig;
  foleySceneTelemetry: {
    eventLabel: string;
    bounceCount: number;
    lastImpactVelocity: number;
    stepCount: number;
    percussionHits: number;
    lastInstrument: 'snare' | 'cymbal' | 'woodblock';
  };
  onChangeFoleySceneConfig: (patch: Partial<FoleySceneConfig>) => void;
  onToggleFoleyPlayback: () => Promise<void>;
  onResetFoleyScene: () => void;
}

const SHAPE_OPTIONS: Array<{ id: ObjectShapeId; label: string }> = [
  { id: 'resonator_block', label: 'Bloque' },
  { id: 'acoustic_cylinder', label: 'Cilindro' },
  { id: 'composite_orb', label: 'Esfera' },
];

const AI_MATERIAL_PRESETS = [
  'Cerámica hueca',
  'Plástico hueco',
  'Hielo',
  'Lámina de acero',
];

export const ControlRack: React.FC<ControlRackProps> = ({
  activeTab,
  objectConfig,
  activeMaterialSpec,
  customMaterials,
  isGeneratingMaterial,
  generatorError,
  roomConfig,
  dspConfig,
  roomMetrics,
  spatialProbe,
  isSweeping,
  measuredIrSummary,
  modalBank,
  importedModelStats,
  liveLocalRoughness,
  liveRoughnessSource,
  livePoissonLambda,
  poissonBackend,
  lastShockwaveInfo,
  onSelectObjectMaterial,
  onGenerateAiMaterial,
  onChangeObjectConfig,
  onSelectRoomMaterial,
  onSelectRoomSize,
  onChangeRoomConfig,
  onChangeMicHeight,
  onSelectMicPreset,
  onTriggerSineSweep,
  onDownloadIrWav,
  onTriggerShockwave,
  onChangeDspConfig,
  foleySceneConfig,
  foleySceneTelemetry,
  onChangeFoleySceneConfig,
  onToggleFoleyPlayback,
  onResetFoleyScene,
}) => {
  const [aiPrompt, setAiPrompt] = useState('');

  const handleSubmitAi = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = aiPrompt.trim();
    if (!cleaned || isGeneratingMaterial) return;
    void onGenerateAiMaterial(cleaned);
  };

  if (activeTab === 'material') {
    const allMaterials: PbrMaterialSpec[] = [...PBR_MATERIAL_LIST, ...customMaterials];

    return (
      <div className="flex flex-col h-full justify-between px-4 py-3 gap-2.5 overflow-y-auto">
        {/* Material Selector + Geometry Switcher */}
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div
            className="flex items-center gap-1.5 min-w-0 flex-1 overflow-x-auto pb-0.5"
            role="group"
            aria-label="Material PBR del objeto"
          >
            {allMaterials.map((mat) => {
              const selected = objectConfig.materialId === mat.id;
              return (
                <button
                  key={mat.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelectObjectMaterial(mat.id)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    selected
                      ? 'bg-[#202736] border-amber-500/80 text-white'
                      : 'bg-[#12161f] border-white/8 text-slate-300 hover:border-white/20 hover:text-white'
                  }`}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-xs shrink-0"
                    style={{ backgroundColor: mat.swatchColor }}
                    aria-hidden="true"
                  />
                  <span>{mat.name}</span>
                </button>
              );
            })}
          </div>

          <div
            className="flex items-center gap-1 bg-[#12161f] p-0.5 rounded-md border border-white/8 shrink-0"
            role="group"
            aria-label="Geometría del objeto"
          >
            {[
              ...SHAPE_OPTIONS,
              ...(importedModelStats
                ? [{ id: 'imported_mesh' as ObjectShapeId, label: 'Malla 3D' }]
                : []),
            ].map((shape) => {
              const selected = objectConfig.shapeId === shape.id;
              return (
                <button
                  key={shape.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onChangeObjectConfig({ shapeId: shape.id })}
                  className={`px-2 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    selected
                      ? 'bg-[#222938] text-amber-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {shape.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Generador de Material IA */}
        <form
          onSubmit={handleSubmitAi}
          aria-label="Generador de Material IA"
          className="flex flex-col gap-1.5 py-2 border-y border-white/8"
        >
          <div className="flex items-center gap-2">
            <label
              htmlFor="ai-material-input"
              className="text-xs font-medium text-slate-300 whitespace-nowrap shrink-0"
            >
              Generador de Material IA
            </label>
            <input
              id="ai-material-input"
              type="text"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              maxLength={100}
              disabled={isGeneratingMaterial}
              placeholder="Ej. cerámica hueca, plástico hueco, hielo, lámina de acero..."
              className="flex-1 min-w-0 h-8 px-2.5 text-xs rounded-md bg-[#0a0d13] border border-white/12 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-amber-500/80 disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={isGeneratingMaterial || aiPrompt.trim().length < 2}
              className="flex items-center gap-1.5 h-8 px-3 text-xs font-semibold rounded-md bg-amber-500 text-slate-950 hover:bg-amber-400 disabled:bg-[#1b212d] disabled:text-slate-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed"
            >
              {isGeneratingMaterial ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Calculando...</span>
                </>
              ) : (
                <>
                  <Wand2 className="w-3.5 h-3.5" />
                  <span>Generar</span>
                </>
              )}
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <div className="flex items-center gap-1.5 text-slate-400 overflow-x-auto">
              <span className="text-slate-500 whitespace-nowrap">Sugerencias:</span>
              {AI_MATERIAL_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  disabled={isGeneratingMaterial}
                  onClick={() => {
                    setAiPrompt(preset);
                    void onGenerateAiMaterial(preset);
                  }}
                  className="text-slate-300 hover:text-amber-300 underline-offset-2 hover:underline transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>

          {generatorError && (
            <div
              role="alert"
              className="flex items-center justify-between gap-2 text-[11px] leading-snug text-rose-400"
            >
              <span>{generatorError}</span>
              {aiPrompt.trim().length >= 2 && (
                <button
                  type="button"
                  disabled={isGeneratingMaterial}
                  onClick={() => void onGenerateAiMaterial(aiPrompt.trim())}
                  className="text-amber-300 hover:text-amber-200 font-medium underline underline-offset-2 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Reintentar
                </button>
              )}
            </div>
          )}
        </form>

        {/* Physical PBR Sliders */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          <StudioSlider
            id="slider-mass"
            label="Masa física"
            value={objectConfig.massKg}
            min={0.4}
            max={18}
            step={0.1}
            formatValue={(v) => `${v.toFixed(1)} kg`}
            onChange={(massKg) => onChangeObjectConfig({ massKg })}
          />
          <StudioSlider
            id="slider-roughness"
            label="Rugosidad PBR (Fricción)"
            value={objectConfig.roughness}
            min={0.04}
            max={1.0}
            step={0.01}
            formatValue={(v) => v.toFixed(2)}
            onChange={(roughness) => onChangeObjectConfig({ roughness })}
          />
          <StudioSlider
            id="slider-hardness"
            label="Dureza / Rigidez"
            value={objectConfig.hardness}
            min={0.15}
            max={1.0}
            step={0.01}
            formatValue={(v) => `${Math.round(v * 100)}%`}
            onChange={(hardness) => onChangeObjectConfig({ hardness })}
          />
          <StudioSlider
            id="slider-elasticity"
            label="Elasticidad (Rebote)"
            value={objectConfig.elasticity}
            min={0.08}
            max={0.88}
            step={0.01}
            formatValue={(v) => v.toFixed(2)}
            onChange={(elasticity) => onChangeObjectConfig({ elasticity })}
          />
        </div>

        {/* Unboxed Technical Acoustic Summary (or Imported 3D Mesh BBox/Volume/PBR Roughness Readout) */}
        <div
          data-testid="material-spec-footer"
          className="flex items-center justify-between gap-3 pt-1.5 border-t border-white/8 text-[11px] text-slate-400"
        >
          {objectConfig.shapeId === 'imported_mesh' && importedModelStats ? (
            <>
              <span className="truncate font-mono tabular-nums">
                BBox:{' '}
                <strong className="text-slate-200">
                  {importedModelStats.rawBoundingBox.x.toFixed(2)}×
                  {importedModelStats.rawBoundingBox.y.toFixed(2)}×
                  {importedModelStats.rawBoundingBox.z.toFixed(2)}
                </strong>
                {' · '}
                Vol:{' '}
                <strong className="text-amber-300">
                  {importedModelStats.approximateVolumeM3.toFixed(3)} m³
                </strong>
                {' · '}
                f₀:{' '}
                <strong className="text-slate-200">
                  {modalBank[0]?.frequencyHz.toFixed(0)} Hz
                </strong>{' '}
                (×{importedModelStats.volumePitchScale.toFixed(2)})
              </span>
              <span className="truncate font-mono tabular-nums shrink-0">
                {importedModelStats.hasRoughnessMap ? (
                  <strong className="text-sky-300">
                    Roughness PBR px: {liveLocalRoughness.toFixed(2)}
                    {liveRoughnessSource === 'pbr_texture' ? ' (Vivo)' : ''}
                  </strong>
                ) : (
                  <span className="text-slate-400">
                    {importedModelStats.fileName} · {importedModelStats.triangleCount} tri
                  </span>
                )}
              </span>
            </>
          ) : (
            <>
              <span className="truncate font-mono tabular-nums">
                Densidad:{' '}
                <strong className="text-slate-200">{activeMaterialSpec.densityKgM3} kg/m³</strong>
                {' · '}
                Fundamental:{' '}
                <strong className="text-slate-200">{modalBank[0]?.frequencyHz.toFixed(0)} Hz</strong>
                {' · '}
                Modos: <strong className="text-sky-300">{modalBank.length}</strong>
              </span>
              <span
                className="truncate text-slate-400 max-w-[260px]"
                title={activeMaterialSpec.acousticNotes || activeMaterialSpec.subtitle}
              >
                {activeMaterialSpec.acousticNotes || activeMaterialSpec.subtitle}
              </span>
            </>
          )}
        </div>
      </div>
    );
  }

  if (activeTab === 'room') {
    const maxMicHeight = Math.max(1.2, Number((roomMetrics.dimensions.height - 0.35).toFixed(2)));
    const domWave = spatialProbe.dominantStandingWave;
    const isOccluded = spatialProbe.occlusionFactor > 0.08;

    return (
      <div className="flex flex-col h-full justify-between px-4 py-3 gap-2 overflow-y-auto">
        {/* Room Material & Size Switcher */}
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div
            className="flex items-center gap-1.5 min-w-0 flex-1 overflow-x-auto pb-0.5"
            role="group"
            aria-label="Material de paredes"
          >
            {ROOM_MATERIAL_LIST.map((mat) => {
              const selected = roomConfig.materialId === mat.id;
              return (
                <button
                  key={mat.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelectRoomMaterial(mat.id)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    selected
                      ? 'bg-[#202736] border-amber-500/80 text-white'
                      : 'bg-[#12161f] border-white/8 text-slate-300 hover:border-white/20 hover:text-white'
                  }`}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-xs shrink-0"
                    style={{ backgroundColor: mat.swatchColor }}
                    aria-hidden="true"
                  />
                  <span>{mat.name}</span>
                </button>
              );
            })}
          </div>

          <div
            className="flex items-center gap-1 bg-[#12161f] p-0.5 rounded-md border border-white/8 shrink-0"
            role="group"
            aria-label="Tamaño de la habitación"
          >
            {ROOM_SIZE_LIST.map((preset) => {
              const selected = roomConfig.sizePreset === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelectRoomSize(preset.id)}
                  className={`px-2 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    selected
                      ? 'bg-[#222938] text-amber-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {preset.name}
                </button>
              );
            })}
          </div>
        </div>

        {/* Acoustic Sliders + Mic Height Y */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2">
          <StudioSlider
            id="slider-wall-absorption"
            label="Absorción (α)"
            value={roomConfig.wallAbsorption}
            min={0.04}
            max={0.94}
            step={0.01}
            formatValue={(v) => `${Math.round(v * 100)}%`}
            onChange={(wallAbsorption) => onChangeRoomConfig({ wallAbsorption })}
          />
          <StudioSlider
            id="slider-room-scale"
            label="Escala sala"
            value={roomConfig.scaleMultiplier}
            min={0.65}
            max={1.55}
            step={0.05}
            formatValue={(v) => `${v.toFixed(2)}×`}
            onChange={(scaleMultiplier) => onChangeRoomConfig({ scaleMultiplier })}
          />
          <StudioSlider
            id="slider-dry-wet"
            label="Dry / Wet"
            value={roomConfig.dryWet}
            min={0}
            max={1}
            step={0.01}
            formatValue={(v) => `${Math.round(v * 100)}%`}
            onChange={(dryWet) => onChangeRoomConfig({ dryWet })}
          />
          <StudioSlider
            id="slider-mic-height"
            label="Altura mic (Y)"
            value={Math.min(maxMicHeight, spatialProbe.micPosition.y)}
            min={0.35}
            max={maxMicHeight}
            step={0.05}
            formatValue={(v) => `${v.toFixed(2)} m`}
            onChange={onChangeMicHeight}
          />
        </div>

        {/* Spatial Microphone Measurement & Sine Sweep (20Hz-20kHz) / 24-bit 48kHz WAV Export */}
        <div className="flex flex-col gap-1.5 py-2 border-y border-white/8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[11px] text-slate-400">
              <span className="text-slate-300 font-medium whitespace-nowrap">Mic 3D:</span>
              <button
                type="button"
                onClick={() => onSelectMicPreset('front')}
                className="text-slate-300 hover:text-sky-300 underline-offset-2 hover:underline transition-colors whitespace-nowrap cursor-pointer"
              >
                Frente
              </button>
              <button
                type="button"
                onClick={() => onSelectMicPreset('corner')}
                className="text-slate-300 hover:text-sky-300 underline-offset-2 hover:underline transition-colors whitespace-nowrap cursor-pointer"
              >
                Esquina (Ondas est.)
              </button>
              <button
                type="button"
                onClick={() => onSelectMicPreset('occluded')}
                className="text-slate-300 hover:text-amber-300 underline-offset-2 hover:underline transition-colors whitespace-nowrap cursor-pointer"
              >
                Detrás Gobo (Oclusión)
              </button>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={isSweeping}
                onClick={() => void onTriggerSineSweep()}
                className="flex items-center gap-1.5 h-8 px-3 text-xs font-semibold rounded-md bg-amber-500 text-slate-950 hover:bg-amber-400 disabled:bg-[#232a38] disabled:text-amber-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-wait"
              >
                {isSweeping ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Barrido 20Hz–20kHz...</span>
                  </>
                ) : (
                  <>
                    <AudioWaveform className="w-3.5 h-3.5" />
                    <span>Disparar Sine Sweep</span>
                  </>
                )}
              </button>

              <button
                type="button"
                disabled={!measuredIrSummary || isSweeping}
                onClick={onDownloadIrWav}
                title="Descargar Respuesta al Impulso en formato .WAV estéreo 24-bit / 48 kHz"
                className={`flex items-center gap-1.5 h-8 px-3 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                  measuredIrSummary && !isSweeping
                    ? 'bg-[#172334] border-sky-400/70 text-sky-200 hover:bg-[#1e2f46] cursor-pointer'
                    : 'bg-[#12161f] border-white/8 text-slate-500 cursor-not-allowed'
                }`}
              >
                <Download className="w-3.5 h-3.5" />
                <span>Descargar IR (.WAV)</span>
              </button>
            </div>
          </div>

          <div
            data-testid="spatial-probe-readout"
            className="flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-slate-400 overflow-x-auto whitespace-nowrap"
          >
            <span>
              Pos{' '}
              <strong className="text-sky-300">
                ({spatialProbe.micPosition.x.toFixed(1)}, {spatialProbe.micPosition.y.toFixed(1)},{' '}
                {spatialProbe.micPosition.z.toFixed(1)})m
              </strong>
            </span>
            <span>
              Haas{' '}
              <strong className="text-slate-200">
                Δt {spatialProbe.haasDeltaMs.toFixed(1)}ms
              </strong>{' '}
              (ITD {spatialProbe.haasItdMs >= 0 ? '+' : ''}
              {spatialProbe.haasItdMs.toFixed(2)}ms)
            </span>
            <span>
              Modo{' '}
              <strong className={domWave.gainDb > 2 ? 'text-amber-300' : 'text-slate-200'}>
                {Math.round(domWave.frequencyHz)}Hz ({domWave.gainDb >= 0 ? '+' : ''}
                {domWave.gainDb.toFixed(1)}dB)
              </strong>
            </span>
            <span>
              Oclusión{' '}
              <strong className={isOccluded ? 'text-rose-400' : 'text-emerald-400'}>
                {isOccluded
                  ? `${spatialProbe.occlusionAttenuationDb.toFixed(1)}dB (${spatialProbe.occlusionCutoffHz}Hz)`
                  : 'Libre'}
              </strong>
            </span>
          </div>
        </div>

        {/* Room Eyring-Sabine Metrics Footer */}
        <div
          data-testid="room-metrics-bar"
          className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 font-mono tabular-nums"
        >
          <span>
            RT60: <strong className="text-sky-300">{roomMetrics.rt60Seconds.toFixed(2)} s</strong>
          </span>
          <span>
            Volumen: <strong className="text-slate-200">{roomMetrics.volumeM3.toFixed(0)} m³</strong>
          </span>
          <span>
            D/R: <strong className="text-slate-200">{spatialProbe.drRatioDb >= 0 ? '+' : ''}{spatialProbe.drRatioDb.toFixed(1)} dB</strong>
          </span>
          <span>
            {measuredIrSummary ? (
              <strong className="text-amber-300">
                IR 24-bit/48kHz lista ({measuredIrSummary.durationSec.toFixed(2)}s)
              </strong>
            ) : (
              <>
                1ª Reflexión:{' '}
                <strong className="text-slate-200">
                  {roomMetrics.earlyReflectionMs.toFixed(1)} ms
                </strong>
              </>
            )}
          </span>
        </div>
      </div>
    );
  }

  if (activeTab === 'scenes') {
    const SCENE_OPTIONS: Array<{ id: FoleySceneId; label: string }> = [
      { id: 'basketball', label: 'Baloncesto' },
      { id: 'footsteps', label: 'Caminata Terrenos' },
      { id: 'percussion', label: 'Percusión Modal' },
    ];

    const CADENCE_OPTIONS: Array<{ id: BasketballCadenceId; label: string }> = [
      { id: 'slow_dribble', label: 'Dribble lento' },
      { id: 'fast_crossover', label: 'Crossover rápido' },
      { id: 'free_throw', label: 'Lanzamiento libre' },
    ];

    const FLOOR_OPTIONS: Array<{ id: BasketballFloorId; label: string }> = [
      { id: 'wood', label: 'Parqué de Madera' },
      { id: 'concrete', label: 'Concreto' },
    ];

    const TERRAIN_OPTIONS: Array<{ id: FootstepTerrainId; label: string }> = [
      { id: 'wood', label: 'Madera' },
      { id: 'gravel_branches', label: 'Grava / Ramas' },
      { id: 'metal', label: 'Metal' },
      { id: 'glass', label: 'Vidrio' },
    ];

    const stepRateHz = getFootstepCadenceHz(foleySceneConfig.footstepSpeed);
    const gaitLabel =
      foleySceneConfig.footstepSpeed < 0.35
        ? 'Caminar'
        : foleySceneConfig.footstepSpeed < 0.7
          ? 'Trote'
          : 'Correr';

    return (
      <div className="flex flex-col h-full justify-between px-4 py-2.5 gap-2 overflow-y-auto">
        {/* Row 1: Animated 3D Scene Selector + Play/Pause + Reset */}
        <div className="flex items-center justify-between gap-2 pb-2 border-b border-white/8 min-w-0">
          <div
            className="flex items-center gap-1.5 min-w-0 flex-1 overflow-x-auto"
            role="group"
            aria-label="Selector de Escenas Foley"
          >
            {SCENE_OPTIONS.map((sc) => {
              const active = foleySceneConfig.sceneId === sc.id;
              return (
                <button
                  key={sc.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onChangeFoleySceneConfig({ sceneId: sc.id, enabled: true })}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active
                      ? 'bg-[#1f2633] border-amber-500/80 text-white'
                      : 'bg-[#12161f] border-white/8 text-slate-400 hover:text-slate-200 hover:border-white/20'
                  }`}
                >
                  {sc.label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              data-testid="foley-play-toggle"
              aria-pressed={foleySceneConfig.playing}
              onClick={() => void onToggleFoleyPlayback()}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                foleySceneConfig.playing
                  ? 'bg-amber-500 border-amber-400 text-slate-950 hover:bg-amber-400'
                  : 'bg-[#1a2230] border-white/15 text-slate-200 hover:bg-[#222d3f]'
              }`}
            >
              {foleySceneConfig.playing ? (
                <>
                  <Pause className="w-3.5 h-3.5" />
                  <span>Pausar</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" />
                  <span>Reproducir</span>
                </>
              )}
            </button>
            <button
              type="button"
              title="Reiniciar escena"
              aria-label="Reiniciar escena"
              onClick={onResetFoleyScene}
              className="flex items-center justify-center p-1.5 text-xs rounded-md bg-[#12161f] border border-white/10 text-slate-300 hover:text-white hover:border-white/25 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Row 2: Scene-Specific Interactive Physics & Material Controls */}
        {foleySceneConfig.sceneId === 'basketball' && (
          <div className="flex flex-col gap-2.5 flex-1 justify-center">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-slate-300">
                  Cadencia de Dribbling
                </span>
                <div className="flex items-center gap-1.5" role="group" aria-label="Cadencia de baloncesto">
                  {CADENCE_OPTIONS.map((cad) => {
                    const active = foleySceneConfig.basketballCadence === cad.id;
                    return (
                      <button
                        key={cad.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onChangeFoleySceneConfig({ basketballCadence: cad.id })}
                        className={`px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          active
                            ? 'bg-[#2a1d13] border-orange-400 text-orange-200'
                            : 'bg-[#12161f] border-white/8 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {cad.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-slate-300">
                  Suelo de Cancha
                </span>
                <div className="flex items-center gap-1.5" role="group" aria-label="Suelo de baloncesto">
                  {FLOOR_OPTIONS.map((fl) => {
                    const active = foleySceneConfig.basketballFloor === fl.id;
                    return (
                      <button
                        key={fl.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onChangeFoleySceneConfig({ basketballFloor: fl.id })}
                        className={`px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          active
                            ? 'bg-[#1a2636] border-sky-400/80 text-sky-200'
                            : 'bg-[#12161f] border-white/8 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {fl.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 px-3 py-2 rounded-md bg-[#11151e] border border-white/8 text-[11px] font-mono tabular-nums">
              <div>
                <span className="text-slate-400 block">Síntesis Activa</span>
                <strong className="text-amber-300">Cavidad 850 Hz (+20 ms)</strong>
              </div>
              <div>
                <span className="text-slate-400 block">Último Impacto</span>
                <strong className="text-sky-300">
                  {foleySceneTelemetry.lastImpactVelocity.toFixed(2)} m/s
                </strong>
              </div>
              <div>
                <span className="text-slate-400 block">Botes</span>
                <strong className="text-white">{foleySceneTelemetry.bounceCount}</strong>
              </div>
            </div>
          </div>
        )}

        {foleySceneConfig.sceneId === 'footsteps' && (
          <div className="flex flex-col gap-2.5 flex-1 justify-center">
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-slate-300">
                Losa de Terreno Intercambiable
              </span>
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Terreno de caminata">
                {TERRAIN_OPTIONS.map((tr) => {
                  const active = foleySceneConfig.footstepTerrain === tr.id;
                  return (
                    <button
                      key={tr.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => onChangeFoleySceneConfig({ footstepTerrain: tr.id })}
                      className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        active
                          ? tr.id === 'gravel_branches'
                            ? 'bg-[#1b2819] border-lime-400/80 text-lime-200'
                            : 'bg-[#1a2636] border-sky-400/80 text-sky-200'
                          : 'bg-[#12161f] border-white/8 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {tr.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-[1.4fr_1fr] gap-4 items-center">
              <StudioSlider
                id="slider-footstep-speed"
                label="Velocidad de Marcha (Caminar vs. Correr)"
                value={foleySceneConfig.footstepSpeed}
                min={0}
                max={1}
                step={0.02}
                formatValue={() => `${gaitLabel} (${stepRateHz.toFixed(2)} Hz)`}
                onChange={(footstepSpeed) => onChangeFoleySceneConfig({ footstepSpeed })}
              />
              <div className="px-3 py-2 rounded-md bg-[#11151e] border border-white/8 text-[11px] font-mono tabular-nums">
                <div className="text-slate-400">
                  Motor:{' '}
                  <strong className="text-amber-300">
                    {foleySceneConfig.footstepTerrain === 'gravel_branches'
                      ? 'Fractura Poisson'
                      : 'Dual Hertz'}
                  </strong>
                </div>
                <div className="text-slate-400">
                  Pasos Heel-to-Toe:{' '}
                  <strong className="text-white">{foleySceneTelemetry.stepCount}</strong>
                </div>
              </div>
            </div>
          </div>
        )}

        {foleySceneConfig.sceneId === 'percussion' && (
          <div className="flex flex-col gap-2.5 flex-1 justify-center">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
              <StudioSlider
                id="slider-percussion-bpm"
                label="Tempo del Ritmo (BPM)"
                value={foleySceneConfig.percussionBpm}
                min={75}
                max={160}
                step={1}
                formatValue={(v) => `${Math.round(v)} BPM`}
                onChange={(percussionBpm) => onChangeFoleySceneConfig({ percussionBpm })}
              />
              <div className="px-3 py-2 rounded-md bg-[#11151e] border border-white/8 text-[11px] font-mono tabular-nums">
                <span className="text-slate-400 block">Baquetas Dual-Mode</span>
                <strong className="text-amber-300">
                  Golpes: {foleySceneTelemetry.percussionHits}
                </strong>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { id: 'snare', label: 'Caja / Membrana', sub: '215Hz + Bordonera' },
                  { id: 'cymbal', label: 'Plato Metálico', sub: '8 Modos Bronce' },
                  { id: 'woodblock', label: 'Bloque de Madera', sub: 'Cavidad 742Hz' },
                ] as const
              ).map((inst) => {
                const isLast = foleySceneTelemetry.lastInstrument === inst.id;
                return (
                  <div
                    key={inst.id}
                    className={`px-2.5 py-1.5 rounded-md border text-[11px] transition-colors ${
                      isLast
                        ? 'bg-[#1c2331] border-amber-500/80 text-white'
                        : 'bg-[#11151e] border-white/8 text-slate-400'
                    }`}
                  >
                    <div className="font-medium truncate">{inst.label}</div>
                    <div className="text-[10px] font-mono text-slate-400">{inst.sub}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Row 3: Shared Spatial Mic & Acoustic Ray Readout */}
        <div
          data-testid="foley-scene-status"
          className="flex items-center justify-between pt-2 border-t border-white/8 text-[11px] font-mono tabular-nums text-slate-400"
        >
          <span>
            Evento:{' '}
            <strong className="text-amber-300">{foleySceneTelemetry.eventLabel}</strong>
          </span>
          <span>
            Micrófono 3D:{' '}
            <strong className="text-sky-300">
              {spatialProbe.directDistanceM.toFixed(2)}m · ITD{' '}
              {spatialProbe.haasItdMs >= 0 ? '+' : ''}
              {spatialProbe.haasItdMs.toFixed(2)}ms
            </strong>
          </span>
        </div>
      </div>
    );
  }

  // DSP & Modal Synthesis Bank Inspector (4 Physical Excitation Engines + 8/12 modal bank)
  const hertzPartition = computeDualHertzPartition(objectConfig.hardness, roomConfig.materialId);
  const liveShockCutoffHz = computeShockwaveDistanceCutoffHz(spatialProbe.directDistanceM);
  const activeModeSpec =
    PHYSICAL_EXCITATION_MODES.find((m) => m.id === dspConfig.excitationMode) ??
    PHYSICAL_EXCITATION_MODES[0];

  return (
    <div className="flex flex-col h-full justify-between px-4 py-2.5 gap-2 overflow-y-auto">
      {/* Row 1: Physical Excitation Engine Selector (4 real-time 48kHz engines) */}
      <div className="flex flex-col gap-1.5 pb-2 border-b border-white/8">
        <div className="flex items-center justify-between gap-2 min-w-0">
          <span className="text-[11px] font-medium text-slate-300 whitespace-nowrap shrink-0">
            Modo de Excitación Física
          </span>
          <div
            data-testid="excitation-telemetry"
            className="flex items-center gap-2 text-[11px] font-mono tabular-nums text-slate-400 truncate"
          >
            {dspConfig.excitationMode === 'dual_hertz' && (
              <span>
                Obj{' '}
                <strong className="text-amber-300">
                  {Math.round(hertzPartition.objectEnergyShare * 100)}%
                </strong>{' '}
                / {hertzPartition.surfaceName}{' '}
                <strong className="text-sky-300">
                  {Math.round(hertzPartition.surfaceEnergyShare * 100)}%
                </strong>{' '}
                · τ {hertzPartition.hertzContactMs.toFixed(1)}ms
              </span>
            )}
            {dspConfig.excitationMode === 'elastic_cavity' && (
              <span>
                Cavidad <strong className="text-amber-300">850 Hz</strong> · Env{' '}
                <strong className="text-sky-300">+20 ms</strong> · Elast{' '}
                {Math.round(objectConfig.elasticity * 100)}%
              </span>
            )}
            {dspConfig.excitationMode === 'stochastic_fracture' && (
              <span>
                {poissonBackend === 'audioworklet' ? 'AudioWorklet 48kHz' : 'Buffer 48kHz'} · λ{' '}
                <strong className="text-amber-300">{Math.round(livePoissonLambda)}/s</strong> · R{' '}
                {liveLocalRoughness.toFixed(2)}
              </span>
            )}
            {dspConfig.excitationMode === 'friedlander_shockwave' && (
              <span>
                LP{' '}
                <strong className="text-amber-300">
                  {lastShockwaveInfo?.distanceCutoffHz ?? liveShockCutoffHz} Hz
                </strong>{' '}
                · Dist {spatialProbe.directDistanceM.toFixed(1)}m
                {lastShockwaveInfo
                  ? ` · t+ ${lastShockwaveInfo.positivePhaseMs.toFixed(1)}ms · Dep ${lastShockwaveInfo.minNegative.toFixed(2)}`
                  : ''}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 min-w-0">
          <div
            className="flex items-center gap-1.5 min-w-0 flex-1 overflow-x-auto"
            role="group"
            aria-label="Modo de Excitación Física"
          >
            {PHYSICAL_EXCITATION_MODES.map((mode) => {
              const active = dspConfig.excitationMode === mode.id;
              return (
                <button
                  key={mode.id}
                  type="button"
                  aria-pressed={active}
                  title={`${mode.name} — ${mode.description}`}
                  onClick={() => onChangeDspConfig({ excitationMode: mode.id })}
                  className={`px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active
                      ? mode.id === 'friedlander_shockwave'
                        ? 'bg-[#2a1a12] border-orange-400 text-orange-200'
                        : 'bg-[#1f2633] border-amber-500/80 text-white'
                      : 'bg-[#12161f] border-white/8 text-slate-400 hover:text-slate-200 hover:border-white/20'
                  }`}
                >
                  {mode.shortLabel}
                </button>
              );
            })}
          </div>

          {dspConfig.excitationMode === 'friedlander_shockwave' ? (
            <button
              type="button"
              onClick={() => void onTriggerShockwave()}
              className="flex items-center gap-1.5 px-3 py-1 text-[11px] font-semibold rounded-md bg-orange-500 text-slate-950 hover:bg-orange-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Flame className="w-3.5 h-3.5" />
              <span>Disparar Onda de Choque</span>
            </button>
          ) : (
            <span
              className="hidden xl:inline text-[11px] text-slate-400 truncate max-w-[230px]"
              title={activeModeSpec.description}
            >
              {activeModeSpec.name}
            </span>
          )}
        </div>
      </div>

      {/* Row 2: Core DSP Sliders + 3D Rays Toggle */}
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1.35fr] gap-x-4 gap-y-1.5 items-end">
        <StudioSlider
          id="slider-neural"
          label="Timbre Neuronal (DDSP)"
          value={dspConfig.neuralConditioning}
          min={0}
          max={1}
          step={0.02}
          formatValue={(v) => `${Math.round(v * 100)}%`}
          onChange={(neuralConditioning) => onChangeDspConfig({ neuralConditioning })}
        />
        <StudioSlider
          id="slider-friction-gain"
          label="Nivel de fricción"
          value={dspConfig.frictionGain}
          min={0}
          max={1.5}
          step={0.05}
          formatValue={(v) => `${Math.round(v * 100)}%`}
          onChange={(frictionGain) => onChangeDspConfig({ frictionGain })}
        />
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1">
            <StudioSlider
              id="slider-master-db"
              label="Salida Maestra"
              value={dspConfig.masterGainDb}
              min={-24}
              max={6}
              step={0.5}
              formatValue={(v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`}
              onChange={(masterGainDb) => onChangeDspConfig({ masterGainDb })}
            />
          </div>
          <button
            type="button"
            aria-pressed={dspConfig.showAcousticRays}
            onClick={() => onChangeDspConfig({ showAcousticRays: !dspConfig.showAcousticRays })}
            className={`px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              dspConfig.showAcousticRays
                ? 'bg-[#1a2636] border-sky-400/70 text-sky-300'
                : 'bg-[#12161f] border-white/8 text-slate-400 hover:text-slate-200'
            }`}
          >
            Rayos 3D
          </button>
        </div>
      </div>

      {/* Row 3: Live Modal Resonator Bank Readout (8 or 12 modes) */}
      <div
        data-testid="modal-bank-grid"
        className={`grid gap-1.5 pt-2 border-t border-white/8 ${
          modalBank.length > 8 ? 'grid-cols-4 sm:grid-cols-6' : 'grid-cols-4 sm:grid-cols-8'
        }`}
      >
        {modalBank.map((m) => (
          <div
            key={m.index}
            className="flex flex-col px-2 py-1 rounded bg-[#11151d] border border-white/6 text-[10px] font-mono tabular-nums"
          >
            <div className="flex items-center justify-between text-slate-500">
              <span>M{m.index + 1}</span>
              <span>{Math.round(m.gain * 100)}%</span>
            </div>
            <span className="text-amber-300 font-medium">
              {m.frequencyHz >= 1000
                ? `${(m.frequencyHz / 1000).toFixed(2)}k`
                : `${Math.round(m.frequencyHz)}Hz`}
            </span>
            <span className="text-slate-400">Q {Math.round(m.qFactor)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
