import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import type { ImportedModelStats, RoughnessPixelMap, Vec3 } from './types';

/**
 * Reference solid acoustic resonator volume (m³) corresponding to our default
 * studio block (~0.76 × 0.72 × 0.76 m ≈ 0.36 m³ solid volume).
 */
export const REFERENCE_RESONATOR_VOLUME_M3 = 0.36;

export interface RawGeometryAnalysis {
  triangleCount: number;
  bboxMin: Vec3;
  bboxMax: Vec3;
  rawBoundingBox: Vec3;
  bboxVolumeM3: number;
  signedVolumeM3: number;
  approximateVolumeM3: number;
  volumeFillRatio: number;
  volumePitchScale: number;
}

export interface BottomContactSample {
  /** Normalized horizontal offset (-0.5..+0.5) inside mesh footprint */
  nx: number;
  nz: number;
  u: number;
  v: number;
}

export interface Loaded3DModelPayload {
  root: THREE.Group;
  stats: ImportedModelStats;
  roughnessMap: RoughnessPixelMap | null;
  hasOriginalMaterials: boolean;
  bottomUvBounds: { minU: number; maxU: number; minV: number; maxV: number };
  bottomSamples: BottomContactSample[];
}

/**
 * Computes modal fundamental pitch scale factor from approximate mesh volume (m³).
 * Acoustic eigenfrequency of a 3D elastic body scales inversely with characteristic
 * length L ~ V^(1/3): larger volume -> deeper pitch, smaller volume -> higher pitch.
 */
export function computeVolumePitchScale(approximateVolumeM3: number): number {
  const safeVol = Math.max(0.002, Math.min(25.0, approximateVolumeM3));
  const rawScale = Math.pow(REFERENCE_RESONATOR_VOLUME_M3 / safeVol, 1 / 3);
  return Number(Math.max(0.32, Math.min(2.65, rawScale)).toFixed(3));
}

/**
 * Pure geometric bounding-box & signed tetrahedral volume solver operating on raw
 * world-space triangle vertex buffers. Fully decoupled from Three.js/DOM for
 * deterministic unit testing and C++20/OpenGL portability.
 */
export function analyzeTriangleBuffers(
  meshes: Array<{ positions: ArrayLike<number>; indices?: ArrayLike<number> | null }>
): RawGeometryAnalysis {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  let triangleCount = 0;
  let signedVolume6 = 0;

  for (const mesh of meshes) {
    const pos = mesh.positions;
    const idx = mesh.indices;
    const vertCount = Math.floor(pos.length / 3);
    if (vertCount < 3) continue;

    for (let i = 0; i < vertCount; i++) {
      const x = pos[i * 3];
      const y = pos[i * 3 + 1];
      const z = pos[i * 3 + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    const triTotal = idx ? Math.floor(idx.length / 3) : Math.floor(vertCount / 3);
    for (let t = 0; t < triTotal; t++) {
      const i0 = idx ? idx[t * 3] : t * 3;
      const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1;
      const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;

      const ax = pos[i0 * 3];
      const ay = pos[i0 * 3 + 1];
      const az = pos[i0 * 3 + 2];

      const bx = pos[i1 * 3];
      const by = pos[i1 * 3 + 1];
      const bz = pos[i1 * 3 + 2];

      const cx = pos[i2 * 3];
      const cy = pos[i2 * 3 + 1];
      const cz = pos[i2 * 3 + 2];

      if (
        !Number.isFinite(ax) ||
        !Number.isFinite(bx) ||
        !Number.isFinite(cx)
      ) {
        continue;
      }

      // Signed tetrahedron volume * 6 = a · (b × c)
      const crossX = by * cz - bz * cy;
      const crossY = bz * cx - bx * cz;
      const crossZ = bx * cy - by * cx;
      signedVolume6 += ax * crossX + ay * crossY + az * crossZ;
      triangleCount += 1;
    }
  }

  if (!Number.isFinite(minX)) {
    minX = -0.5;
    minY = 0;
    minZ = -0.5;
    maxX = 0.5;
    maxY = 1;
    maxZ = 0.5;
  }

  const sizeX = Math.max(1e-4, maxX - minX);
  const sizeY = Math.max(1e-4, maxY - minY);
  const sizeZ = Math.max(1e-4, maxZ - minZ);
  const maxDim = Math.max(sizeX, sizeY, sizeZ);

  const rawBboxVol = sizeX * sizeY * sizeZ;
  const rawSignedVol = Math.abs(signedVolume6) / 6;

  // Determine fill ratio inside bounding box (fallback to 0.55 for open/non-manifold shells)
  const rawFill =
    rawBboxVol > 1e-9 &&
    rawSignedVol > rawBboxVol * 0.04 &&
    rawSignedVol <= rawBboxVol * 1.15
      ? Math.min(1.0, rawSignedVol / rawBboxVol)
      : 0.55;

  // If the file uses realistic metric bounds (8 cm .. 3.5 m), preserve true acoustic volume;
  // otherwise normalize arbitrary CAD/mm/cm coordinates to a 1.0 m reference envelope while
  // keeping exact aspect ratio & solid fill ratio so thin/slender meshes sound higher than bulky ones.
  const isMetricScale = maxDim >= 0.08 && maxDim <= 3.5;
  const unitScale = isMetricScale ? 1.0 : 1.0 / maxDim;

  const acousticBboxVol = rawBboxVol * unitScale * unitScale * unitScale;
  const approximateVolumeM3 = Math.max(0.002, acousticBboxVol * rawFill);
  const volumePitchScale = computeVolumePitchScale(approximateVolumeM3);

  return {
    triangleCount,
    bboxMin: { x: minX, y: minY, z: minZ },
    bboxMax: { x: maxX, y: maxY, z: maxZ },
    rawBoundingBox: {
      x: Number(sizeX.toFixed(3)),
      y: Number(sizeY.toFixed(3)),
      z: Number(sizeZ.toFixed(3)),
    },
    bboxVolumeM3: Number(acousticBboxVol.toFixed(4)),
    signedVolumeM3: Number((rawSignedVol * unitScale * unitScale * unitScale).toFixed(4)),
    approximateVolumeM3: Number(approximateVolumeM3.toFixed(4)),
    volumeFillRatio: Number(rawFill.toFixed(3)),
    volumePitchScale,
  };
}

function wrapUnit(v: number): number {
  const m = v % 1;
  return m < 0 ? m + 1 : m;
}

/**
 * Samples a single PBR roughness pixel value (0..1) and local spatial asperity gradient
 * directly from an extracted RGBA8 roughness texture buffer at UV coordinates (u, v).
 *
 * Follows the glTF 2.0 PBR specification: roughness is encoded in the GREEN channel
 * (which also matches standard grayscale PBR roughness maps where R = G = B).
 */
export function sampleRoughnessPixel(
  map: RoughnessPixelMap,
  u: number,
  v: number,
  sliderScale = 1.0
): { roughness: number; asperity: number; pixelX: number; pixelY: number } {
  const w = Math.max(1, map.width);
  const h = Math.max(1, map.height);

  const tu = wrapUnit(u * map.repeatU + map.offsetU);
  const rawTv = wrapUnit(v * map.repeatV + map.offsetV);
  const tv = map.flipY ? 1 - rawTv : rawTv;

  const px = Math.min(w - 1, Math.max(0, Math.floor(tu * w)));
  const py = Math.min(h - 1, Math.max(0, Math.floor(tv * h)));

  const readG = (x: number, y: number): number => {
    const cx = ((x % w) + w) % w;
    const cy = ((y % h) + h) % h;
    const idx = (cy * w + cx) * 4;
    // Green channel (index + 1) per glTF metallicRoughness & grayscale roughness maps
    return (map.data[idx + 1] ?? 128) / 255;
  };

  const center = readG(px, py);
  const right = readG(px + 1, py);
  const left = readG(px - 1, py);
  const down = readG(px, py + 1);
  const up = readG(px, py - 1);

  const gradX = Math.abs(right - left) * 0.5;
  const gradY = Math.abs(down - up) * 0.5;
  const edgeGrad = Math.min(1, Math.hypot(gradX, gradY) * 3.2);

  // Combine pixel roughness with material roughness factor and subtle user multiplier
  const effectiveFactor = Math.max(0.15, Math.min(1.5, map.roughnessFactor * sliderScale));
  const roughness = Math.max(0.02, Math.min(1.0, center * effectiveFactor));
  // Micro-bump asperity rises sharply on high-roughness pixels and texture transitions
  const asperity = Math.max(0.02, Math.min(1.0, roughness * 0.48 + edgeGrad * 0.72));

  return {
    roughness: Number(roughness.toFixed(3)),
    asperity: Number(asperity.toFixed(3)),
    pixelX: px,
    pixelY: py,
  };
}

/**
 * Computes the average roughness across a sampled PBR roughness map (stride-sampled for speed).
 */
export function computeMeanRoughnessFromPixelMap(map: RoughnessPixelMap): number {
  const totalPixels = map.width * map.height;
  if (totalPixels <= 0) return 0.5;
  const stride = Math.max(1, Math.floor(totalPixels / 1024));
  let sum = 0;
  let count = 0;
  for (let p = 0; p < totalPixels; p += stride) {
    sum += ((map.data[p * 4 + 1] ?? 128) / 255) * map.roughnessFactor;
    count += 1;
  }
  return Number(Math.max(0.02, Math.min(1.0, sum / Math.max(1, count))).toFixed(2));
}

/**
 * Maps the current 3D contact pose (world floor position, tilt & heading) onto
 * a deterministic (u, v) contact point on the imported mesh's bottom surface so
 * dragging across the chamber scans the PBR Roughness map pixels in real time.
 */
export function computeContactUvFromPose(
  position: Vec3,
  rotation: Vec3,
  uvBounds?: { minU: number; maxU: number; minV: number; maxV: number }
): { u: number; v: number } {
  // Combine world sliding trajectory + rock/tilt contact patch shift
  const rawU = wrapUnit(0.5 + position.x * 0.34 + rotation.z * 0.85);
  const rawV = wrapUnit(0.5 + position.z * 0.34 - rotation.x * 0.85);

  if (!uvBounds) {
    return { u: rawU, v: rawV };
  }

  const spanU = Math.max(0.05, uvBounds.maxU - uvBounds.minU);
  const spanV = Math.max(0.05, uvBounds.maxV - uvBounds.minV);
  return {
    u: wrapUnit(uvBounds.minU + rawU * spanU),
    v: wrapUnit(uvBounds.minV + rawV * spanV),
  };
}

/**
 * Extracts raw RGBA8 pixel data from a Three.js Texture (ImageBitmap, HTMLImageElement,
 * HTMLCanvasElement, or DataTexture) into an offscreen 2D canvas (capped at 256×256
 * for ultra-low memory and O(1) real-time contact pixel reads).
 */
export function extractRoughnessPixelMapFromTexture(
  texture: THREE.Texture,
  roughnessFactor = 1.0,
  isGltfPacked = false
): RoughnessPixelMap | null {
  const image = texture.image as
    | HTMLImageElement
    | HTMLCanvasElement
    | ImageBitmap
    | { width: number; height: number; data?: Uint8Array | Uint8ClampedArray }
    | undefined;

  if (!image) return null;

  // Handle DataTexture directly without DOM canvas
  if ('data' in image && image.data && image.width > 0 && image.height > 0) {
    const src = image.data;
    const rgba =
      src instanceof Uint8ClampedArray ? new Uint8ClampedArray(src) : new Uint8ClampedArray(src);
    return {
      width: image.width,
      height: image.height,
      data: rgba,
      roughnessFactor,
      isGltfPacked,
      flipY: texture.flipY,
      repeatU: texture.repeat?.x ?? 1,
      repeatV: texture.repeat?.y ?? 1,
      offsetU: texture.offset?.x ?? 0,
      offsetV: texture.offset?.y ?? 0,
    };
  }

  if (typeof document === 'undefined') return null;

  const srcW = (image as HTMLImageElement).naturalWidth || image.width || 0;
  const srcH = (image as HTMLImageElement).naturalHeight || image.height || 0;
  if (srcW <= 0 || srcH <= 0) return null;

  const maxSide = 256;
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const targetW = Math.max(2, Math.round(srcW * scale));
  const targetH = Math.max(2, Math.round(srcH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  try {
    ctx.drawImage(image as CanvasImageSource, 0, 0, targetW, targetH);
    const imgData = ctx.getImageData(0, 0, targetW, targetH);
    return {
      width: targetW,
      height: targetH,
      data: imgData.data,
      roughnessFactor,
      isGltfPacked,
      flipY: texture.flipY,
      repeatU: texture.repeat?.x ?? 1,
      repeatV: texture.repeat?.y ?? 1,
      offsetU: texture.offset?.x ?? 0,
      offsetV: texture.offset?.y ?? 0,
    };
  } catch {
    return null;
  }
}

function getFileExtension(name: string): string {
  const parts = name.toLowerCase().split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

/**
 * Loads user-selected .OBJ, .GLTF, or .GLB files (with optional companion .MTL / .BIN / textures),
 * normalizes & grounds the mesh at (0, 0, 0), computes exact bounding box & tetrahedral volume,
 * and extracts any embedded PBR roughnessMap pixels for real-time friction synthesis.
 */
export async function loadImported3DModelFiles(
  fileList: FileList | File[],
  options: { castShadows?: boolean } = {}
): Promise<Loaded3DModelPayload> {
  const files = Array.from(fileList);
  if (files.length === 0) {
    throw new Error('No se seleccionó ningún archivo 3D.');
  }

  const primaryFile = files.find((f) => {
    const ext = getFileExtension(f.name);
    return ext === 'glb' || ext === 'gltf' || ext === 'obj';
  });

  if (!primaryFile) {
    throw new Error('Formato no compatible. Selecciona un archivo .OBJ, .GLTF o .GLB.');
  }

  const format = getFileExtension(primaryFile.name) as 'obj' | 'gltf' | 'glb';
  const companionUrls = new Map<string, string>();
  const createdUrls: string[] = [];

  for (const file of files) {
    const url = URL.createObjectURL(file);
    createdUrls.push(url);
    companionUrls.set(file.name.toLowerCase(), url);
  }

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    const cleanName = decodeURIComponent(url.split('/').pop() || url).toLowerCase();
    return companionUrls.get(cleanName) ?? url;
  });

  let loadedObject: THREE.Object3D;

  try {
    if (format === 'gltf' || format === 'glb') {
      const loader = new GLTFLoader(manager);
      const buffer = await primaryFile.arrayBuffer();
      const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
        loader.parse(buffer, '', resolve, reject);
      });
      loadedObject = gltf.scene;
    } else {
      const objLoader = new OBJLoader(manager);
      const mtlFile = files.find((f) => getFileExtension(f.name) === 'mtl');
      if (mtlFile) {
        const mtlText = await mtlFile.text();
        const mtlLoader = new MTLLoader(manager);
        const materials = mtlLoader.parse(mtlText, '');
        materials.preload();
        objLoader.setMaterials(materials);
      }
      const objText = await primaryFile.text();
      loadedObject = objLoader.parse(objText);
    }
  } finally {
    // Allow textures a brief microtask to finish binding if created from Blob URLs
    window.setTimeout(() => {
      createdUrls.forEach((u) => URL.revokeObjectURL(u));
    }, 1500);
  }

  // Wait briefly for any embedded glTF ImageBitmaps / Images to finish decoding
  const pendingTextures: Promise<void>[] = [];
  loadedObject.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat) continue;
      const std = mat as THREE.MeshStandardMaterial;
      if (std.roughnessMap && std.roughnessMap.image instanceof HTMLImageElement && !std.roughnessMap.image.complete) {
        pendingTextures.push(
          new Promise<void>((res) => {
            const img = std.roughnessMap!.image as HTMLImageElement;
            img.addEventListener('load', () => res(), { once: true });
            img.addEventListener('error', () => res(), { once: true });
          })
        );
      }
    }
  });
  if (pendingTextures.length > 0) {
    await Promise.race([
      Promise.all(pendingTextures),
      new Promise<void>((res) => window.setTimeout(res, 1200)),
    ]);
  }

  loadedObject.updateMatrixWorld(true);

  // Extract world-space triangle buffers for exact bounding-box & signed tetrahedral volume
  const triangleBuffers: Array<{
    positions: Float32Array;
    indices?: ArrayLike<number> | null;
  }> = [];

  const extracted: { roughnessMap: RoughnessPixelMap | null } = { roughnessMap: null };
  let hasOriginalMaterials = false;

  const vTmp = new THREE.Vector3();

  loadedObject.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    const geo = mesh.geometry;
    if (!geo) return;

    if (!geo.attributes.normal) {
      geo.computeVertexNormals();
    }

    const posAttr = geo.attributes.position;
    if (posAttr && posAttr.count >= 3) {
      // Auto-generate triplanar box-projected UVs for untextured .OBJ/.GLTF meshes lacking vt UVs
      if (!geo.attributes.uv) {
        geo.computeBoundingBox();
        const gb = geo.boundingBox;
        const normAttr = geo.attributes.normal;
        const spanX = gb ? Math.max(1e-4, gb.max.x - gb.min.x) : 1;
        const spanY = gb ? Math.max(1e-4, gb.max.y - gb.min.y) : 1;
        const spanZ = gb ? Math.max(1e-4, gb.max.z - gb.min.z) : 1;
        const maxSpan = Math.max(spanX, spanY, spanZ);
        const uvArray = new Float32Array(posAttr.count * 2);

        for (let i = 0; i < posAttr.count; i++) {
          const x = posAttr.getX(i);
          const y = posAttr.getY(i);
          const z = posAttr.getZ(i);
          const nx = normAttr ? Math.abs(normAttr.getX(i)) : 0;
          const ny = normAttr ? Math.abs(normAttr.getY(i)) : 1;
          const nz = normAttr ? Math.abs(normAttr.getZ(i)) : 0;

          let u = 0;
          let v = 0;
          if (ny >= nx && ny >= nz) {
            u = (x - (gb?.min.x ?? 0)) / maxSpan;
            v = (z - (gb?.min.z ?? 0)) / maxSpan;
          } else if (nx >= ny && nx >= nz) {
            u = (z - (gb?.min.z ?? 0)) / maxSpan;
            v = (y - (gb?.min.y ?? 0)) / maxSpan;
          } else {
            u = (x - (gb?.min.x ?? 0)) / maxSpan;
            v = (y - (gb?.min.y ?? 0)) / maxSpan;
          }
          uvArray[i * 2] = u;
          uvArray[i * 2 + 1] = v;
        }
        geo.setAttribute('uv', new THREE.BufferAttribute(uvArray, 2));
      }

      const worldPositions = new Float32Array(posAttr.count * 3);
      for (let i = 0; i < posAttr.count; i++) {
        vTmp.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
        worldPositions[i * 3] = vTmp.x;
        worldPositions[i * 3 + 1] = vTmp.y;
        worldPositions[i * 3 + 2] = vTmp.z;
      }
      triangleBuffers.push({
        positions: worldPositions,
        indices: geo.index ? geo.index.array : null,
      });
    }

    mesh.castShadow = Boolean(options.castShadows);
    mesh.receiveShadow = Boolean(options.castShadows);

    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat) continue;
      const std = mat as THREE.MeshStandardMaterial;
      if (format !== 'obj' || std.map || std.roughnessMap || std.normalMap) {
        hasOriginalMaterials = true;
      }
      if ('envMapIntensity' in std) {
        std.envMapIntensity = 1.15;
      }
      if (!extracted.roughnessMap && std.roughnessMap) {
        const isGltfPacked = format === 'gltf' || format === 'glb';
        const factor = typeof std.roughness === 'number' ? std.roughness : 1.0;
        extracted.roughnessMap = extractRoughnessPixelMapFromTexture(
          std.roughnessMap,
          factor,
          isGltfPacked
        );
      }
    }
  });

  if (triangleBuffers.length === 0) {
    throw new Error('El archivo 3D no contiene geometría válida (sin vértices ni triángulos).');
  }

  const analysis = analyzeTriangleBuffers(triangleBuffers);

  // Normalize & ground the mesh cleanly at bottom-center (0, 0, 0) in the chamber
  const maxRawDim = Math.max(
    analysis.rawBoundingBox.x,
    analysis.rawBoundingBox.y,
    analysis.rawBoundingBox.z,
    1e-4
  );
  // Keep visual display size proportional & comfortable in the studio chamber (0.72 .. 1.32 m)
  const targetMaxDim =
    maxRawDim >= 0.45 && maxRawDim <= 1.35 ? maxRawDim : 0.96;
  const visualScale = targetMaxDim / maxRawDim;

  const centerX = (analysis.bboxMin.x + analysis.bboxMax.x) * 0.5;
  const centerZ = (analysis.bboxMin.z + analysis.bboxMax.z) * 0.5;
  const minY = analysis.bboxMin.y;

  const normalizedWrapper = new THREE.Group();
  const offsetPivot = new THREE.Group();
  offsetPivot.position.set(-centerX, -minY, -centerZ);
  offsetPivot.add(loadedObject);
  normalizedWrapper.scale.setScalar(visualScale);
  normalizedWrapper.add(offsetPivot);
  normalizedWrapper.updateMatrixWorld(true);

  // Extract bottom-contact UV footprint so friction sampling traverses real contact UVs
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  const bottomSamples: BottomContactSample[] = [];
  const normSizeX = Math.max(0.05, analysis.rawBoundingBox.x * visualScale);
  const normSizeY = Math.max(0.05, analysis.rawBoundingBox.y * visualScale);
  const normSizeZ = Math.max(0.05, analysis.rawBoundingBox.z * visualScale);
  const bottomThresholdY = normSizeY * 0.25;

  normalizedWrapper.traverse((child) => {
    if (!(child as THREE.Mesh).isMesh) return;
    const mesh = child as THREE.Mesh;
    const posAttr = mesh.geometry?.attributes?.position;
    const uvAttr = mesh.geometry?.attributes?.uv;
    if (!posAttr || !uvAttr) return;

    const stride = Math.max(1, Math.floor(posAttr.count / 1200));
    for (let i = 0; i < posAttr.count; i += stride) {
      vTmp.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
      if (vTmp.y <= bottomThresholdY) {
        const u = uvAttr.getX(i);
        const v = uvAttr.getY(i);
        if (Number.isFinite(u) && Number.isFinite(v)) {
          if (u < minU) minU = u;
          if (u > maxU) maxU = u;
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
          if (bottomSamples.length < 256) {
            bottomSamples.push({
              nx: vTmp.x / normSizeX,
              nz: vTmp.z / normSizeZ,
              u,
              v,
            });
          }
        }
      }
    }
  });

  const bottomUvBounds =
    Number.isFinite(minU) && Number.isFinite(minV) && maxU > minU + 1e-4 && maxV > minV + 1e-4
      ? { minU, maxU, minV, maxV }
      : { minU: 0, maxU: 1, minV: 0, maxV: 1 };

  const finalRoughnessMap = extracted.roughnessMap;

  const meanSampledRoughness = finalRoughnessMap
    ? computeMeanRoughnessFromPixelMap(finalRoughnessMap)
    : undefined;

  const stats: ImportedModelStats = {
    fileName: primaryFile.name,
    format,
    triangleCount: analysis.triangleCount,
    rawBoundingBox: analysis.rawBoundingBox,
    normalizedBoundingBox: {
      x: Number(normSizeX.toFixed(2)),
      y: Number(normSizeY.toFixed(2)),
      z: Number(normSizeZ.toFixed(2)),
    },
    approximateVolumeM3: analysis.approximateVolumeM3,
    bboxVolumeM3: analysis.bboxVolumeM3,
    volumeFillRatio: analysis.volumeFillRatio,
    volumePitchScale: analysis.volumePitchScale,
    hasRoughnessMap: Boolean(finalRoughnessMap),
    roughnessMapSize: finalRoughnessMap
      ? { width: finalRoughnessMap.width, height: finalRoughnessMap.height }
      : undefined,
    meanSampledRoughness,
  };

  return {
    root: normalizedWrapper,
    stats,
    roughnessMap: finalRoughnessMap,
    hasOriginalMaterials,
    bottomUvBounds,
    bottomSamples,
  };
}
