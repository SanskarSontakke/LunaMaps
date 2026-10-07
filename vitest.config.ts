import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // Task 15 has to assert the failure PANELS themselves (`NoAssets`, `ErrorPanel`),
  // and the node environment has no browser to render in — `react-dom/server` does.
  // That needs real JSX output, while `tsconfig.json` says `jsx: "preserve"` because
  // Next's own compiler is what normally transforms it (preserved JSX made vitest's
  // import-analysis choke on the `.tsx` files). The override lives here, for vitest
  // only: Next never reads this file, and its build keeps using `preserve`.
  oxc: { jsx: { runtime: 'automatic' } },
  test: { environment: 'node', include: ['src/test/**/*.test.ts'] },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
