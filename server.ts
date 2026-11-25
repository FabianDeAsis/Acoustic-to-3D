import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { normalizeGeneratedMaterialPayload, type RawAiMaterialResponse } from './src/engine/materialGenerator.ts';
import type { PbrMaterialSpec } from './src/engine/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

const MATERIAL_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: {
      type: Type.STRING,
      description: 'Nombre corto y preciso del material en español (máximo 24 caracteres).',
    },
    subtitle: {
      type: Type.STRING,
      description: 'Descripción técnica breve en español (ej. Porcelana esmaltada de pared fina).',
    },
    acousticNotes: {
      type: Type.STRING,
      description: 'Breve nota técnica en español (1 frase) explicando su firma modal y amortiguación.',
    },
    densityKgM3: {
      type: Type.NUMBER,
      description: 'Densidad efectiva en kg/m³ (considere si es hueco o macizo; ej. plástico hueco 350, hielo 917, cerámica hueca 1100, lámina de acero 7850).',
    },
    hardness: {
      type: Type.NUMBER,
      description: 'Dureza / rigidez elástica normalizada entre 0.15 (blando) y 1.0 (muy rígido).',
    },
    elasticity: {
      type: Type.NUMBER,
      description: 'Coeficiente de restitución / elasticidad de rebote entre 0.08 y 0.88.',
    },
    roughness: {
      type: Type.NUMBER,
      description: 'Rugosidad superficial PBR entre 0.04 (espejo/hielo pulido) y 1.0 (muy áspero).',
    },
    metalness: {
      type: Type.NUMBER,
      description: 'Factor metálico PBR entre 0.0 (dieléctrico) y 1.0 (metal puro).',
    },
    transmission: {
      type: Type.NUMBER,
      description: 'Transmisión óptica entre 0.0 (opaco) y 0.92 (hielo/vidrio translúcido).',
    },
    ior: {
      type: Type.NUMBER,
      description: 'Índice de refracción entre 1.15 y 2.2 (hielo 1.31, vidrio 1.52, plástico 1.49).',
    },
    clearcoat: {
      type: Type.NUMBER,
      description: 'Capa de barniz / esmalte superficial PBR entre 0.0 y 1.0 (cerámica esmaltada ~0.85).',
    },
    frictionCoeff: {
      type: Type.NUMBER,
      description: 'Coeficiente de fricción cinética al arrastre entre 0.12 (hielo) y 0.95.',
    },
    neuralHarmonicDrive: {
      type: Type.NUMBER,
      description: 'Saturación armónica no lineal del acondicionamiento DDSP entre 0.08 y 0.70.',
    },
    neuralFormantHz: {
      type: Type.NUMBER,
      description: 'Frecuencia central del formante característico del cuerpo en Hz (180 a 7500).',
    },
    modes: {
      type: Type.ARRAY,
      description: 'Exactamente 12 modos propios resonantes principales ordenados de menor a mayor frecuencia (Hz).',
      items: {
        type: Type.OBJECT,
        properties: {
          frequencyHz: {
            type: Type.NUMBER,
            description: 'Frecuencia modal propia en Hz (entre 55 y 16500 Hz).',
          },
          gain: {
            type: Type.NUMBER,
            description: 'Amplitud relativa de excitación del modo entre 0.05 y 1.0.',
          },
          qFactor: {
            type: Type.NUMBER,
            description: 'Factor de calidad Q del filtro resonante entre 8 (muy amortiguado, plástico/madera) y 300 (muy resonante, acero/cerámica/vidrio).',
          },
        },
        required: ['frequencyHz', 'gain', 'qFactor'],
      },
    },
    texture: {
      type: Type.OBJECT,
      description: 'Receta visual para sintetizar los mapas PBR procedurales (albedo, rugosidad y relieve) en Canvas 2D.',
      properties: {
        pattern: {
          type: Type.STRING,
          description: 'Uno exactamente de: ceramic_glaze, brushed_metal, crystalline_ice, molded_plastic, organic_grain, porous_mineral, woven_composite.',
        },
        primaryColor: {
          type: Type.STRING,
          description: 'Color albedo principal en formato hexadecimal #RRGGBB.',
        },
        secondaryColor: {
          type: Type.STRING,
          description: 'Color secundario de veta/sombra/microestructura en formato hexadecimal #RRGGBB.',
        },
        accentColor: {
          type: Type.STRING,
          description: 'Color de acento especular o veta fina en formato hexadecimal #RRGGBB.',
        },
        grainScale: {
          type: Type.NUMBER,
          description: 'Escala espacial del grano procedural entre 0.3 y 3.0.',
        },
        contrast: {
          type: Type.NUMBER,
          description: 'Contraste visual de la textura entre 0.1 y 1.0.',
        },
        bumpIntensity: {
          type: Type.NUMBER,
          description: 'Intensidad del mapa de relieve/bump PBR entre 0.05 y 1.0.',
        },
      },
      required: [
        'pattern',
        'primaryColor',
        'secondaryColor',
        'accentColor',
        'grainScale',
        'contrast',
        'bumpIntensity',
      ],
    },
  },
  required: [
    'name',
    'subtitle',
    'acousticNotes',
    'densityKgM3',
    'hardness',
    'elasticity',
    'roughness',
    'metalness',
    'transmission',
    'ior',
    'clearcoat',
    'frictionCoeff',
    'neuralHarmonicDrive',
    'neuralFormantHz',
    'modes',
    'texture',
  ],
};

function createGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new Error('MISSING_GEMINI_API_KEY');
  }
  return new GoogleGenAI({
    apiKey: apiKey.trim(),
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

interface GenerationCandidate {
  model: 'gemini-4-hydrogen' | 'gemini-3.1-flash-lite';
  thinkingLevel: ThinkingLevel;
  timeoutMs: number;
  delayBeforeMs: number;
}

const GENERATION_PIPELINE: GenerationCandidate[] = [
  {
    model: 'gemini-4-hydrogen',
    thinkingLevel: ThinkingLevel.LOW,
    timeoutMs: 20_000,
    delayBeforeMs: 0,
  },
  {
    model: 'gemini-3.1-flash-lite',
    thinkingLevel: ThinkingLevel.MINIMAL,
    timeoutMs: 15_000,
    delayBeforeMs: 350,
  },
  {
    model: 'gemini-3.1-flash-lite',
    thinkingLevel: ThinkingLevel.MINIMAL,
    timeoutMs: 15_000,
    delayBeforeMs: 1_800,
  },
];

const MATERIAL_CACHE_MAX = 64;
const materialCache = new Map<string, PbrMaterialSpec>();
const inFlightRequests = new Map<string, Promise<PbrMaterialSpec>>();

function makeCacheKey(prompt: string): string {
  return prompt
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function saveToMaterialCache(key: string, spec: PbrMaterialSpec): void {
  if (materialCache.has(key)) {
    materialCache.delete(key);
  } else if (materialCache.size >= MATERIAL_CACHE_MAX) {
    const oldestKey = materialCache.keys().next().value;
    if (oldestKey) materialCache.delete(oldestKey);
  }
  materialCache.set(key, spec);
}

function isAuthError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  const message = err instanceof Error ? err.message : String(err);
  return (
    message === 'MISSING_GEMINI_API_KEY' ||
    status === 401 ||
    status === 403 ||
    /API_KEY_INVALID|PERMISSION_DENIED/i.test(message)
  );
}

async function generateMaterialWithFailover(prompt: string): Promise<RawAiMaterialResponse> {
  const ai = createGeminiClient();
  const systemInstruction = [
    'Eres un físico acústico, ingeniero de DSP modal y artista de materiales PBR.',
    'Dado el nombre o descripción de un material físico (macizo, hueco, laminar, cristalino, orgánico o polímero),',
    'calcula parámetros físicamente realistas para síntesis modal a 48 kHz y renderizado PBR en Three.js.',
    'Asegúrate de devolver exactamente 12 modos resonantes realistas:',
    '- Para objetos huecos (ej. cerámica hueca, plástico hueco), incluye una resonancia de cavidad Helmholtz/cuerpo en graves-medios más modos de pared inarmónicos.',
    '- Para láminas metálicas (ej. lámina de acero), usa densidad de modos inarmónicos de placa delgada con alto Q y brillo metálico.',
    '- Para hielo, usa transmisión óptica alta, fricción muy baja, micro-fracturas cristalinas y modos agudos nítidos con amortiguación moderada.',
    '- Los colores hexadecimales deben ser creíbles y fotorealistas bajo iluminación de estudio ACES Filmic.',
  ].join(' ');

  let lastError: unknown;
  for (const candidate of GENERATION_PIPELINE) {
    if (candidate.delayBeforeMs > 0) {
      await new Promise((r) => setTimeout(r, candidate.delayBeforeMs));
    }

    try {
      const response = await ai.models.generateContent({
        model: candidate.model,
        contents: `Genera la caracterización física PBR, los 12 modos resonantes principales y la receta de textura procedural para el material: "${prompt}".`,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: MATERIAL_SCHEMA,
          abortSignal: AbortSignal.timeout(candidate.timeoutMs),
          thinkingConfig: {
            thinkingLevel: candidate.thinkingLevel,
          },
        },
      });

      const rawText = (response.text ?? '')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      if (!rawText) {
        throw new Error('El modelo devolvió una respuesta vacía.');
      }
      return JSON.parse(rawText) as RawAiMaterialResponse;
    } catch (err) {
      lastError = err;
      if (isAuthError(err)) {
        break;
      }
      // For 429 quota bursts, 5xx errors, timeouts, or malformed output, fail over to next candidate
    }
  }
  throw lastError;
}

async function resolveOrGenerateMaterial(prompt: string): Promise<PbrMaterialSpec> {
  const cacheKey = makeCacheKey(prompt);
  const cached = materialCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = inFlightRequests.get(cacheKey);
  if (pending) {
    return pending;
  }

  const task = (async () => {
    const rawMaterial = await generateMaterialWithFailover(prompt);
    const spec = normalizeGeneratedMaterialPayload(rawMaterial, prompt);
    saveToMaterialCache(cacheKey, spec);
    return spec;
  })();

  inFlightRequests.set(cacheKey, task);
  try {
    return await task;
  } finally {
    inFlightRequests.delete(cacheKey);
  }
}

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.post('/api/generate-material', async (req, res) => {
    const rawPrompt = typeof req.body?.prompt === 'string' ? req.body.prompt : '';
    const prompt = rawPrompt
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!prompt || prompt.length < 2) {
      res.status(400).json({
        error: 'Escribe el nombre de un material válido (mínimo 2 caracteres).',
      });
      return;
    }

    if (prompt.length > 100) {
      res.status(400).json({
        error: 'La descripción del material no debe superar los 100 caracteres.',
      });
      return;
    }

    try {
      const spec = await resolveOrGenerateMaterial(prompt);
      res.json({ material: spec });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : '';
      const status = (err as { status?: number })?.status;

      if (message === 'MISSING_GEMINI_API_KEY') {
        res.status(503).json({
          error:
            'No hay una clave GEMINI_API_KEY configurada en el servidor. Configúrala en Settings > Secrets para activar el generador IA.',
        });
        return;
      }

      if (name === 'TimeoutError' || name === 'AbortError') {
        res.status(504).json({
          error: 'Tiempo de espera agotado al consultar Gemini API. Inténtalo de nuevo.',
        });
        return;
      }

      if (status === 403 || status === 401 || /API_KEY_INVALID|PERMISSION_DENIED/i.test(message)) {
        res.status(403).json({
          error:
            'La clave de Gemini API no es válida o no tiene permisos. Verifica tu clave en Settings > Secrets.',
        });
        return;
      }

      if (status === 429 || /RESOURCE_EXHAUSTED/i.test(message)) {
        res.status(429).json({
          error:
            'Límite temporal de solicitudes alcanzado en Gemini API. Espera unos segundos y pulsa Reintentar.',
        });
        return;
      }

      res.status(502).json({
        error: 'No se pudo generar el material con Gemini API. Inténtalo de nuevo.',
      });
    }
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build not found');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Acoustic-to-3D Studio server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
