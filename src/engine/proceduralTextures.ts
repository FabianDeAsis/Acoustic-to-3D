import * as THREE from 'three';
import type { BuiltInPbrMaterialId, ProceduralTextureRecipe, RoomMaterialId } from './types';

export interface ProceduralTextureSet {
  map: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
}

function configureTexture(
  canvas: HTMLCanvasElement,
  isColor: boolean,
  maxAnisotropy: number,
  repeatX = 1,
  repeatY = 1
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = Math.max(1, maxAnisotropy);
  tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function hash2d(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

/**
 * Generates zero-404 procedural PBR texture sets (Albedo, Roughness, Bump)
 * for both hero object materials and acoustic chamber architectural surfaces.
 */
export function createPbrTextureSet(
  kind: BuiltInPbrMaterialId | RoomMaterialId,
  maxAnisotropy: number,
  repeat = 1
): ProceduralTextureSet {
  const size = 256;
  const albedoCanvas = document.createElement('canvas');
  const roughCanvas = document.createElement('canvas');
  const bumpCanvas = document.createElement('canvas');
  albedoCanvas.width = roughCanvas.width = bumpCanvas.width = size;
  albedoCanvas.height = roughCanvas.height = bumpCanvas.height = size;

  const aCtx = albedoCanvas.getContext('2d')!;
  const rCtx = roughCanvas.getContext('2d')!;
  const bCtx = bumpCanvas.getContext('2d')!;

  if (kind === 'metal') {
    // Anisotropic horizontal brushed steel micro-grooves
    aCtx.fillStyle = '#c5cfd9';
    aCtx.fillRect(0, 0, size, size);
    rCtx.fillStyle = '#484848';
    rCtx.fillRect(0, 0, size, size);
    bCtx.fillStyle = '#808080';
    bCtx.fillRect(0, 0, size, size);

    for (let y = 0; y < size; y++) {
      const streak = hash2d(y, 1.3);
      const lum = Math.round(182 + streak * 38);
      aCtx.fillStyle = `rgb(${lum - 4},${lum},${lum + 6})`;
      aCtx.fillRect(0, y, size, 1);

      const rVal = Math.round(52 + streak * 44);
      rCtx.fillStyle = `rgb(${rVal},${rVal},${rVal})`;
      rCtx.fillRect(0, y, size, 1);

      const bVal = Math.round(112 + streak * 32);
      bCtx.fillStyle = `rgb(${bVal},${bVal},${bVal})`;
      bCtx.fillRect(0, y, size, 1);
    }

    // Subtle machined seam lines
    aCtx.strokeStyle = 'rgba(40,52,68,0.22)';
    aCtx.lineWidth = 1;
    for (let i = 32; i < size; i += 64) {
      aCtx.beginPath();
      aCtx.moveTo(0, i);
      aCtx.lineTo(size, i);
      aCtx.stroke();
    }
  } else if (kind === 'wood') {
    // Realistic architectural walnut studio planks with straight fine grain & subtle seams
    aCtx.fillStyle = '#6f472b';
    aCtx.fillRect(0, 0, size, size);
    rCtx.fillStyle = '#9c9c9c';
    rCtx.fillRect(0, 0, size, size);
    bCtx.fillStyle = '#808080';
    bCtx.fillRect(0, 0, size, size);

    const plankCount = 4;
    const plankH = size / plankCount;

    for (let p = 0; p < plankCount; p++) {
      const yStart = p * plankH;
      const plankTone = (hash2d(p, 7.1) - 0.5) * 18;
      const grainOffset = hash2d(p, 3.7) * 50;

      for (let ly = 0; ly < plankH; ly++) {
        const y = yStart + ly;
        const grainBand = Math.sin((ly + grainOffset) * 0.42) * 0.5 + 0.5;
        const fineFiber = (hash2d(y * 1.3, p * 9.1) - 0.5) * 0.25;

        for (let x = 0; x < size; x += 4) {
          const gentleWave = Math.sin(x * 0.018 + p * 2.1) * 1.6;
          const ring = Math.sin((ly + gentleWave + grainOffset) * 0.26) * 0.5 + 0.5;
          const t = Math.min(1, Math.max(0, ring * 0.65 + grainBand * 0.25 + fineFiber));

          const r = Math.min(255, Math.max(30, Math.round(96 + plankTone + t * 44)));
          const g = Math.min(255, Math.max(20, Math.round(60 + plankTone * 0.7 + t * 30)));
          const b = Math.min(255, Math.max(15, Math.round(36 + plankTone * 0.45 + t * 18)));
          aCtx.fillStyle = `rgb(${r},${g},${b})`;
          aCtx.fillRect(x, y, 4, 1);

          const rv = Math.round(118 + (1 - t) * 58);
          rCtx.fillStyle = `rgb(${rv},${rv},${rv})`;
          rCtx.fillRect(x, y, 4, 1);

          const bv = Math.round(112 + t * 36);
          bCtx.fillStyle = `rgb(${bv},${bv},${bv})`;
          bCtx.fillRect(x, y, 4, 1);
        }
      }

      // Subtle beveled plank seam
      aCtx.fillStyle = 'rgba(22, 13, 8, 0.55)';
      aCtx.fillRect(0, yStart, size, 2);
      bCtx.fillStyle = '#383838';
      bCtx.fillRect(0, yStart, size, 2);
    }
  } else if (kind === 'concrete') {
    // Architectural cast concrete with mineral aggregate & formwork seams
    aCtx.fillStyle = '#757b84';
    aCtx.fillRect(0, 0, size, size);
    rCtx.fillStyle = '#cfcfcf';
    rCtx.fillRect(0, 0, size, size);
    bCtx.fillStyle = '#808080';
    bCtx.fillRect(0, 0, size, size);

    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        const n1 = hash2d(x * 0.5, y * 0.5);
        const n2 = Math.sin(x * 0.08) * Math.cos(y * 0.09) * 0.5 + 0.5;
        const speck = n1 > 0.92 ? -24 : n1 < 0.08 ? 20 : 0;
        const base = Math.round(106 + n2 * 24 + (n1 - 0.5) * 26 + speck);
        aCtx.fillStyle = `rgb(${base},${base + 2},${base + 5})`;
        aCtx.fillRect(x, y, 2, 2);

        const rv = Math.round(175 + n1 * 68);
        rCtx.fillStyle = `rgb(${rv},${rv},${rv})`;
        rCtx.fillRect(x, y, 2, 2);

        const bv = Math.round(92 + n1 * 76);
        bCtx.fillStyle = `rgb(${bv},${bv},${bv})`;
        bCtx.fillRect(x, y, 2, 2);
      }
    }

    // Subtle formwork panel lines & tie-rod dots
    aCtx.strokeStyle = 'rgba(28,32,38,0.35)';
    aCtx.lineWidth = 2;
    aCtx.strokeRect(1, 1, size - 2, size - 2);
  } else if (kind === 'glass') {
    // Optical borosilicate glass with delicate etched acoustic calibration micro-lines
    aCtx.fillStyle = '#cfeaf8';
    aCtx.fillRect(0, 0, size, size);
    rCtx.fillStyle = '#181818';
    rCtx.fillRect(0, 0, size, size);
    bCtx.fillStyle = '#808080';
    bCtx.fillRect(0, 0, size, size);

    const grad = aCtx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, '#d8f1fc');
    grad.addColorStop(0.5, '#b8dff2');
    grad.addColorStop(1, '#d3effc');
    aCtx.fillStyle = grad;
    aCtx.fillRect(0, 0, size, size);

    // Micro frosted calibration border lines
    aCtx.strokeStyle = 'rgba(255,255,255,0.35)';
    aCtx.lineWidth = 1;
    rCtx.strokeStyle = '#555555';
    for (let i = 0; i < size; i += 64) {
      aCtx.beginPath();
      aCtx.moveTo(i, 0);
      aCtx.lineTo(i, size);
      aCtx.stroke();
      rCtx.beginPath();
      rCtx.moveTo(i, 0);
      rCtx.lineTo(i, size);
      rCtx.stroke();
    }
  } else {
    // Acoustic Foam (high-contrast studio wedge absorber tiles with clear architectural ridges)
    aCtx.fillStyle = '#363f4e';
    aCtx.fillRect(0, 0, size, size);
    rCtx.fillStyle = '#e0e0e0';
    rCtx.fillRect(0, 0, size, size);
    bCtx.fillStyle = '#808080';
    bCtx.fillRect(0, 0, size, size);

    const tile = 64;
    for (let ty = 0; ty < size; ty += tile) {
      for (let tx = 0; tx < size; tx += tile) {
        const horiz = ((tx / tile + ty / tile) % 2) === 0;
        for (let k = 0; k < tile; k += 4) {
          const ridge = Math.abs(((k % 16) / 8) - 1);
          const lum = Math.round(46 + ridge * 46);
          const bLum = Math.round(40 + ridge * 175);
          aCtx.fillStyle = `rgb(${lum},${lum + 6},${lum + 14})`;
          bCtx.fillStyle = `rgb(${bLum},${bLum},${bLum})`;
          if (horiz) {
            aCtx.fillRect(tx, ty + k, tile, 4);
            bCtx.fillRect(tx, ty + k, tile, 4);
          } else {
            aCtx.fillRect(tx + k, ty, 4, tile);
            bCtx.fillRect(tx + k, ty, 4, tile);
          }
        }
        // Subtle seam between wedge tiles
        aCtx.strokeStyle = 'rgba(12, 16, 22, 0.55)';
        aCtx.lineWidth = 2;
        aCtx.strokeRect(tx + 1, ty + 1, tile - 2, tile - 2);
      }
    }
  }

  return {
    map: configureTexture(albedoCanvas, true, maxAnisotropy, repeat, repeat),
    roughnessMap: configureTexture(roughCanvas, false, maxAnisotropy, repeat, repeat),
    bumpMap: configureTexture(bumpCanvas, false, maxAnisotropy, repeat, repeat),
  };
}

/**
 * Generates a soft radial contact shadow texture placed flush below the 3D hero object.
 */
export function createContactShadowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.72)');
  grad.addColorStop(0.52, 'rgba(0, 0, 0, 0.34)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates a precision studio calibration floor grid texture.
 */
export function createFloorGridTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, size, size);

  // Fine sub-grid (0.25m subdivisions)
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.09)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= size; i += 64) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(size, i);
    ctx.stroke();
  }

  // Major 1m acoustic calibration lines
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.22)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, size - 2, size - 2);

  // Center crosshair dot
  ctx.fillStyle = 'rgba(56, 189, 248, 0.35)';
  ctx.fillRect(size / 2 - 3, size / 2 - 3, 6, 6);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  tex.anisotropy = Math.max(1, maxAnisotropy);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const n = parseInt(clean, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixRgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number
): string {
  const u = Math.max(0, Math.min(1, t));
  const r = Math.round(a[0] + (b[0] - a[0]) * u);
  const g = Math.round(a[1] + (b[1] - a[1]) * u);
  const bl = Math.round(a[2] + (b[2] - a[2]) * u);
  return `rgb(${r},${g},${bl})`;
}

/**
 * Procedurally synthesizes Albedo, Roughness, and Bump PBR CanvasTextures
 * from a Gemini-generated ProceduralTextureRecipe.
 */
export function createCustomPbrTextureSet(
  recipe: ProceduralTextureRecipe,
  maxAnisotropy: number
): ProceduralTextureSet {
  const size = 256;
  const albedoCanvas = document.createElement('canvas');
  const roughCanvas = document.createElement('canvas');
  const bumpCanvas = document.createElement('canvas');
  albedoCanvas.width = roughCanvas.width = bumpCanvas.width = size;
  albedoCanvas.height = roughCanvas.height = bumpCanvas.height = size;

  const aCtx = albedoCanvas.getContext('2d')!;
  const rCtx = roughCanvas.getContext('2d')!;
  const bCtx = bumpCanvas.getContext('2d')!;

  const c1 = parseHexRgb(recipe.primaryColor);
  const c2 = parseHexRgb(recipe.secondaryColor);
  const c3 = parseHexRgb(recipe.accentColor);
  const scale = Math.max(0.3, Math.min(3.0, recipe.grainScale));
  const contrast = Math.max(0.1, Math.min(1.0, recipe.contrast));
  const bump = Math.max(0.05, Math.min(1.0, recipe.bumpIntensity));

  aCtx.fillStyle = recipe.primaryColor;
  aCtx.fillRect(0, 0, size, size);
  rCtx.fillStyle = '#808080';
  rCtx.fillRect(0, 0, size, size);
  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, size, size);

  if (recipe.pattern === 'ceramic_glaze') {
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        const swirl =
          Math.sin((x * 0.035 + Math.cos(y * 0.03) * 1.4) * scale) * 0.5 + 0.5;
        const speckle = hash2d(x * 0.7, y * 0.7) > 0.965 ? 0.8 : 0;
        const t = Math.min(1, swirl * 0.45 * contrast + speckle * 0.45);
        aCtx.fillStyle = mixRgb(c1, c2, t);
        aCtx.fillRect(x, y, 2, 2);

        const rv = Math.round(38 + t * 55);
        rCtx.fillStyle = `rgb(${rv},${rv},${rv})`;
        rCtx.fillRect(x, y, 2, 2);

        const bv = Math.round(122 + (swirl - 0.5) * 32 * bump);
        bCtx.fillStyle = `rgb(${bv},${bv},${bv})`;
        bCtx.fillRect(x, y, 2, 2);
      }
    }
    aCtx.strokeStyle = `rgba(${c3[0]},${c3[1]},${c3[2]},${(0.18 + contrast * 0.25).toFixed(2)})`;
    bCtx.strokeStyle = `rgb(${Math.round(128 - 55 * bump)},${Math.round(128 - 55 * bump)},${Math.round(128 - 55 * bump)})`;
    aCtx.lineWidth = 1;
    bCtx.lineWidth = 1;
    for (let i = 0; i < 14; i++) {
      let px = hash2d(i, 1.1) * size;
      let py = hash2d(i, 2.7) * size;
      aCtx.beginPath();
      bCtx.beginPath();
      aCtx.moveTo(px, py);
      bCtx.moveTo(px, py);
      for (let seg = 0; seg < 5; seg++) {
        px += (hash2d(i * 7 + seg, 4.2) - 0.5) * 72;
        py += (hash2d(i * 7 + seg, 9.5) - 0.5) * 72;
        aCtx.lineTo(px, py);
        bCtx.lineTo(px, py);
      }
      aCtx.stroke();
      bCtx.stroke();
    }
  } else if (recipe.pattern === 'crystalline_ice') {
    const grad = aCtx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, recipe.primaryColor);
    grad.addColorStop(0.5, recipe.secondaryColor);
    grad.addColorStop(1, recipe.primaryColor);
    aCtx.fillStyle = grad;
    aCtx.fillRect(0, 0, size, size);

    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        const facet = Math.abs(
          Math.sin((x * 0.045 + y * 0.032) * scale) *
            Math.cos((x * 0.028 - y * 0.05) * scale)
        );
        const frost = hash2d(x * 0.35, y * 0.35) * contrast * 0.35;
        aCtx.fillStyle = mixRgb(c1, c2, Math.min(1, facet * contrast * 0.7 + frost));
        aCtx.fillRect(x, y, 2, 2);

        const rv = Math.round(18 + frost * 140 + facet * 32);
        rCtx.fillStyle = `rgb(${rv},${rv},${rv})`;
        rCtx.fillRect(x, y, 2, 2);

        const bv = Math.round(115 + facet * 55 * bump);
        bCtx.fillStyle = `rgb(${bv},${bv},${bv})`;
        bCtx.fillRect(x, y, 2, 2);
      }
    }
    aCtx.strokeStyle = `rgba(${c3[0]},${c3[1]},${c3[2]},0.55)`;
    rCtx.strokeStyle = '#9a9a9a';
    bCtx.strokeStyle = '#ffffff';
    aCtx.lineWidth = 1.2;
    for (let i = 0; i < 18; i++) {
      const sx = hash2d(i, 3.1) * size;
      const sy = hash2d(i, 6.4) * size;
      const angle = hash2d(i, 8.9) * Math.PI * 2;
      const len = 30 + hash2d(i, 12.3) * 85;
      aCtx.beginPath();
      aCtx.moveTo(sx, sy);
      aCtx.lineTo(sx + Math.cos(angle) * len, sy + Math.sin(angle) * len);
      aCtx.stroke();

      rCtx.beginPath();
      rCtx.moveTo(sx, sy);
      rCtx.lineTo(sx + Math.cos(angle) * len, sy + Math.sin(angle) * len);
      rCtx.stroke();

      bCtx.beginPath();
      bCtx.moveTo(sx, sy);
      bCtx.lineTo(sx + Math.cos(angle) * len, sy + Math.sin(angle) * len);
      bCtx.stroke();
    }
  } else if (recipe.pattern === 'brushed_metal') {
    for (let y = 0; y < size; y++) {
      const streak = hash2d(y * scale, 2.1);
      const band = Math.sin(y * 0.08 * scale) * 0.5 + 0.5;
      const t = Math.min(1, (streak * 0.65 + band * 0.35) * contrast);
      aCtx.fillStyle = mixRgb(c1, c2, t);
      aCtx.fillRect(0, y, size, 1);

      const rv = Math.round(42 + streak * 64 * contrast);
      rCtx.fillStyle = `rgb(${rv},${rv},${rv})`;
      rCtx.fillRect(0, y, size, 1);

      const bv = Math.round(112 + streak * 44 * bump);
      bCtx.fillStyle = `rgb(${bv},${bv},${bv})`;
      bCtx.fillRect(0, y, size, 1);
    }
    aCtx.strokeStyle = `rgba(${c3[0]},${c3[1]},${c3[2]},0.28)`;
    aCtx.lineWidth = 1;
    for (let y = 32; y < size; y += 64) {
      aCtx.beginPath();
      aCtx.moveTo(0, y);
      aCtx.lineTo(size, y);
      aCtx.stroke();
    }
  } else if (recipe.pattern === 'molded_plastic') {
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        const stipple = hash2d(x * scale, y * scale);
        const sheen = Math.sin(x * 0.025 + y * 0.02) * 0.5 + 0.5;
        const t = Math.min(1, (stipple * 0.55 + sheen * 0.45) * contrast * 0.65);
        aCtx.fillStyle = mixRgb(c1, c2, t);
        aCtx.fillRect(x, y, 2, 2);

        const rv = Math.round(78 + stipple * 68);
        rCtx.fillStyle = `rgb(${rv},${rv},${rv})`;
        rCtx.fillRect(x, y, 2, 2);

        const bv = Math.round(120 + (stipple - 0.5) * 46 * bump);
        bCtx.fillStyle = `rgb(${bv},${bv},${bv})`;
        bCtx.fillRect(x, y, 2, 2);
      }
    }
    aCtx.strokeStyle = `rgba(${c3[0]},${c3[1]},${c3[2]},0.24)`;
    aCtx.lineWidth = 1;
    aCtx.strokeRect(4, 4, size - 8, size - 8);
  } else if (recipe.pattern === 'organic_grain') {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x += 4) {
        const wave = Math.sin(x * 0.025 * scale) * 3.0;
        const fiber = Math.sin((y + wave) * 0.28 * scale) * 0.5 + 0.5;
        const noise = hash2d(x * 0.4, y * 0.8) * 0.25;
        const t = Math.min(1, (fiber * 0.78 + noise) * contrast);
        aCtx.fillStyle = mixRgb(c1, c2, t);
        aCtx.fillRect(x, y, 4, 1);

        const rv = Math.round(108 + (1 - t) * 76);
        rCtx.fillStyle = `rgb(${rv},${rv},${rv})`;
        rCtx.fillRect(x, y, 4, 1);

        const bv = Math.round(108 + t * 48 * bump);
        bCtx.fillStyle = `rgb(${bv},${bv},${bv})`;
        bCtx.fillRect(x, y, 4, 1);
      }
    }
  } else if (recipe.pattern === 'woven_composite') {
    const cell = Math.max(8, Math.round(16 / scale));
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        const gx = Math.floor(x / cell);
        const gy = Math.floor(y / cell);
        const isWarp = (gx + gy) % 2 === 0;
        const local = isWarp ? (x % cell) / cell : (y % cell) / cell;
        const arch = Math.sin(local * Math.PI);
        const t = Math.min(1, (isWarp ? 0.25 : 0.72) * contrast + arch * 0.25);
        aCtx.fillStyle = mixRgb(c1, c2, t);
        aCtx.fillRect(x, y, 2, 2);

        const rv = Math.round(70 + (1 - arch) * 95);
        rCtx.fillStyle = `rgb(${rv},${rv},${rv})`;
        rCtx.fillRect(x, y, 2, 2);

        const bv = Math.round(92 + arch * 82 * bump);
        bCtx.fillStyle = `rgb(${bv},${bv},${bv})`;
        bCtx.fillRect(x, y, 2, 2);
      }
    }
  } else {
    for (let y = 0; y < size; y += 2) {
      for (let x = 0; x < size; x += 2) {
        const n1 = hash2d(x * 0.6 * scale, y * 0.6 * scale);
        const n2 =
          Math.sin(x * 0.07 * scale) * Math.cos(y * 0.08 * scale) * 0.5 + 0.5;
        const pore = n1 > 0.9 ? 1.0 : 0.0;
        const t = Math.min(1, (n1 * 0.5 + n2 * 0.5) * contrast);
        aCtx.fillStyle = pore > 0.5 ? mixRgb(c2, c3, 0.45) : mixRgb(c1, c2, t);
        aCtx.fillRect(x, y, 2, 2);

        const rv = Math.round(150 + n1 * 90);
        rCtx.fillStyle = `rgb(${rv},${rv},${rv})`;
        rCtx.fillRect(x, y, 2, 2);

        const bv = pore > 0.5 ? Math.round(52) : Math.round(105 + n1 * 75 * bump);
        bCtx.fillStyle = `rgb(${bv},${bv},${bv})`;
        bCtx.fillRect(x, y, 2, 2);
      }
    }
  }

  return {
    map: configureTexture(albedoCanvas, true, maxAnisotropy, 1, 1),
    roughnessMap: configureTexture(roughCanvas, false, maxAnisotropy, 1, 1),
    bumpMap: configureTexture(bumpCanvas, false, maxAnisotropy, 1, 1),
  };
}

