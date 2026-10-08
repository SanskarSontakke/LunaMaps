/** @type {import('next').NextConfig} */
const nextConfig = {
  // The Next dev-mode indicator is a floating circular badge that lands on the
  // map chrome in every `npm run dev` capture (gate G3 mistook it for a clipped
  // compass rose). It exists only in development, so it is off: what a dev
  // screenshot shows is what the production build renders.
  devIndicators: false,
};

export default nextConfig;
