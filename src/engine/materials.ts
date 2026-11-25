import type {
  BuiltInPbrMaterialId,
  PbrMaterialId,
  PbrMaterialSpec,
  RoomMaterialId,
  RoomMaterialSpec,
  RoomSizePreset,
  RoomSizePresetId,
} from './types';

/**
 * Calibrated PBR + Modal Acoustic Material Database.
 * Modal ratios are derived from real solid mechanics (Euler-Bernoulli bar,
 * thin plate, and hollow resonator eigenmodes) for physical timbre fidelity.
 */
export const PBR_MATERIALS: Record<BuiltInPbrMaterialId, PbrMaterialSpec> = {
  metal: {
    id: 'metal',
    name: 'Metal',
    subtitle: 'Acero cepillado anisotrópico',
    swatchColor: '#94a3b8',
    albedoHex: 0xc2ccd6,
    accentHex: 0x38bdf8,
    defaultRoughness: 0.24,
    metalness: 0.92,
    densityKgM3: 7850,
    defaultMassKg: 4.2,
    defaultHardness: 0.92,
    defaultElasticity: 0.62,
    frictionCoeff: 0.34,
    baseFundamentalHz: 412,
    neuralHarmonicDrive: 0.38,
    neuralFormantHz: 2650,
    modes: [
      { ratio: 1.0, amplitude: 1.0, qFactor: 145, decayWeight: 1.0 },
      { ratio: 2.31, amplitude: 0.86, qFactor: 165, decayWeight: 0.92 },
      { ratio: 3.84, amplitude: 0.72, qFactor: 185, decayWeight: 0.84 },
      { ratio: 5.47, amplitude: 0.58, qFactor: 195, decayWeight: 0.74 },
      { ratio: 7.19, amplitude: 0.45, qFactor: 170, decayWeight: 0.66 },
      { ratio: 9.62, amplitude: 0.36, qFactor: 155, decayWeight: 0.54 },
      { ratio: 12.14, amplitude: 0.25, qFactor: 130, decayWeight: 0.45 },
      { ratio: 15.88, amplitude: 0.16, qFactor: 110, decayWeight: 0.36 },
    ],
  },
  wood: {
    id: 'wood',
    name: 'Madera',
    subtitle: 'Nogal acústico curado',
    swatchColor: '#b47846',
    albedoHex: 0x8f5b34,
    accentHex: 0xf59e0b,
    defaultRoughness: 0.62,
    metalness: 0.04,
    densityKgM3: 680,
    defaultMassKg: 1.6,
    defaultHardness: 0.46,
    defaultElasticity: 0.44,
    frictionCoeff: 0.56,
    baseFundamentalHz: 235,
    neuralHarmonicDrive: 0.24,
    neuralFormantHz: 680,
    modes: [
      { ratio: 1.0, amplitude: 1.0, qFactor: 26, decayWeight: 1.0 },
      { ratio: 1.58, amplitude: 0.82, qFactor: 24, decayWeight: 0.86 },
      { ratio: 2.42, amplitude: 0.68, qFactor: 22, decayWeight: 0.72 },
      { ratio: 3.19, amplitude: 0.48, qFactor: 19, decayWeight: 0.58 },
      { ratio: 4.55, amplitude: 0.34, qFactor: 17, decayWeight: 0.44 },
      { ratio: 6.12, amplitude: 0.21, qFactor: 14, decayWeight: 0.32 },
      { ratio: 8.4, amplitude: 0.12, qFactor: 12, decayWeight: 0.22 },
      { ratio: 11.1, amplitude: 0.07, qFactor: 10, decayWeight: 0.15 },
    ],
  },
  concrete: {
    id: 'concrete',
    name: 'Concreto',
    subtitle: 'Hormigón arquitectónico mineral',
    swatchColor: '#6b7280',
    albedoHex: 0x767b82,
    accentHex: 0xd97706,
    defaultRoughness: 0.86,
    metalness: 0.02,
    densityKgM3: 2400,
    defaultMassKg: 8.5,
    defaultHardness: 0.78,
    defaultElasticity: 0.22,
    frictionCoeff: 0.82,
    baseFundamentalHz: 158,
    neuralHarmonicDrive: 0.46,
    neuralFormantHz: 1180,
    modes: [
      { ratio: 1.0, amplitude: 1.0, qFactor: 14, decayWeight: 0.92 },
      { ratio: 1.73, amplitude: 0.78, qFactor: 13, decayWeight: 0.78 },
      { ratio: 2.68, amplitude: 0.62, qFactor: 12, decayWeight: 0.64 },
      { ratio: 3.91, amplitude: 0.49, qFactor: 11, decayWeight: 0.52 },
      { ratio: 5.34, amplitude: 0.38, qFactor: 10, decayWeight: 0.4 },
      { ratio: 7.45, amplitude: 0.28, qFactor: 9, decayWeight: 0.31 },
      { ratio: 10.6, amplitude: 0.19, qFactor: 8, decayWeight: 0.22 },
      { ratio: 14.9, amplitude: 0.13, qFactor: 7, decayWeight: 0.16 },
    ],
  },
  glass: {
    id: 'glass',
    name: 'Vidrio',
    subtitle: 'Cristal borosilicato templado',
    swatchColor: '#7dd3fc',
    albedoHex: 0xcceeff,
    accentHex: 0x38bdf8,
    defaultRoughness: 0.08,
    metalness: 0.05,
    densityKgM3: 2500,
    defaultMassKg: 1.2,
    defaultHardness: 0.96,
    defaultElasticity: 0.54,
    frictionCoeff: 0.22,
    baseFundamentalHz: 940,
    neuralHarmonicDrive: 0.18,
    neuralFormantHz: 4800,
    modes: [
      { ratio: 1.0, amplitude: 1.0, qFactor: 240, decayWeight: 1.0 },
      { ratio: 2.13, amplitude: 0.84, qFactor: 260, decayWeight: 0.94 },
      { ratio: 3.41, amplitude: 0.66, qFactor: 220, decayWeight: 0.86 },
      { ratio: 4.92, amplitude: 0.52, qFactor: 210, decayWeight: 0.78 },
      { ratio: 6.76, amplitude: 0.38, qFactor: 190, decayWeight: 0.68 },
      { ratio: 8.85, amplitude: 0.28, qFactor: 175, decayWeight: 0.58 },
      { ratio: 11.4, amplitude: 0.18, qFactor: 150, decayWeight: 0.44 },
      { ratio: 14.2, amplitude: 0.11, qFactor: 120, decayWeight: 0.32 },
    ],
  },
};

export const PBR_MATERIAL_LIST: PbrMaterialSpec[] = [
  PBR_MATERIALS.metal,
  PBR_MATERIALS.wood,
  PBR_MATERIALS.concrete,
  PBR_MATERIALS.glass,
];

export function resolvePbrMaterialSpec(
  materialId: PbrMaterialId,
  customMaterials?: Record<string, PbrMaterialSpec>
): PbrMaterialSpec {
  if (customMaterials && customMaterials[materialId]) {
    return customMaterials[materialId];
  }
  if (materialId in PBR_MATERIALS) {
    return PBR_MATERIALS[materialId as BuiltInPbrMaterialId];
  }
  return PBR_MATERIALS.metal;
}

export const ROOM_MATERIALS: Record<RoomMaterialId, RoomMaterialSpec> = {
  concrete: {
    id: 'concrete',
    name: 'Concreto',
    subtitle: 'Alta reflexión · Cola brillante',
    swatchColor: '#64748b',
    wallColorHex: 0x3a404c,
    floorColorHex: 0x2a2f38,
    wallRoughness: 0.84,
    wallMetalness: 0.04,
    defaultAbsorption: 0.08,
    bandAbsorption: { low: 0.04, mid: 0.07, high: 0.12 },
    diffusion: 0.25,
  },
  wood: {
    id: 'wood',
    name: 'Madera',
    subtitle: 'Calidez media · Absorción grave',
    swatchColor: '#9a633c',
    wallColorHex: 0x523a29,
    floorColorHex: 0x3b2a1e,
    wallRoughness: 0.65,
    wallMetalness: 0.05,
    defaultAbsorption: 0.24,
    bandAbsorption: { low: 0.18, mid: 0.22, high: 0.32 },
    diffusion: 0.52,
  },
  glass: {
    id: 'glass',
    name: 'Vidrio',
    subtitle: 'Especulares agudos · Eco vítreo',
    swatchColor: '#38bdf8',
    wallColorHex: 0x283e4d,
    floorColorHex: 0x222c36,
    wallRoughness: 0.18,
    wallMetalness: 0.15,
    defaultAbsorption: 0.11,
    bandAbsorption: { low: 0.16, mid: 0.07, high: 0.06 },
    diffusion: 0.15,
  },
  acoustic_foam: {
    id: 'acoustic_foam',
    name: 'Panel Acústico',
    subtitle: 'Cabina tratada · Seca y precisa',
    swatchColor: '#334155',
    wallColorHex: 0x1e2430,
    floorColorHex: 0x22262e,
    wallRoughness: 0.94,
    wallMetalness: 0.0,
    defaultAbsorption: 0.72,
    bandAbsorption: { low: 0.34, mid: 0.76, high: 0.92 },
    diffusion: 0.84,
  },
};

export const ROOM_MATERIAL_LIST: RoomMaterialSpec[] = [
  ROOM_MATERIALS.concrete,
  ROOM_MATERIALS.wood,
  ROOM_MATERIALS.glass,
  ROOM_MATERIALS.acoustic_foam,
];

export const ROOM_SIZE_PRESETS: Record<RoomSizePresetId, RoomSizePreset> = {
  booth: {
    id: 'booth',
    name: 'Cabina',
    dimensions: { width: 4.8, height: 3.1, depth: 4.6 },
  },
  studio: {
    id: 'studio',
    name: 'Estudio',
    dimensions: { width: 7.4, height: 4.2, depth: 6.8 },
  },
  hall: {
    id: 'hall',
    name: 'Sala',
    dimensions: { width: 11.5, height: 6.2, depth: 10.4 },
  },
  cathedral: {
    id: 'cathedral',
    name: 'Catedral',
    dimensions: { width: 17.0, height: 10.5, depth: 16.0 },
  },
};

export const ROOM_SIZE_LIST: RoomSizePreset[] = [
  ROOM_SIZE_PRESETS.booth,
  ROOM_SIZE_PRESETS.studio,
  ROOM_SIZE_PRESETS.hall,
  ROOM_SIZE_PRESETS.cathedral,
];
