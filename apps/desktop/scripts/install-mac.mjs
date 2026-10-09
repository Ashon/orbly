import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Installs the Verda.app built by pnpm package:mac into /Applications. (pnpm install:mac)
 * A running Verda is not replaced. Quit it and run this again.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const source = path.join(root, "release", `mac-${process.arch}`, "Verda.app");
const target = "/Applications/Verda.app";

if (!existsSync(source))
  throw new Error(`${source} is missing. Run pnpm package:mac first.`);
let running = "";
try {
  running = execFileSync("/usr/bin/pgrep", ["-f", `${target}/Contents/MacOS/Verda`], {
    encoding: "utf8",
  }).trim();
} catch {
  // Not running.
}
if (running)
  throw new Error(
    "Verda is running. Quit it from the menu bar (Verda > Quit) and try again."
  );

execFileSync("/bin/rm", ["-rf", target]);
execFileSync("/usr/bin/ditto", [source, target], { stdio: "inherit" });
console.log(`Installed ${target}\nOpen Verda from Spotlight or Launchpad.`);
