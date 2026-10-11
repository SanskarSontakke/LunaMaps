/** @type {import('next').NextConfig} */
const nextConfig = {
  // The Next dev-mode indicator is a floating circular badge that lands on the
  // map chrome in every `npm run dev` capture (gate G3 mistook it for a clipped
  // compass rose). It exists only in development, so it is off: what a dev
  // screenshot shows is what the production build renders.
  devIndicators: false,
  // A stray `package-lock.json` in C:\Users\YAMINI makes Next infer the workspace
  // root as the home directory and trace files from there. Pin it to this project.
  outputFileTracingRoot: import.meta.dirname,
  webpack: (config, { isServer }) => {
    // `@spz-loader/core` carries its WASM point-cloud decoder as a template
    // literal full of raw control bytes. Re-emitting it during the client build
    // produces a chunk with `\0` followed by a digit inside a template string --
    // an illegal octal escape -- so the chunk throws a SyntaxError at parse time,
    // its dependents fail to load, and the page never hydrates. `node --check`
    // on the emitted file reproduces it without a browser. Deterministic: the
    // same content-hashed name and byte count across clean rebuilds, and turning
    // `compiler.minify` off changes nothing, so it is the transform, not the
    // minifier, and not disk rot.
    //
    // Aliasing to `false` makes webpack substitute an empty module. This app
    // renders three baked imagery layers and never loads a .spz point cloud, so
    // the decoder has no reachable call site -- and a bundle that cannot parse
    // is not a bundle. If SPZ support is ever added, drop this and fix the
    // encoding upstream instead.
    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        '@spz-loader/core': false,
      };
    }
    return config;
  },
};

export default nextConfig;
