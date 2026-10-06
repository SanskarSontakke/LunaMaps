// Gate G1 tiling probe (Task 2) — a committed DIAGNOSTIC, not a test: it prints the
// values and exits 0, and nothing asserts on them. Task 3 owns the asserted version.
// Run: node scripts/g1_tiling_probe.mjs
// Proves, headlessly, that Cesium's GeographicTilingScheme puts row 0 in the NORTH.
//
// NOTE: the plan brief spells the checks as ts.tileYToLatitude(y, level) and
// ts.levelMaximumTileCount(level). Neither exists in Cesium 1.146 public API
// (they are internal to the GeographicTilingScheme module; they are absent from
// node_modules/cesium/Source/Cesium.d.ts). The equivalents below are public.
const C = await import('cesium');

const MOON_RADIUS_M = 1_737_400;
const ellipsoid = new C.Ellipsoid(MOON_RADIUS_M, MOON_RADIUS_M, MOON_RADIUS_M);
const ts = new C.GeographicTilingScheme({ ellipsoid });
const toDeg = (r) => (r * 180) / Math.PI;
const north = (x, y, level) => toDeg(ts.tileXYToRectangle(x, y, level).north);
const south = (x, y, level) => toDeg(ts.tileXYToRectangle(x, y, level).south);

console.log('Cesium.VERSION', C.VERSION);
console.log('tilingScheme ctor      :', ts.constructor.name);
console.log('tileYToLatitude exists :', typeof ts.tileYToLatitude);
console.log('levelMaximumTileCount  :', typeof ts.levelMaximumTileCount);
console.log('');
console.log('L1 rowCount            :', ts.getNumberOfYTilesAtLevel(1));
console.log('L1 colCount            :', ts.getNumberOfXTilesAtLevel(1));
console.log('L0 col x row           :', ts.getNumberOfXTilesAtLevel(0), 'x', ts.getNumberOfYTilesAtLevel(0));
console.log('L1 row 0 north deg     :', north(0, 0, 1), '<= brief criterion 3 (row 0 = +90 = NORTH)');
console.log('L1 row 0 south deg     :', south(0, 0, 1));
console.log('L1 row 1 north deg     :', north(0, 1, 1), '<= brief criterion 3 second half (row 1 = 0)');
console.log('L1 row 1 south deg     :', south(0, 1, 1));
console.log('L0 row 0 north/south   :', north(0, 0, 0), '/', south(0, 0, 0));
console.log('');
const r = ts.rectangle;
console.log(
  'rectangle (deg)          :',
  [toDeg(r.west), toDeg(r.south), toDeg(r.east), toDeg(r.north)].join(', '),
);
console.log('ellipsoid radii        :', ellipsoid.radii.x, ellipsoid.radii.y, ellipsoid.radii.z);
