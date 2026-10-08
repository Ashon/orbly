import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * 의존성까지 하나로 묶은 실행 파일을 만든다. 데스크톱 앱 패키지와 broker 이미지가 이 결과만 쓴다.
 * - build/bot/index.mjs: 봇 (패키지 앱이 utilityProcess 로 실행)
 * - build/tools/sandbox-job.mjs: 샌드박스 적용 작업 (패키지 앱이 실행)
 * - sandbox/ops-broker/dist/server.mjs: ops-broker (이미지에 들어간다)
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  logLevel: "warning",
  // 묶인 CommonJS 의존성의 require 를 ESM 에서 쓸 수 있게 한다.
  banner: {
    js: "import { createRequire as __verdaCreateRequire } from 'node:module'; const require = __verdaCreateRequire(import.meta.url);",
  },
};
const targets = [
  ["src/index.ts", "build/bot/index.mjs"],
  ["src/tools/sandbox-job.ts", "build/tools/sandbox-job.mjs"],
  ["src/broker/server.ts", "sandbox/ops-broker/dist/server.mjs"],
];
for (const [entry, out] of targets) {
  await build({ ...common, entryPoints: [path.join(root, entry)], outfile: path.join(root, out) });
  console.log(`${out}`);
}
