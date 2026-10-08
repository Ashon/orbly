import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  shell,
  Tray,
} from "electron";
import { HistoryReader } from "../../../src/history/reader.js";
import { handleLocalApi } from "../../../src/local-api.js";
import { readBotStatus } from "../../../src/runtime/status.js";
import { envFilePath } from "../../../src/settings/paths.js";
import { BotSupervisor, type SupervisorState } from "./bot.js";
import { SandboxService } from "./sandbox.js";
import { SettingsStore } from "./settings.js";

/**
 * Verda 데스크톱 앱. 봇(Slack Socket Mode)을 자식 프로세스로 띄워 관리하고, 상태, 로그, 작업 기록을 보여 준다.
 * - 화면(apps/web 빌드)과 조회 API 는 verda://app 프로토콜로만 제공해서 외부 포트를 열지 않는다.
 * - 봇 제어(시작, 중지, 재시작)는 preload 의 IPC 로만 한다.
 * - 창을 닫으면 트레이로 숨고 봇은 계속 동작한다. 앱을 종료하면 봇도 처리 중인 요청을 마무리하고 종료한다.
 */
const distDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(distDir, "../../..");
const webDistDir = path.join(repoRoot, "apps/web/dist");
/** 설정 파일은 저장소 밖에 둔다. (VERDA_HOME, 기본 ~/.verda) */
const envFile = envFilePath();
const webDevUrl = app.isPackaged ? undefined : process.env.VERDA_WEB_DEV_URL;
/** 화면을 PNG 로 저장하고 종료한다. (빌드 확인용) */
const captureFile = process.env.VERDA_DESKTOP_CAPTURE;
const dataDir = resolveDataDir();
const reader = new HistoryReader(dataDir);
/**
 * VERDA_DESKTOP_BOT=off 이면 봇을 관리하지 않고 기록만 본다.
 * 화면 캡처 때는 봇을 건드리지 않는다. (VERDA_DESKTOP_BOT=on 이면 캡처 때도 관리)
 */
const botSetting = process.env.VERDA_DESKTOP_BOT;
const manageBot = botSetting === "on" || (botSetting !== "off" && !captureFile);

app.setName("Verda");
// 화면 캡처는 따로 된 사용자 데이터 폴더를 써서, 실행 중인 앱의 단일 실행 잠금에 걸리지 않게 한다.
if (captureFile) app.setPath("userData", path.join(tmpdir(), "verda-desktop-capture"));
// 화면 테마: system(기본), light, dark
const themeSource = process.env.VERDA_DESKTOP_THEME;
if (themeSource === "light" || themeSource === "dark")
  nativeTheme.themeSource = themeSource;

let isQuitting = false;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let toolPathCache: string | undefined;

/** Finder 로 띄운 앱은 터미널의 PATH(Homebrew, nvm, docker, codex, pnpm)를 물려받지 못한다. */
function toolPath(): string {
  if (toolPathCache) return toolPathCache;
  try {
    const output = execFileSync(
      process.env.SHELL || "/bin/zsh",
      ["-ilc", 'printf "\\nVERDA_PATH=%s\\n" "$PATH"'],
      { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }
    );
    const line = output
      .split("\n")
      .reverse()
      .find((l) => l.startsWith("VERDA_PATH="));
    if (line) toolPathCache = line.slice("VERDA_PATH=".length);
  } catch {
    // 아래 기본 경로를 쓴다.
  }
  toolPathCache ||= [
    process.env.PATH,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]
    .filter(Boolean)
    .join(path.delimiter);
  return toolPathCache;
}

/** 설정 파일(.env)을 고치는 설정 화면. 봇을 관리하지 않을 때도 쓸 수 있다. */
const settings = new SettingsStore({
  envFile,
  dataDir,
  env: process.env,
});

/** 샌드박스 상태, 허용 도메인, 적용 작업 */
const sandbox = new SandboxService({
  repoRoot,
  envFile,
  dataDir,
  env: process.env,
  toolPath,
});

const supervisor = manageBot
  ? new BotSupervisor({
      repoRoot,
      envFile,
      dataDir,
      toolPath,
      log: (message) => console.log(`[verda-desktop] ${message}`),
    })
  : undefined;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "verda",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

/** 환경 변수, 설정 파일의 VERDA_DATA_DIR, 기본값(~/.verda) 순으로 정한다. */
function resolveDataDir(): string {
  let value = process.env.VERDA_DATA_DIR;
  if (!value) {
    try {
      const line = readFileSync(envFile, "utf8")
        .split("\n")
        .find((l) => l.startsWith("VERDA_DATA_DIR="));
      value = line
        ?.slice("VERDA_DATA_DIR=".length)
        .trim()
        .replace(/^["']|["']$/g, "");
    } catch {
      // .env 가 없으면 기본값을 쓴다.
    }
  }
  value ||= "~/.verda";
  return path.resolve(
    value === "~" || value.startsWith("~/") ? path.join(homedir(), value.slice(1)) : value
  );
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");

function registerAppProtocol(): void {
  protocol.handle("verda", async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "app") return new Response("Not found", { status: 404 });
    if (url.pathname.startsWith("/api/")) {
      return handleLocalApi(reader, request.method, url);
    }
    const pathname =
      url.pathname === "/"
        ? "index.html"
        : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const filePath = path.resolve(webDistDir, pathname);
    const relative = path.relative(webDistDir, filePath);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !existsSync(filePath) ||
      !statSync(filePath).isFile()
    ) {
      return new Response("Not found", { status: 404 });
    }
    const response = await net.fetch(pathToFileURL(filePath).toString());
    if (!filePath.endsWith(".html")) return response;
    const headers = new Headers(response.headers);
    headers.set("content-security-policy", CSP);
    return new Response(response.body, { status: response.status, headers });
  });
}

function showMainWindow(): void {
  if (!mainWindow) {
    void createWindow().catch(reportStartupError);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

const PHASE_LABEL: Record<SupervisorState["phase"], string> = {
  idle: "중지됨",
  building: "빌드 중",
  starting: "시작 중",
  running: "실행 중",
  stopping: "종료 중",
  crashed: "오류로 종료",
  external: "터미널에서 실행 중",
};

function botSummary(): { label: string; active: number } {
  const view = readBotStatus(dataDir);
  const status = view.alive ? view.status : undefined;
  const phase = supervisor?.current.phase;
  let label = phase ? PHASE_LABEL[phase] : status ? "실행 중" : "중지됨";
  if (status?.state === "running" && status.socket.state !== "connected") {
    label = `Socket Mode ${status.socket.state === "reconnecting" ? "재연결 중" : "끊김"}`;
  } else if (
    status?.state === "running" &&
    (phase === "running" || phase === "external")
  ) {
    label = `${phase === "external" ? "터미널에서 " : ""}연결됨 (${status.reasoner ?? "?"})`;
  }
  return { label, active: status?.requests.active ?? 0 };
}

let lastTrayKey = "";
function updateTray(): void {
  if (!tray) return;
  const summary = botSummary();
  const phase = supervisor?.current.phase;
  const key = JSON.stringify([summary, phase, supervisor?.current.autoStart]);
  if (key === lastTrayKey) return;
  lastTrayKey = key;
  tray.setToolTip(`Verda - 봇 ${summary.label}`);
  // 처리 중인 요청이 있으면 메뉴 막대 아이콘 옆에 수를 표시한다. (macOS)
  tray.setTitle(summary.active > 0 ? String(summary.active) : "");
  const controls: MenuItemConstructorOptions[] = supervisor
    ? [
        {
          label: "봇 시작",
          enabled: phase === "idle" || phase === "crashed",
          click: () => void supervisor.start(),
        },
        {
          label: "봇 재시작",
          enabled: phase === "running" || phase === "starting",
          click: () => void supervisor.restart(),
        },
        {
          label: "빌드 후 재시작",
          enabled: phase !== "external" && phase !== "building" && phase !== "stopping",
          click: () => void supervisor.restart({ rebuild: true }),
        },
        {
          label: "봇 중지",
          enabled: phase === "running" || phase === "starting",
          click: () => void supervisor.stop(),
        },
        {
          label: "앱을 열면 봇 자동 시작",
          type: "checkbox",
          checked: supervisor.current.autoStart,
          click: (item) => supervisor.setAutoStart(item.checked),
        },
        { type: "separator" },
      ]
    : [];
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `봇: ${summary.label}`, enabled: false },
      ...(summary.active > 0
        ? [{ label: `처리 중인 요청 ${summary.active}건`, enabled: false }]
        : []),
      { type: "separator" },
      ...controls,
      { label: "Verda 열기", click: showMainWindow },
      { label: "기록 폴더 열기", click: () => void shell.openPath(dataDir) },
      { type: "separator" },
      { label: "Verda 종료", click: () => app.quit() },
    ])
  );
}

function createTray(): void {
  // tray@2x.png 가 같은 디렉터리에 있으면 레티나에서 자동으로 쓴다.
  tray = new Tray(nativeImage.createFromPath(path.join(distDir, "tray.png")));
  tray.on("click", () => tray?.popUpContextMenu());
  updateTray();
  setInterval(updateTray, 2_000).unref();
}

/** 화면의 봇 제어. 메인 창이 보낸 요청만 받는다. */
function registerBotIpc(): void {
  const fromMainWindow = (event: Electron.IpcMainInvokeEvent) =>
    event.sender === mainWindow?.webContents;
  ipcMain.handle("verda:bot:state", (event) =>
    fromMainWindow(event) && supervisor ? supervisor.current : null
  );
  ipcMain.handle("verda:bot:start", async (event) => {
    if (fromMainWindow(event)) await supervisor?.start();
  });
  ipcMain.handle("verda:bot:stop", async (event) => {
    if (fromMainWindow(event)) await supervisor?.stop();
  });
  ipcMain.handle("verda:bot:restart", async (event, rebuild: unknown) => {
    if (fromMainWindow(event)) await supervisor?.restart({ rebuild: rebuild === true });
  });
  ipcMain.handle("verda:bot:auto-start", (event, value: unknown) => {
    if (fromMainWindow(event) && typeof value === "boolean")
      supervisor?.setAutoStart(value);
  });
  ipcMain.handle("verda:bot:open-logs", (event) => {
    if (fromMainWindow(event)) void shell.openPath(path.join(dataDir, "logs"));
  });
  ipcMain.handle("verda:settings:get", (event) =>
    fromMainWindow(event) ? settings.view() : null
  );
  ipcMain.handle("verda:settings:validate", (event, changes: unknown) =>
    fromMainWindow(event) ? settings.validate(changes) : []
  );
  ipcMain.handle("verda:settings:check-slack", (event, changes: unknown) =>
    fromMainWindow(event) ? settings.checkSlack(changes) : []
  );
  ipcMain.handle(
    "verda:settings:save",
    async (event, changes: unknown, restart: unknown) => {
      if (!fromMainWindow(event)) return { issues: [], restarted: false };
      const issues = settings.save(changes);
      if (issues.length > 0 || restart !== true || !supervisor) {
        return { issues, restarted: false };
      }
      // 새 설정은 봇을 다시 띄워야 적용된다. 멈춰 있던 봇이면 새로 띄운다.
      const phase = supervisor.current.phase;
      if (phase === "running" || phase === "starting") await supervisor.restart();
      else if (phase === "idle" || phase === "crashed") await supervisor.start();
      else return { issues, restarted: false };
      return { issues, restarted: true };
    }
  );
  ipcMain.handle("verda:settings:reveal-env", (event) => {
    if (fromMainWindow(event)) shell.showItemInFolder(envFile);
  });
  ipcMain.handle("verda:sandbox:status", (event) =>
    fromMainWindow(event) ? sandbox.status() : null
  );
  ipcMain.handle("verda:sandbox:job", (event) =>
    fromMainWindow(event) ? (sandbox.job ?? null) : null
  );
  ipcMain.handle("verda:sandbox:run", (event, kind: unknown) =>
    fromMainWindow(event) ? sandbox.run(kind) : { error: "거부됨" }
  );
  ipcMain.handle("verda:sandbox:save-allowlist", (event, domains: unknown) =>
    fromMainWindow(event) ? sandbox.saveAllowlist(domains) : []
  );
  sandbox.on("job", (job) =>
    mainWindow?.webContents.send("verda:sandbox:job-changed", job)
  );
  supervisor?.on("change", (state) => {
    mainWindow?.webContents.send("verda:bot:changed", state);
    updateTray();
  });
}

async function createWindow(): Promise<void> {
  if (mainWindow) {
    showMainWindow();
    return;
  }
  const window = new BrowserWindow({
    width: 1360,
    // 캡처할 때는 긴 화면도 담을 수 있게 높이를 바꿀 수 있다.
    height: (captureFile && Number(process.env.VERDA_DESKTOP_CAPTURE_HEIGHT)) || 880,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: "Verda",
    icon: path.join(distDir, "icon.png"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f1714" : "#fafdfb",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(distDir, "preload.cjs"),
    },
  });
  mainWindow = window;
  if (!captureFile) window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  // Slack 링크 등 외부 주소는 기본 브라우저로 연다.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("verda://app/") && !(webDevUrl && url.startsWith(webDevUrl))) {
      event.preventDefault();
    }
  });
  if (webDevUrl) await waitForUrl(webDevUrl);
  await window.loadURL(webDevUrl ?? "verda://app/");
  if (captureFile) await capture(window, captureFile);
}

/** 개발 서버가 뜰 때까지 기다린다. (pnpm desktop:dev 는 화면과 앱을 함께 띄운다) */
async function waitForUrl(url: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch {
      // 아직 시작 중이다.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${url} 에 연결하지 못했습니다.`);
}

async function capture(window: BrowserWindow, file: string): Promise<void> {
  const hash = process.env.VERDA_DESKTOP_CAPTURE_HASH;
  if (hash)
    await window.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);
  await new Promise((resolve) =>
    setTimeout(resolve, Number(process.env.VERDA_DESKTOP_CAPTURE_DELAY) || 2_500)
  );
  const image = await window.webContents.capturePage();
  writeFileSync(file, image.toPNG());
  isQuitting = true;
  app.quit();
}

function reportStartupError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  dialog.showErrorBox("Verda 를 시작하지 못했습니다", message);
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showMainWindow);
  app
    .whenReady()
    .then(async () => {
      registerAppProtocol();
      registerBotIpc();
      if (process.platform === "darwin" && !app.isPackaged) {
        app.dock?.setIcon(nativeImage.createFromPath(path.join(distDir, "icon.png")));
      }
      if (!captureFile) createTray();
      // 봇은 창과 따로 뜬다. 창을 기다리지 않는다.
      if (supervisor?.current.autoStart && supervisor.current.phase === "idle") {
        void supervisor.start();
      }
      await createWindow();
      app.on("activate", showMainWindow);
    })
    .catch(reportStartupError);
}

let botStopped = false;
app.on("before-quit", (event) => {
  isQuitting = true;
  // 직접 띄운 봇은 처리 중인 요청을 마무리하게 한 뒤 종료한다. (최대 30초)
  if (supervisor?.managing && !botStopped) {
    event.preventDefault();
    tray?.setToolTip("Verda - 봇 종료 중");
    void supervisor.stop().finally(() => {
      botStopped = true;
      supervisor.dispose();
      app.quit();
    });
  }
});
app.on("window-all-closed", () => {
  if (isQuitting) app.quit();
});
process.once("SIGTERM", () => app.quit());
