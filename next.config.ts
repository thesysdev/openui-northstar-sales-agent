import { withAui } from "@assistant-ui/next";
import type { NextConfig } from "next";
import { BASE_PATH } from "./src/lib/base-path";

const config: NextConfig = {
  basePath: BASE_PATH || undefined,
  turbopack: { root: process.cwd() },
  async redirects() {
    // With a base path, the deployment's own domain still opens the demo at its root.
    return BASE_PATH ? [{ source: "/", destination: BASE_PATH, basePath: false, permanent: false }] : [];
  },
  // With THESYS_BASE_URL set, such as a local stack, the browser reaches it through this app's
  // origin, so it needs no CORS setup. The page tells the browser to do so.
  async rewrites() {
    const base = process.env.THESYS_BASE_URL?.replace(/\/+$/, "");
    return base ? [{ source: "/v1/:path*", destination: `${base}/v1/:path*` }] : [];
  },
};

// withAui compiles the "use generative" toolkit (src/lib/toolkit.tsx) into a server build with
// each tool's `execute` and a browser build with its `render`.
export default withAui(config);
