import React, { useEffect, useRef, useState } from 'react';
import type { AcousticAudioEngine } from '../engine/audioEngine';
import type {
  AnalyzerViewId,
  AudioMeterSnapshot,
  MeasuredIrSummary,
  ModalPartial,
} from '../engine/types';

interface SpectrumAnalyzerProps {
  audioEngine: AcousticAudioEngine;
  audioActive: boolean;
  modalBank: ModalPartial[];
  rt60Seconds: number;
  irVersion: number;
  measuredIrSummary?: MeasuredIrSummary | null;
  viewTrigger?: { view: AnalyzerViewId; nonce: number } | null;
}

const FREQ_TICKS = [20, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 20000];
const DB_TICKS = [-12, -24, -48, -72];
const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const MIN_DB = -90;
const MAX_DB = 0;

function freqToX(freq: number, width: number): number {
  const clamped = Math.max(MIN_FREQ, Math.min(MAX_FREQ, freq));
  const norm = Math.log10(clamped / MIN_FREQ) / Math.log10(MAX_FREQ / MIN_FREQ);
  return norm * width;
}

function dbToY(db: number, height: number): number {
  const clamped = Math.max(MIN_DB, Math.min(MAX_DB, db));
  const norm = (clamped - MIN_DB) / (MAX_DB - MIN_DB);
  return height - norm * height;
}

export const SpectrumAnalyzer: React.FC<SpectrumAnalyzerProps> = ({
  audioEngine,
  audioActive,
  modalBank,
  rt60Seconds,
  irVersion,
  measuredIrSummary,
  viewTrigger,
}) => {
  const [view, setView] = useState<AnalyzerViewId>('spectrum');
  const [meters, setMeters] = useState<AudioMeterSnapshot>({
    peakDb: -96,
    rmsDb: -96,
    lufsMomentary: -96,
    sampleRate: 48000,
    latencyMs: 0,
    activeVoices: 0,
  });

  useEffect(() => {
    if (viewTrigger) {
      setView(viewTrigger.view);
    }
  }, [viewTrigger]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const peakHoldRef = useRef<Float32Array>(new Float32Array(256).fill(MIN_DB));
  const propsRef = useRef({
    view,
    audioActive,
    modalBank,
    rt60Seconds,
    irVersion,
    measuredIrSummary,
  });
  propsRef.current = {
    view,
    audioActive,
    modalBank,
    rt60Seconds,
    irVersion,
    measuredIrSummary,
  };

  useEffect(() => {
    let timerId = 0;
    let lastMeterUpdate = 0;

    const renderFrame = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cssW = Math.max(200, canvas.clientWidth);
        const cssH = Math.max(120, canvas.clientHeight);
        if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
          canvas.width = Math.round(cssW * dpr);
          canvas.height = Math.round(cssH * dpr);
        }

        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.save();
          ctx.scale(dpr, dpr);

          const padL = 32;
          const padR = 8;
          const padT = 10;
          const padB = 20;
          const plotW = Math.max(80, cssW - padL - padR);
          const plotH = Math.max(60, cssH - padT - padB);

          // FabFilter-inspired deep obsidian plot canvas
          ctx.fillStyle = '#090b10';
          ctx.fillRect(0, 0, cssW, cssH);

          const sample = audioEngine.sampleAnalyzer();
          const now = performance.now();
          if (now - lastMeterUpdate >= 120) {
            lastMeterUpdate = now;
            setMeters(sample.meters);
          }

          const { view: currentView, modalBank: modes, rt60Seconds: rt60 } = propsRef.current;

          ctx.save();
          ctx.translate(padL, padT);

          if (currentView === 'spectrum') {
            // Vertical logarithmic frequency grid
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.09)';
            ctx.lineWidth = 1;
            ctx.font = '10px "JetBrains Mono", monospace';
            ctx.fillStyle = '#64748b';
            ctx.textAlign = 'center';

            for (const hz of FREQ_TICKS) {
              const x = Math.round(freqToX(hz, plotW)) + 0.5;
              ctx.beginPath();
              ctx.moveTo(x, 0);
              ctx.lineTo(x, plotH);
              ctx.stroke();

              const label = hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
              ctx.fillText(label, x, plotH + 13);
            }

            // Horizontal dB grid
            ctx.textAlign = 'right';
            for (const db of DB_TICKS) {
              const y = Math.round(dbToY(db, plotH)) + 0.5;
              ctx.beginPath();
              ctx.moveTo(0, y);
              ctx.lineTo(plotW, y);
              ctx.stroke();
              ctx.fillText(`${db}`, -5, y + 3);
            }

            // Active PBR Modal Resonance markers (subtle cyan guide pins)
            for (let m = 0; m < modes.length; m++) {
              const partial = modes[m];
              const mx = freqToX(partial.frequencyHz, plotW);
              const markerH = Math.max(12, plotH * (0.25 + partial.gain * 0.65));
              ctx.strokeStyle = 'rgba(56, 189, 248, 0.24)';
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(mx, plotH);
              ctx.lineTo(mx, plotH - markerH);
              ctx.stroke();

              ctx.fillStyle = 'rgba(56, 189, 248, 0.72)';
              ctx.beginPath();
              ctx.arc(mx, plotH - markerH, 2.2, 0, Math.PI * 2);
              ctx.fill();
            }

            // Sample FFT bins across 256 log-spaced columns
            const freqData = sample.frequencyDb;
            const nyquist = sample.meters.sampleRate * 0.5;
            const binCount = freqData.length;
            const cols = 256;
            const peakHold = peakHoldRef.current;

            const xs: number[] = new Array(cols);
            const ys: number[] = new Array(cols);
            const peakYs: number[] = new Array(cols);

            for (let c = 0; c < cols; c++) {
              const t = c / (cols - 1);
              const hz = MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, t);
              const exactBin = (hz / nyquist) * binCount;
              const idx0 = Math.max(0, Math.min(binCount - 1, Math.floor(exactBin)));
              const idx1 = Math.min(binCount - 1, idx0 + 1);
              const frac = exactBin - idx0;
              const rawDb = freqData[idx0] * (1 - frac) + freqData[idx1] * frac;
              const clampedDb = Number.isFinite(rawDb) ? Math.max(MIN_DB, Math.min(MAX_DB, rawDb)) : MIN_DB;

              // Smooth peak hold decay
              if (clampedDb > peakHold[c]) {
                peakHold[c] = clampedDb;
              } else {
                peakHold[c] = Math.max(MIN_DB, peakHold[c] - 0.55);
              }

              xs[c] = t * plotW;
              ys[c] = dbToY(clampedDb, plotH);
              peakYs[c] = dbToY(peakHold[c], plotH);
            }

            // Peak-hold trace
            ctx.beginPath();
            for (let c = 0; c < cols; c++) {
              if (c === 0) ctx.moveTo(xs[c], peakYs[c]);
              else ctx.lineTo(xs[c], peakYs[c]);
            }
            ctx.strokeStyle = 'rgba(245, 158, 11, 0.32)';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Filled FabFilter spectrum gradient
            const fillGrad = ctx.createLinearGradient(0, 0, 0, plotH);
            fillGrad.addColorStop(0, 'rgba(245, 158, 11, 0.44)');
            fillGrad.addColorStop(0.55, 'rgba(245, 158, 11, 0.14)');
            fillGrad.addColorStop(1, 'rgba(245, 158, 11, 0.02)');

            ctx.beginPath();
            ctx.moveTo(0, plotH);
            for (let c = 0; c < cols; c++) {
              ctx.lineTo(xs[c], ys[c]);
            }
            ctx.lineTo(plotW, plotH);
            ctx.closePath();
            ctx.fillStyle = fillGrad;
            ctx.fill();

            // Crisp glowing spectrum curve stroke
            ctx.beginPath();
            for (let c = 0; c < cols; c++) {
              if (c === 0) ctx.moveTo(xs[c], ys[c]);
              else ctx.lineTo(xs[c], ys[c]);
            }
            ctx.strokeStyle = '#fbbf24';
            ctx.lineWidth = 1.65;
            ctx.stroke();
          } else if (currentView === 'oscilloscope') {
            // Center 0.0 axis & amplitude guides
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, plotH / 2);
            ctx.lineTo(plotW, plotH / 2);
            ctx.stroke();

            ctx.strokeStyle = 'rgba(148, 163, 184, 0.07)';
            for (const frac of [0.2, 0.8]) {
              ctx.beginPath();
              ctx.moveTo(0, plotH * frac);
              ctx.lineTo(plotW, plotH * frac);
              ctx.stroke();
            }

            ctx.font = '10px "JetBrains Mono", monospace';
            ctx.fillStyle = '#64748b';
            ctx.textAlign = 'right';
            ctx.fillText('+1.0', -4, 10);
            ctx.fillText('0.0', -4, plotH / 2 + 3);
            ctx.fillText('-1.0', -4, plotH);

            const td = sample.timeDomain;
            const stride = Math.max(1, Math.floor(td.length / plotW));
            ctx.beginPath();
            for (let x = 0; x < plotW; x++) {
              const idx = Math.min(td.length - 1, x * stride);
              const val = Math.max(-1, Math.min(1, td[idx] * 1.4));
              const y = plotH * 0.5 - val * (plotH * 0.46);
              if (x === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            }
            ctx.strokeStyle = '#38bdf8';
            ctx.lineWidth = 1.6;
            ctx.stroke();

            ctx.textAlign = 'center';
            ctx.fillStyle = '#64748b';
            ctx.fillText('Forma de onda en tiempo real (48 kHz)', plotW / 2, plotH + 13);
          } else {
            // Room Impulse Response (IR) Envelope Visualization
            const ir = audioEngine.getLatestIr();
            const env = ir.envelopePreview;
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.1)';
            ctx.lineWidth = 1;
            for (const frac of [0.25, 0.5, 0.75]) {
              ctx.beginPath();
              ctx.moveTo(0, plotH * frac);
              ctx.lineTo(plotW, plotH * frac);
              ctx.stroke();
            }

            const barW = plotW / env.length;
            for (let i = 0; i < env.length; i++) {
              const mag = Math.min(1, env[i]);
              const h = mag * plotH * 0.92;
              const isEarly = i < Math.max(3, Math.floor(env.length * 0.08));
              ctx.fillStyle = isEarly ? '#f59e0b' : 'rgba(56, 189, 248, 0.65)';
              ctx.fillRect(i * barW, plotH - h, Math.max(1, barW - 0.8), h);
            }

            ctx.font = '10px "JetBrains Mono", monospace';
            ctx.fillStyle = '#94a3b8';
            ctx.textAlign = 'left';
            ctx.fillText('0 ms', 0, plotH + 13);
            ctx.textAlign = 'center';
            const measured = propsRef.current.measuredIrSummary;
            const irLabel = measured
              ? `IR Medida (${measured.micPosition.x.toFixed(1)}, ${measured.micPosition.y.toFixed(1)}, ${measured.micPosition.z.toFixed(1)})m · RT60 ${measured.rt60Seconds.toFixed(2)}s · 24-bit/48kHz`
              : `RT60 ${rt60.toFixed(2)} s · IR Convolución 48 kHz`;
            ctx.fillText(irLabel, plotW / 2, plotH + 13);
            ctx.textAlign = 'right';
            ctx.fillText(`${Math.round(ir.durationSec * 1000)} ms`, plotW, plotH + 13);
          }

          ctx.restore();
          ctx.restore();
        }
      }

      // Pace smoothly (~24 fps is fluid for meters while remaining ultra-light on CPU/Software WebGL)
      timerId = window.setTimeout(renderFrame, 42);
    };

    renderFrame();
    return () => {
      window.clearTimeout(timerId);
    };
  }, [audioEngine]);

  const peakPct = Math.max(0, Math.min(100, ((meters.peakDb + 72) / 72) * 100));
  const rmsPct = Math.max(0, Math.min(100, ((meters.rmsDb + 72) / 72) * 100));

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Analyzer Toolbar */}
      <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-white/8 shrink-0">
        <div className="flex items-center gap-1 bg-[#141821] p-0.5 rounded-md border border-white/8">
          {(
            [
              { id: 'spectrum', label: 'Espectro FFT' },
              { id: 'oscilloscope', label: 'Osciloscopio' },
              { id: 'ir', label: 'Respuesta IR' },
            ] as Array<{ id: AnalyzerViewId; label: string }>
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setView(item.id)}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                view === item.id
                  ? 'bg-[#222938] text-amber-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2.5 text-[11px] font-mono tabular-nums text-slate-400 whitespace-nowrap">
          <span>
            LUFS <strong className="text-slate-200">{meters.lufsMomentary <= -90 ? '-∞' : meters.lufsMomentary.toFixed(1)}</strong>
          </span>
          <span aria-hidden="true" className="text-slate-600">·</span>
          <span>
            Pico <strong className={meters.peakDb > -3 ? 'text-amber-400' : 'text-slate-200'}>{meters.peakDb <= -90 ? '-∞' : `${meters.peakDb.toFixed(1)} dB`}</strong>
          </span>
          <span aria-hidden="true" className="text-slate-600 hidden sm:inline">·</span>
          <span className="hidden sm:inline text-slate-400">
            {audioActive ? `${(meters.sampleRate / 1000).toFixed(0)} kHz` : 'En espera'}
          </span>
        </div>
      </div>

      {/* Plot + Vertical Studio LUFS/Peak Meter */}
      <div className="flex-1 flex min-h-0 p-3 gap-3">
        <div className="flex-1 relative min-h-0 rounded border border-white/8 overflow-hidden bg-[#090b10]">
          <canvas
            ref={canvasRef}
            data-testid="spectrum-canvas"
            className="w-full h-full block"
          />
        </div>

        {/* Stereo RMS/Peak Bar Meter */}
        <div
          className="w-9 shrink-0 flex flex-col items-center justify-between py-1 px-1.5 rounded border border-white/8 bg-[#090b10]"
          aria-label="Medidor de nivel dBFS"
        >
          <span className="text-[9px] font-mono text-slate-500">dB</span>
          <div className="flex-1 w-full flex items-end justify-center gap-1 my-1.5">
            <div className="w-2 h-full bg-[#151a24] rounded-xs overflow-hidden flex items-end">
              <div
                className="w-full transition-[height] duration-75"
                style={{
                  height: `${rmsPct}%`,
                  background: 'linear-gradient(to top, #0284c7, #38bdf8, #f59e0b)',
                }}
              />
            </div>
            <div className="w-2 h-full bg-[#151a24] rounded-xs overflow-hidden flex items-end">
              <div
                className="w-full transition-[height] duration-75"
                style={{
                  height: `${peakPct}%`,
                  background:
                    peakPct > 90
                      ? '#ef4444'
                      : 'linear-gradient(to top, #d97706, #fbbf24)',
                }}
              />
            </div>
          </div>
          <span className="text-[9px] font-mono tabular-nums text-slate-400">
            {meters.peakDb <= -90 ? '--' : Math.round(meters.peakDb)}
          </span>
        </div>
      </div>
    </div>
  );
};
