import type { Feature, FeatureCollection } from '@/types';

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Is `needle` a subsequence of `hay` (characters in order, gaps allowed)? */
const isSubsequence = (needle: string, hay: string) => {
  let i = 0;
  for (const ch of hay) {
    if (i < needle.length && ch === needle[i]) i += 1;
  }
  return i >= needle.length;
};

/**
 * The whole-string subsequence match is the only branch that can fire on
 * unrelated text: "jean louis rodolphe swiss zoologist geologist 1807 1873"
 * contains `apollo 11` as a scattered subsequence (a-p-o-l-l-o across three
 * words, then two `1`s in the life dates), which would otherwise leak an
 * eponym gloss into a mission search. So a subsequence hit is only credible
 * when every query *token* can be matched inside a single candidate token —
 * the usual fuzzy-search contract, and cheap to check at 1,585 features.
 */
const tokensCovered = (q: string, n: string) => {
  const tokens = n.split(' ');
  return q
    .split(' ')
    .every((word) => word === '' || tokens.some((t) => isSubsequence(word, t)));
};

export function score(query: string, name: string): number {
  const q = norm(query);
  const n = norm(name);
  if (!q || !n) return 0;
  if (n === q) return 10_000;
  if (n.startsWith(q)) return 5_000 + Math.max(0, 100 - n.length);
  if (n.includes(q)) return 3_000 - Math.min(n.indexOf(q), 500);
  let i = 0;
  let gaps = 0;
  for (const ch of n) {
    if (i < q.length && ch === q[i]) i += 1;
    else if (i < q.length) gaps += 1;
  }
  if (i < q.length) return 0;
  if (!tokensCovered(q, n)) return 0;
  return Math.max(1, 1_000 - gaps);
}

export function fuzzySearch(
  query: string,
  fc: FeatureCollection,
  limit = 8,
): Feature[] {
  if (!norm(query)) return [];
  return fc.features
    .map((f) => {
      const own = score(query, f.properties.name);
      const gloss = score(query, f.properties.gloss) * 0.85;
      const kind = score(query, f.properties.type) * 0.35;
      // There is no feature named "Apollo 11": the mission field is the only
      // route to the visit sites, so it scores just under the feature's own
      // name and above any gloss or descriptor.
      const mission = score(query, f.properties.mission ?? '') * 0.95;
      const best = Math.max(own, gloss, kind, mission);
      if (best === 0) return { f, s: 0 };
      const importance =
        (3 - f.properties.tier) * 40 +
        Math.min(f.properties.diameterKm ?? 0, 300) / 10;
      return { f, s: best + importance };
    })
    .filter((r) => r.s > 0)
    .sort(
      (a, b) =>
        b.s - a.s || a.f.properties.name.localeCompare(b.f.properties.name),
    )
    .slice(0, limit)
    .map((r) => r.f);
}
