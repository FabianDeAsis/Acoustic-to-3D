import type {
  ModalModeDefinition,
  PbrMaterialSpec,
  ProceduralPatternId,
  ProceduralTextureRecipe,
} from './types';

export interface RawAiModalMode {
  frequencyHz?: unknown;
  gain?: unknown;
  qFactor?: unknown;
}

export interface RawAiMaterialResponse {
  name?: unknown;
  subtitle?: unknown;
  acousticNotes?: unknown;
  densityKgM3?: unknown;
  hardness?: unknown;
  elasticity?: unknown;
  roughness?: unknown;
  metalness?: unknown;
  transmission?: unknown;
  ior?: unknown;
  clearcoat?: unknown;
  frictionCoeff?: unknown;
  neuralHarmonicDrive?: unknown;
  neuralFormantHz?: unknown;
  modes?: unknown;
  texture?: {
    pattern?: unknown;
    primaryColor?: unknown;
    secondaryColor?: unknown;
    accentColor?: unknown;
    grainScale?: unknown;
    contrast?: unknown;
    bumpIntensity?: unknown;
  };
}

const VALID_PATTERNS: ReadonlySet<ProceduralPatternId> = new Set([
  'ceramic_glaze',
  'brushed_metal',
  'crystalline_ice',
  'molded_plastic',
  'organic_grain',
  'porous_mineral',
  'woven_composite',
]);

function clampNumber(val: unknown, min: number, max: number, fallback: number): number {
  const num = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function sanitizeHexColor(val: unknown, fallback: string): string {
  if (typeof val !== 'string') return fallback;
  const trimmed = val.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return fallback;
}

function hexToInt(hex: string): number {
  return parseInt(hex.slice(1), 16);
}

function sanitizeLabel(val: unknown, fallback: string, maxLen: number): string {
  if (typeof val !== 'string') return fallback;
  const cleaned = val
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, maxLen);
}

function createSlug(label: string): string {
  const base = label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  return `ai_${base || 'material'}`;
}

/**
 * Validates and normalizes a raw Gemini JSON response into a physically bounded,
 * 12-mode PbrMaterialSpec ready for real-time 48kHz modal synthesis and Three.js PBR rendering.
 */
export function normalizeGeneratedMaterialPayload(
  raw: RawAiMaterialResponse,
  originalPrompt: string
): PbrMaterialSpec {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Respuesta del modelo inválida: objeto vacío.');
  }

  const rawModes = Array.isArray(raw.modes) ? (raw.modes as RawAiModalMode[]) : [];
  if (rawModes.length < 6) {
    throw new Error('El modelo no devolvió suficientes modos resonantes.');
  }

  // Sanitize and sort modes by ascending frequency, guaranteeing exactly 12 modes
  const parsedModes = rawModes
    .slice(0, 12)
    .map((m, idx) => ({
      frequencyHz: clampNumber(m?.frequencyHz, 45, 18000, 220 * (idx + 1)),
      gain: clampNumber(m?.gain, 0.04, 1.0, Math.max(0.08, 1 - idx * 0.07)),
      qFactor: clampNumber(m?.qFactor, 6, 320, 40),
    }))
    .sort((a, b) => a.frequencyHz - b.frequencyHz);

  // If Gemini returned between 6 and 11 modes, extrapolate smooth upper partials to guarantee 12 modes
  while (parsedModes.length < 12) {
    const last = parsedModes[parsedModes.length - 1];
    const nextFreq = Math.min(18000, last.frequencyHz * 1.24);
    parsedModes.push({
      frequencyHz: Number(nextFreq.toFixed(1)),
      gain: Number(Math.max(0.05, last.gain * 0.78).toFixed(3)),
      qFactor: Number(Math.max(8, last.qFactor * 0.92).toFixed(1)),
    });
  }

  const fundamentalHz = Math.max(45, parsedModes[0].frequencyHz);
  const maxGain = Math.max(0.1, ...parsedModes.map((m) => m.gain));

  const modes: ModalModeDefinition[] = parsedModes.map((m, idx) => ({
    ratio: Number((m.frequencyHz / fundamentalHz).toFixed(4)),
    amplitude: Number(Math.max(0.04, Math.min(1.0, m.gain / maxGain)).toFixed(3)),
    qFactor: Number(m.qFactor.toFixed(1)),
    decayWeight: Number(Math.max(0.16, 1 - idx * 0.062).toFixed(3)),
  }));

  const fallbackName = sanitizeLabel(originalPrompt, 'Material IA', 28);
  const name = sanitizeLabel(raw.name, fallbackName, 28);
  const subtitle = sanitizeLabel(raw.subtitle, 'Material sintetizado por IA', 56);
  const acousticNotes = sanitizeLabel(raw.acousticNotes, '', 140);

  // Physical properties clamped to stable acoustic/physics bounds
  const densityKgM3 = Math.round(clampNumber(raw.densityKgM3, 80, 19500, 1800));
  // Reference specimen volume ~0.0014 m³ (hollow or thin shells have lower effective density)
  const defaultMassKg = Number(
    Math.max(0.4, Math.min(18.0, (densityKgM3 / 1000) * 1.15)).toFixed(1)
  );
  const defaultHardness = Number(clampNumber(raw.hardness, 0.15, 1.0, 0.65).toFixed(2));
  const defaultElasticity = Number(clampNumber(raw.elasticity, 0.08, 0.88, 0.45).toFixed(2));
  const defaultRoughness = Number(clampNumber(raw.roughness, 0.04, 1.0, 0.42).toFixed(2));
  const metalness = Number(clampNumber(raw.metalness, 0.0, 1.0, 0.08).toFixed(2));
  const transmission = Number(clampNumber(raw.transmission, 0.0, 0.92, 0.0).toFixed(2));
  const ior = Number(clampNumber(raw.ior, 1.15, 2.2, 1.5).toFixed(2));
  const clearcoat = Number(clampNumber(raw.clearcoat, 0.0, 1.0, 0.15).toFixed(2));
  const frictionCoeff = Number(clampNumber(raw.frictionCoeff, 0.12, 0.95, 0.45).toFixed(2));
  const neuralHarmonicDrive = Number(
    clampNumber(raw.neuralHarmonicDrive, 0.08, 0.75, 0.3).toFixed(2)
  );
  const neuralFormantHz = Math.round(
    clampNumber(raw.neuralFormantHz, 180, 7500, Math.min(5500, fundamentalHz * 2.4))
  );

  // Procedural Texture Recipe
  const rawTex = raw.texture ?? {};
  const candidatePattern =
    typeof rawTex.pattern === 'string' ? (rawTex.pattern.trim() as ProceduralPatternId) : null;
  const pattern: ProceduralPatternId =
    candidatePattern && VALID_PATTERNS.has(candidatePattern)
      ? candidatePattern
      : metalness > 0.6
      ? 'brushed_metal'
      : transmission > 0.35
      ? 'crystalline_ice'
      : defaultRoughness < 0.28
      ? 'ceramic_glaze'
      : 'porous_mineral';

  const primaryColor = sanitizeHexColor(rawTex.primaryColor, '#b8c4d0');
  const secondaryColor = sanitizeHexColor(rawTex.secondaryColor, '#82909e');
  const accentColor = sanitizeHexColor(rawTex.accentColor, '#f59e0b');

  const textureRecipe: ProceduralTextureRecipe = {
    pattern,
    primaryColor,
    secondaryColor,
    accentColor,
    grainScale: Number(clampNumber(rawTex.grainScale, 0.3, 3.0, 1.0).toFixed(2)),
    contrast: Number(clampNumber(rawTex.contrast, 0.1, 1.0, 0.45).toFixed(2)),
    bumpIntensity: Number(clampNumber(rawTex.bumpIntensity, 0.05, 1.0, 0.35).toFixed(2)),
  };

  return {
    id: createSlug(name),
    name,
    subtitle,
    swatchColor: primaryColor,
    albedoHex: hexToInt(primaryColor),
    accentHex: hexToInt(accentColor),
    defaultRoughness,
    metalness,
    densityKgM3,
    defaultMassKg,
    defaultHardness,
    defaultElasticity,
    frictionCoeff,
    baseFundamentalHz: Number(fundamentalHz.toFixed(1)),
    neuralHarmonicDrive,
    neuralFormantHz,
    modes,
    isCustom: true,
    transmission,
    ior,
    clearcoat,
    textureRecipe,
    acousticNotes,
  };
}
