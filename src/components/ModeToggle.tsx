'use client';
import type { Mode } from '@/types';

const LABELS: Record<Mode, string> = { paper: 'Paper', globe: 'Globe' };

export default function ModeToggle({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
}) {
  return (
    <div className="ctl ctl-mode" role="group" aria-label="View mode">
      {(['paper', 'globe'] as Mode[]).map((m) => (
        <button
          key={m}
          type="button"
          className={m === mode ? 'on' : ''}
          aria-pressed={m === mode}
          onClick={() => onChange(m)}
        >
          {LABELS[m]}
        </button>
      ))}
    </div>
  );
}
