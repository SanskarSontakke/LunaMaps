'use client';
import type { LayerName } from '@/types';

const LABELS: Record<'paper' | 'photo', string> = {
  paper: 'Albedo',
  photo: 'Colour relief',
};

export default function LayerChips({
  layer,
  onChange,
}: {
  layer: LayerName;
  onChange: (l: LayerName) => void;
}) {
  return (
    <div className="ctl ctl-layer" role="group" aria-label="Imagery layer">
      {(['paper', 'photo'] as LayerName[]).map((l) => (
        <button
          key={l}
          type="button"
          className={l === layer ? 'on' : ''}
          aria-pressed={l === layer}
          onClick={() => onChange(l)}
        >
          {LABELS[l as 'paper' | 'photo']}
        </button>
      ))}
    </div>
  );
}
