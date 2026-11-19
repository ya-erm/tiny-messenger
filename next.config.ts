import { createRequire } from "node:module";
import type { NextConfig } from "next";

const { version } = createRequire(import.meta.url)("./package.json") as { version: string };

const nextConfig: NextConfig = {
  async headers() {
    const origin = new URL(process.env.TASKS_ORIGIN || "https://tasks.ya-erm.ru").origin;
    return [
      {source:"/sw.js",headers:[{key:"Cache-Control",value:"no-cache"}]},
      {source:"/notification-state.js",headers:[{key:"Cache-Control",value:"no-cache"}]},
      {source:"/manifest.webmanifest",headers:[{key:"Cache-Control",value:"no-cache"}]},
      {source:"/tasks-embed",headers:[{key:"Content-Security-Policy",value:`frame-ancestors 'self' ${origin}`}]},
      {source:"/codecs/:path*",headers:[{key:"Cache-Control",value:"public, max-age=31536000, immutable"}]},
      {source:"/webp-encoder-worker.js",headers:[{key:"Cache-Control",value:"no-cache"}]},
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
