import { homedir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { handleLocalApi } from "../../src/local-api";
import { HistoryReader } from "../../src/history/reader";
import { defaultHome, envValue } from "../../src/settings/legacy";

/** The dev server also reads real history through the same /api as the desktop app. (read-only, 127.0.0.1 only) */
function historyApi(): Plugin {
  return {
    name: "orbly-history-api",
    configureServer(server) {
      // ORBLY_DATA_DIR (or VERDA_DATA_DIR from before the rename), else the default home
      const raw = envValue(process.env, "DATA_DIR") ?? defaultHome();
      const root = raw.startsWith("~") ? path.join(homedir(), raw.slice(1)) : raw;
      const reader = new HistoryReader(path.resolve(root));
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        void handleLocalApi(
          reader,
          req.method ?? "GET",
          new URL(req.url, "http://127.0.0.1")
        )
          .then(async (response) => {
            res.statusCode = response.status;
            response.headers.forEach((value, key) => res.setHeader(key, value));
            res.end(Buffer.from(await response.arrayBuffer()));
          })
          .catch(next);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), historyApi()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@history": path.resolve(__dirname, "../../src/history"),
      "@runtime": path.resolve(__dirname, "../../src/runtime"),
      "@src": path.resolve(__dirname, "../../src"),
    },
  },
  server: { host: "127.0.0.1", port: 5179, strictPort: true },
  // A single bundle is enough for a local desktop app.
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
