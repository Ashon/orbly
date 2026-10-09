import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Installs the zip built by pnpm package:mac into /Applications. (pnpm install:mac)
 * A running Verda is not replaced. Quit it and run this again.
 * A Verda installed with Homebrew is not replaced either: brew would keep listing its own version
 * while the app is a local build. Remove it with brew first.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const zipName = `Verda-v${version}-macos-${process.arch}.app.zip`;
const zip = path.join(root, "release", zipName);
const target = "/Applications/Verda.app";

if (!existsSync(zip)) throw new Error(`${zip} is missing. Run pnpm package:mac first.`);
const expected = readFileSync(`${zip}.sha256`, "utf8").split(/\s+/)[0];
const actual = createHash("sha256").update(readFileSync(zip)).digest("hex");
if (actual !== expected)
  throw new Error(`${zipName} does not match its .sha256. Run pnpm package:mac again.`);

const caskrooms = ["/opt/homebrew/Caskroom/verda", "/usr/local/Caskroom/verda"];
if (caskrooms.some((dir) => existsSync(dir)))
  throw new Error(
    "Verda is installed with Homebrew. Run brew uninstall --cask verda first, or keep using brew upgrade."
  );

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
// The zip holds Verda.app at its top level (ditto --keepParent).
execFileSync("/usr/bin/ditto", ["-x", "-k", zip, "/Applications"], { stdio: "inherit" });
console.log(
  `Installed ${target} from ${zipName}\nOpen Verda from Spotlight or Launchpad.`
);
