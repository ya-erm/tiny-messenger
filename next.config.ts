import { createRequire } from "node:module";
import type { NextConfig } from "next";

const { version } = createRequire(import.meta.url)("./package.json") as { version: string };

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
  },
};

export default nextConfig;
