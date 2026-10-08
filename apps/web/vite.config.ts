import { homedir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { handleLocalApi } from "../../src/local-api";
import { HistoryReader } from "../../src/history/reader";

/** 개발 서버에서도 데스크톱 앱과 같은 /api 로 실제 기록을 읽는다. (읽기 전용, 127.0.0.1 만) */
function historyApi(): Plugin {
  return {
    name: "verda-history-api",
    configureServer(server) {
      const raw = process.env.VERDA_DATA_DIR || "~/.verda";
      const root = raw.startsWith("~") ? path.join(homedir(), raw.slice(1)) : raw;
      const reader = new HistoryReader(path.resolve(root));
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        void handleLocalApi(reader, req.method ?? "GET", new URL(req.url, "http://127.0.0.1"))
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
  // 로컬 데스크톱 앱이라 번들 하나로 충분하다.
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
