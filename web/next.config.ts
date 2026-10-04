import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // ABIs come from the shared workspace package (TypeScript source).
  transpilePackages: ["@obscura/shared"],
  // Types are checked by `npm run typecheck` (TypeScript 7) rather than during `next build`.
  typescript: { ignoreBuildErrors: true },
};

export default config;
