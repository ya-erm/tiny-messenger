import { createRequire } from "node:module";
import type { NextConfig } from "next";

const { version } = createRequire(import.meta.url)("./package.json") as { version: string };

const nextConfig: NextConfig = {
  async headers() {
    const origin = new URL(process.env.TASKS_ORIGIN || "https://tasks.ya-erm.ru").origin;
    return [
      {source:"/tasks-embed",headers:[{key:"Content-Security-Policy",value:`frame-ancestors 'self' ${origin}`}]},
      {source:"/emoji/twemoji-17.0.3/:path*",headers:[{key:"Cache-Control",value:"public, max-age=31536000, immutable"}]},
    ];
  },
  experimental: {
    cpus: 1,
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
  },
};

export default nextConfig;
