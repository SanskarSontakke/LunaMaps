/**
 * The manifest failure kinds, in a module of their own.
 *
 * `diagnostics.runBoot` has to tell "there is no imagery here yet" apart from "there is
 * a manifest and this build cannot use it", and it must do that from a *type*, not by
 * matching the wording of a message. But it cannot import `assets.ts` to get the class:
 * the whole testability of the boot order rests on `runBoot` receiving `loadManifest`
 * and `probeAssets` as injected dependencies rather than importing the network layer
 * (see its docstring). So the shared contract lives here — a module with no React, no
 * `fetch` and no Cesium in it.
 */
export type ManifestErrorKind = 'http' | 'incompatible';

export class ManifestError extends Error {
  readonly kind: ManifestErrorKind;
  /** The HTTP status, when the failure was a status. */
  readonly status?: number;
  /** The URL that was asked for, so the panel can name where it looked. */
  readonly url?: string;

  constructor(kind: ManifestErrorKind, message: string, details?: { status?: number; url?: string }) {
    super(message);
    this.name = 'ManifestError';
    this.kind = kind;
    // Assigned conditionally rather than defaulted: `assets.ts` builds the object field
    // by field from values that passed a predicate, and this follows the same rule — an
    // `undefined` field is not the same as a field that says nothing.
    if (details?.status !== undefined) this.status = details.status;
    if (details?.url !== undefined) this.url = details.url;
  }
}
