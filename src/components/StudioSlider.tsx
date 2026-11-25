import React from 'react';

interface StudioSliderProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  formatValue?: (val: number) => string;
  onChange: (value: number) => void;
}

export const StudioSlider: React.FC<StudioSliderProps> = ({
  id,
  label,
  value,
  min,
  max,
  step,
  unit = '',
  formatValue,
  onChange,
}) => {
  const display = formatValue ? formatValue(value) : `${value.toFixed(2)}${unit}`;
  const pct = Math.max(0, Math.min(100, ((value - min) / Math.max(1e-6, max - min)) * 100));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <label htmlFor={id} className="font-medium text-slate-300 truncate">
          {label}
        </label>
        <span className="font-mono tabular-nums text-amber-400 shrink-0">{display}</span>
      </div>
      <div className="relative flex items-center h-5">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="studio-slider"
          style={{
            background: `linear-gradient(to right, #f59e0b 0%, #f59e0b ${pct}%, #222834 ${pct}%, #222834 100%)`,
          }}
        />
      </div>
    </div>
  );
};
