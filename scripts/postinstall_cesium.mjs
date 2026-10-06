import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = resolve(root, 'node_modules/cesium/Build/Cesium');
if (!existsSync(build)) {
  console.error(`Cesium build missing at ${build}`);
  process.exit(1);
}
const dest = resolve(root, 'public/cesium');
mkdirSync(dest, { recursive: true });
for (const dir of ['Workers', 'Widgets', 'Assets', 'ThirdParty']) {
  cpSync(resolve(build, dir), resolve(dest, dir), { recursive: true });
  console.log('copied', dir);
}
