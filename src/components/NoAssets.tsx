'use client';
import { assetCommands } from '@/lib/diagnostics';

/**
 * The unbaked-app path: imagery is not on disk, so nothing can be drawn.
 *
 * Tier A tiles (21,844 files, ~1.9 GB across both layers) are git-ignored by
 * design, so a fresh clone of this repository legitimately has no `public/tiles`
 * directory at all. That is not an error to hide — it is a missing build step,
 * and this panel says so with the exact command.
 *
 * `missing` is the honest list: the paths `probeAssets` actually got a
 * non-2xx for (src/lib/assets.ts), or `tiles/manifest.json` when the manifest
 * itself failed to load. Nothing is inferred beyond what was probed, and the
 * command shown is derived from those same paths, so an absent manifest cannot
 * be "fixed" by a bare bake.
 *
 * Retryable by construction: the panel holds no state, and MoonMap re-runs its
 * boot effect on `Try again` (bumping a nonce, so React does not swallow the
 * repeat). After a successful bake the same click brings up the map — no reload.
 */
export default function NoAssets({
  missing,
  onRetry,
}: {
  missing: string[];
  onRetry: () => void;
}) {
  const commands = assetCommands(missing);
  // `probeAssets` reports URL paths (`/tiles/photo/0/0/0.jpg`); the reader needs
  // the on-disk path, so the leading slash is dropped rather than doubled.
  const disk = (p: string) => `public/${p.replace(/^\/+/, '')}`;
  return (
    <div className="panel" role="alert" aria-live="assertive">
      <div className="panel-card">
        <h1 className="panel-title">Imagery has not been baked yet</h1>
        <p className="panel-hint">
          <code>public/tiles/</code> is git-ignored by design — the baked pyramids
          are ~1.9 GB of build output, never committed. A fresh clone must bake
          them before the map can draw anything.
        </p>
        <h2 className="panel-sub">Missing</h2>
        <ul className="panel-list">
          {missing.map((p) => (
            <li key={p}>
              <code>{disk(p)}</code>
            </li>
          ))}
        </ul>
        <h2 className="panel-sub">Run this</h2>
        <pre className="panel-pre">
          <code>{commands}</code>
        </pre>
        <p className="panel-note">
          The bake writes the pyramids and the manifest; the browser will not see a
          file that was never written, so this panel is the correct state until that
          command finishes.
        </p>
        <button type="button" className="panel-retry" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}
