// Parse-check every client bundle the production build emitted.
//
// Why this exists: `npm run build` compiled, linted, typechecked and prerendered
// five static pages, and the app it produced rendered a permanently empty page.
// One chunk could not be parsed at all -- `@spz-loader/core` carries its WASM as a
// template literal of raw control bytes, and re-emitting it turned a NUL into a
// `\0` escape followed by a digit, which is illegal in a template string. Every
// existing gate passed over it, because none of them ever asked the browser's
// parser whether it accepted the output.
//
// `node --check` asks exactly that, with no browser and no server, in about a
// second. It is the cheapest possible guard against "a build that builds".
//
// Scope is deliberately `.next/static` only: those are the files a browser parses.
// `.next/server` runs under Node, which is more forgiving about the constructs
// that break here, and checking it would add noise without adding a real signal.
//
// Usage: npm run build && npm run verify:bundle
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = '.next/static';

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
};

if (!existsSync(ROOT)) {
  console.error(
    `[verify:bundle] no ${ROOT}/ -- run \`npm run build\` first.\n` +
    '  This check reads the emitted bundles; it does not produce them.',
  );
  process.exit(2);
}

const files = walk(ROOT);
if (files.length === 0) {
  console.error(`[verify:bundle] ${ROOT}/ exists but holds no .js files`);
  process.exit(2);
}

const failures = [];
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    const line = (r.stderr || '').split('\n').find((l) => l.trim() !== '') ?? '';
    failures.push({ file, line: line.slice(0, 200) });
  }
}

if (failures.length > 0) {
  console.error(
    `[verify:bundle] ${failures.length} of ${files.length} client bundles cannot ` +
    'be parsed. A browser would fail on these silently: the page renders, the ' +
    'chunk throws, dependents never load, and nothing but the console says so.',
  );
  for (const f of failures) console.error(`  ${relative('.', f.file)}\n    ${f.line}`);
  console.error(
    '\n  If this appeared after a Cesium upgrade, check whether a dependency is ' +
    'inlining binary data as a string -- see the alias in next.config.mjs.',
  );
  process.exit(1);
}

console.log(`[verify:bundle] ${files.length} client bundles parse`);
