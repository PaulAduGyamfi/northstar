import type { NextConfig } from "next";
import { webConfig } from "./src/config";

const { apiOrigin } = webConfig();

const config: NextConfig = {
  // The browser talks to one origin: /api/* goes to the API, so Paul's SameSite=Strict session
  // cookie is sent with it and the browser never needs the API's address (web.md).
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin}/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // No other site may frame Northstar (clickjacking an approve button).
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
  poweredByHeader: false,
  // `pnpm typecheck` runs tsc (TypeScript 7, ADR-0011); Next's own build-time check uses the
  // TypeScript JS API, which TypeScript 7 doesn't ship.
  typescript: { ignoreBuildErrors: true },
};

export default config;
