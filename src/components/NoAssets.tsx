'use client';
import { assetCommands } from '@/lib/diagnostics';
import { TILES_BASE, tilesAreRemote } from '@/lib/tileSource';

/**
 * The unbaked-app path: imagery is not where this build was told to look, so nothing
 * can be drawn.
 *
 * The delivered pyramid is 87,380 files and 2,819,245,403 B across `paper` and `photo`,
 * plus 7,106 deep-zoom tiles at 187,755,158 B — all git-ignored by design, because that
 * is build output. So a fresh clone of this repository legitimately has no
 * `public/tiles` directory at all, and a deployment pointed at external storage can
 * equally find nothing at the other end. Neither is an error to hide: this panel says so
 * with the exact thing to do.
 *
 * `missing` is the honest list: the paths `probeAssets` actually got a
 * non-2xx for (src/lib/assets.ts), or the manifest URL when the manifest itself failed
 * to load. Nothing is inferred beyond what was probed, and the advice shown is derived
 * from those same paths, so an absent manifest cannot be "fixed" by a bare bake — and
 * a misconfigured storage base cannot be fixed by one either, which is why the two cases
 * get different sentences.
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
  // `probeAssets` reports URL paths. A root-relative one is this origin's `/tiles/...`,
  // i.e. a file that belongs in `public/`; an absolute https URL means the deployment
  // was pointed at external storage, and then the honest thing to show is the URL that
  // failed — not a `public/...` path that never existed on this machine.
  const shown = (p: string) =>
    /^https?:\/\//.test(p) ? p : `public/${p.replace(/^\/+/, '')}`;
  const remote = tilesAreRemote();
  return (
    <div className="panel" role="alert" aria-live="assertive">
      <div className="panel-card">
        <h1 className="panel-title">Imagery has not been baked yet</h1>
        <p className="panel-hint">
          {remote
            ? `This build was configured to read imagery from ${TILES_BASE} — ` +
              'nothing answered there. Check that the store is reachable and that it ' +
              'sends Access-Control-Allow-Origin for tile requests.'
            : 'public/tiles/ is git-ignored by design — the baked pyramids are 2.82 GB ' +
              'of base imagery (plus 188 MB of deep-zoom tiles), never committed. A fresh ' +
              'clone must bake them before the map can draw anything.'}
        </p>
        <h2 className="panel-sub">Missing</h2>
        <ul className="panel-list">
          {missing.map((p) => (
            <li key={p}>
              <code>{shown(p)}</code>
            </li>
          ))}
        </ul>
        <h2 className="panel-sub">Run this</h2>
        <pre className="panel-pre">
          <code>
            {remote
              ? `Check ${TILES_BASE} answers these paths and sends Access-Control-Allow-Origin, ` +
                'then rebuild with NEXT_PUBLIC_TILE_BASE_URL set correctly.'
              : commands}
          </code>
        </pre>
        <p className="panel-note">
          {remote
            ? 'This deployment reads its imagery from external storage, so a bake on this ' +
              'machine would change nothing: the browser is asking somewhere else.'
            : 'The bake writes the pyramids and the manifest; the browser will not see a ' +
              'file that was never written, so this panel is the correct state until that ' +
              'command finishes.'}
        </p>
        <button type="button" className="panel-retry" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}
