import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = path.resolve(desktopDir, "../../assets");
const distDir = path.join(desktopDir, "dist");
await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const common = { bundle: true, platform: "node", target: "node22", logLevel: "info" };
await build({
  ...common,
  entryPoints: [path.join(desktopDir, "src/main.ts")],
  outfile: path.join(distDir, "main.js"),
  external: ["electron"],
  format: "esm",
});
await build({
  ...common,
  entryPoints: [path.join(desktopDir, "src/preload.ts")],
  outfile: path.join(distDir, "preload.cjs"),
  external: ["electron"],
  format: "cjs",
});
// 트레이는 링에 맞춘 투명 로고(18pt, 레티나 @2x, assets/verda.svg 에서 그림)
// 독/창 아이콘은 macOS 아이콘 격자에 맞춘 앱 아이콘 (assets/verda-icon.svg, pnpm --filter @verda/desktop icon)
await cp(path.join(assetsDir, "verda-tray.png"), path.join(distDir, "tray.png"));
await cp(path.join(assetsDir, "verda-tray@2x.png"), path.join(distDir, "tray@2x.png"));
await cp(path.join(assetsDir, "verda-icon.png"), path.join(distDir, "icon.png"));
