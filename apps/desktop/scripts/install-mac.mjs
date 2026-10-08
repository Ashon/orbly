import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * pnpm package:mac 으로 만든 Verda.app 을 /Applications 에 설치한다. (pnpm install:mac)
 * 실행 중인 Verda 는 바꾸지 않는다. 종료한 뒤 다시 실행한다.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const source = path.join(root, "release", `mac-${process.arch}`, "Verda.app");
const target = "/Applications/Verda.app";

if (!existsSync(source))
  throw new Error(`${source} 가 없습니다. pnpm package:mac 을 먼저 실행하세요.`);
let running = "";
try {
  running = execFileSync("/usr/bin/pgrep", ["-f", `${target}/Contents/MacOS/Verda`], {
    encoding: "utf8",
  }).trim();
} catch {
  // 실행 중이 아니다.
}
if (running)
  throw new Error("Verda 가 실행 중입니다. 메뉴 막대의 Verda > 종료 후 다시 실행하세요.");

execFileSync("/bin/rm", ["-rf", target]);
execFileSync("/usr/bin/ditto", [source, target], { stdio: "inherit" });
console.log(`설치했습니다: ${target}\nSpotlight 나 Launchpad 에서 Verda 를 엽니다.`);
