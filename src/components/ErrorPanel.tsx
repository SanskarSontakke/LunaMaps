'use client';
import type { BootErrorKind, BootStep } from '@/lib/diagnostics';
import { bootHint, stepLabel } from '@/lib/diagnostics';

/**
 * A boot failure that is NOT about missing imagery: no WebGL2, a Cesium worker
 * 404, or something unclassified.
 *
 * `bootHint(kind)` carries the fix (for `cesiumBase` it is the
 * `npm run postinstall` / `public/cesium/Workers/` sentence, which is exactly
 * what a wrong or unset `CESIUM_BASE_URL` looks like from the user's side). For
 * `unknown` there is no category to hide behind, so the raw message is shown
 * verbatim in a `<pre>`.
 *
 * Retryability: this panel is a *state*, not a latch — it stores nothing, and
 * MoonMap clears its boot state before re-running the boot effect. One failed
 * attempt therefore cannot dedupe the next one, which is the mistake Task 10's
 * first morph latch made and its fix corrected.
 */
export default function ErrorPanel({
  kind,
  step,
  message,
  onRetry,
}: {
  kind: BootErrorKind;
  step?: BootStep;
  /** The raw message, shown in a `<pre>` for `unknown`, collapsible otherwise. */
  message?: string;
  onRetry: () => void;
}) {
  return (
    <div className="panel" role="alert" aria-live="assertive">
      <div className="panel-card">
        <h1 className="panel-title">
          {kind === 'webgl'
            ? 'This browser cannot run the map'
            : `The map failed to start (${step ? stepLabel(step) : kind})`}
        </h1>
        <p className="panel-hint">{bootHint(kind)}</p>
        {kind === 'unknown' ? (
          <pre className="panel-pre">{message ?? 'no message'}</pre>
        ) : (
          message && (
            <details className="panel-more">
              <summary>Raw error</summary>
              <pre className="panel-pre">{message}</pre>
            </details>
          )
        )}
        <button type="button" className="panel-retry" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}
