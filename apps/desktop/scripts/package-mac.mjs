import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 설치해서 쓰는 macOS 앱(Verda.app)과 설치 파일(.dmg, .zip)을 만든다. (pnpm package:mac)
 * 앱 안(Contents/Resources/app)에 화면, 봇 묶음, 샌드박스 작업 묶음, sandbox 파일을 넣어서 저장소와 pnpm 없이 동작한다.
 * 설정과 기록은 앱 밖(VERDA_HOME, 기본 ~/.verda)에 있다.
 * 서명은 이 컴퓨터용 ad-hoc 이다. 다른 사람에게 배포하려면 Developer ID 서명과 공증이 필요하다.
 */
if (process.platform !== "darwin")
  throw new Error("macOS 패키지는 Mac 에서만 만들 수 있습니다.");

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(desktopDir, "../..");
const require = createRequire(path.join(desktopDir, "package.json"));
const electronApp = path.resolve(require("electron"), "../../..");
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const releaseDir = path.join(root, "release");
const outputDir = path.join(releaseDir, `mac-${process.arch}`);
const appPath = path.join(outputDir, "Verda.app");
const resourcesDir = path.join(appPath, "Contents/Resources");
const appDir = path.join(resourcesDir, "app");
const stem = `Verda-${version}-mac-${process.arch}`;
const bundleId = "io.github.ashon.verda";

const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
const plistSet = (file, values) => {
  for (const [key, value] of Object.entries(values)) {
    // 미리 만든 Helper 번들에는 없는 키도 있어서 지우고 다시 넣는다.
    try {
      execFileSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, file], {
        stdio: "ignore",
      });
    } catch {
      // 없는 키
    }
    run("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, file]);
  }
};

// pnpm desktop:build 결과 (package:mac 이 먼저 부른다)
const inputs = {
  "apps/desktop/dist": "dist",
  "apps/web/dist": "web",
  "build/bot": "bot",
  "build/tools": "tools",
  sandbox: "sandbox",
};
const required = [
  "apps/desktop/dist/main.js",
  "apps/web/dist/index.html",
  "build/bot/index.mjs",
  "build/tools/sandbox-job.mjs",
  "sandbox/ops-broker/dist/server.mjs",
];
for (const file of required) {
  if (!existsSync(path.join(root, file)))
    throw new Error(`${file} 가 없습니다. pnpm desktop:build 를 먼저 실행하세요.`);
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
run("/usr/bin/ditto", [electronApp, appPath]);
await rm(path.join(resourcesDir, "default_app.asar"), { force: true });
await rm(path.join(resourcesDir, "electron.icns"), { force: true });
await mkdir(appDir, { recursive: true });
for (const [from, to] of Object.entries(inputs)) {
  await cp(path.join(root, from), path.join(appDir, to), { recursive: true });
}
await writeFile(
  path.join(appDir, "package.json"),
  `${JSON.stringify({ name: "verda", productName: "Verda", version, type: "module", main: "dist/main.js" }, null, 2)}\n`
);

// 아이콘: svg 와 같은 꽉 찬 아이콘 세트. 격자와 효과는 시스템이 입힌다.
const iconset = path.join(outputDir, "Verda.iconset");
run("/usr/bin/swift", [
  "-module-cache-path",
  path.join(releaseDir, ".swift-cache"),
  path.join(desktopDir, "scripts/icon.swift"),
  "--iconset",
  iconset,
]);
run("/usr/bin/iconutil", [
  "-c",
  "icns",
  iconset,
  "-o",
  path.join(resourcesDir, "verda.icns"),
]);
await rm(iconset, { recursive: true, force: true });

const infoPlist = path.join(appPath, "Contents/Info.plist");
plistSet(infoPlist, {
  CFBundleDisplayName: "Verda",
  CFBundleName: "Verda",
  CFBundleIdentifier: bundleId,
  CFBundleExecutable: "Verda",
  CFBundleIconFile: "verda.icns",
  CFBundleVersion: version,
  CFBundleShortVersionString: version,
  LSApplicationCategoryType: "public.app-category.developer-tools",
});
try {
  execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Delete :ElectronAsarIntegrity", infoPlist],
    {
      stdio: "ignore",
    }
  );
} catch {
  // 없는 키
}
await rename(
  path.join(appPath, "Contents/MacOS/Electron"),
  path.join(appPath, "Contents/MacOS/Verda")
);

const frameworksDir = path.join(appPath, "Contents/Frameworks");
for (const name of await readdir(frameworksDir)) {
  if (!name.startsWith("Electron Helper") || !name.endsWith(".app")) continue;
  const oldName = name.slice(0, -4);
  const newName = oldName.replace("Electron", "Verda");
  const helperDir = path.join(frameworksDir, name);
  const suffix = oldName
    .replace("Electron Helper", "")
    .replace(/[ ()]/g, "")
    .toLowerCase();
  plistSet(path.join(helperDir, "Contents/Info.plist"), {
    CFBundleDisplayName: newName,
    CFBundleName: newName,
    CFBundleExecutable: newName,
    CFBundleIdentifier: `${bundleId}.helper${suffix ? `.${suffix}` : ""}`,
  });
  await rename(
    path.join(helperDir, "Contents/MacOS", oldName),
    path.join(helperDir, "Contents/MacOS", newName)
  );
  await rename(helperDir, path.join(frameworksDir, `${newName}.app`));
}

run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath]);
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);

await rm(path.join(releaseDir, `${stem}.zip`), { force: true });
run("/usr/bin/ditto", [
  "-c",
  "-k",
  "--sequesterRsrc",
  "--keepParent",
  appPath,
  path.join(releaseDir, `${stem}.zip`),
]);
const stagingDir = path.join(outputDir, "dmg");
await mkdir(stagingDir, { recursive: true });
run("/usr/bin/ditto", [appPath, path.join(stagingDir, "Verda.app")]);
await symlink("/Applications", path.join(stagingDir, "Applications"));
try {
  run("/usr/bin/hdiutil", [
    "create",
    "-volname",
    "Verda",
    "-srcfolder",
    stagingDir,
    "-ov",
    "-format",
    "UDZO",
    path.join(releaseDir, `${stem}.dmg`),
  ]);
} finally {
  await rm(stagingDir, { recursive: true, force: true });
}
console.log(
  `\n앱: ${appPath}\n설치 파일: ${releaseDir}/${stem}.{dmg,zip}\n설치: pnpm install:mac (또는 dmg 를 열어 Applications 로 끌어 넣기)`
);
