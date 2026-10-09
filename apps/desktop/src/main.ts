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
import { resolveAppPaths } from "./app-paths.js";
import { SettingsStore } from "./settings.js";

/**
 * Verda desktop app. Runs and manages the bot (Slack Socket Mode) as a child process and shows its status, logs, and run history.
 * - The UI (apps/web build) and the query API are served only over the verda://app protocol, so no external port is opened.
 * - Bot control (start, stop, restart) goes only through the preload IPC.
 * - Closing the window hides it to the tray and the bot keeps running. Quitting the app lets the bot finish active requests and then stops it.
 */
const distDir = path.dirname(fileURLToPath(import.meta.url));
/** Dev runs use the repository build output; the packaged app (Verda.app) uses the bundled files inside the app. */
const paths = resolveAppPaths(distDir, app.isPackaged);
const webDistDir = paths.webDist;
/** The settings file lives outside the repository. (VERDA_HOME, default ~/.verda) */
const envFile = envFilePath();
const webDevUrl = app.isPackaged ? undefined : process.env.VERDA_WEB_DEV_URL;
/** Saves the window as a PNG and quits. (for checking builds) */
const captureFile = process.env.VERDA_DESKTOP_CAPTURE;
const dataDir = resolveDataDir();
const reader = new HistoryReader(dataDir);
/**
 * With VERDA_DESKTOP_BOT=off the app does not manage the bot and only shows history.
 * Screen captures leave the bot alone. (VERDA_DESKTOP_BOT=on manages it during captures too)
 */
const botSetting = process.env.VERDA_DESKTOP_BOT;
const manageBot = botSetting === "on" || (botSetting !== "off" && !captureFile);

/**
 * Runs from the repository are "Verda Dev": their own name and user data folder give them their own
 * single-instance lock, so they start next to an installed Verda instead of handing over to it.
 */
const appName = app.isPackaged ? "Verda" : "Verda Dev";
/** Dock and window icon: dev runs get the one with the DEV tag. */
const appIcon = path.join(distDir, app.isPackaged ? "icon.png" : "icon-dev.png");
app.setName(appName);
// Screen captures use a separate user data folder so they do not hit the running app's single-instance lock.
if (captureFile) app.setPath("userData", path.join(tmpdir(), "verda-desktop-capture"));
else if (!app.isPackaged)
  app.setPath("userData", path.join(app.getPath("appData"), appName));
// UI theme: system (default), light, dark
const themeSource = process.env.VERDA_DESKTOP_THEME;
if (themeSource === "light" || themeSource === "dark")
  nativeTheme.themeSource = themeSource;

let isQuitting = false;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let toolPathCache: string | undefined;

/** An app launched from Finder does not inherit the terminal's PATH (Homebrew, nvm, docker, codex, pnpm). */
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
    // Falls back to the default paths below.
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

/** Settings screen that edits the settings file (.env). Works even when the bot is not managed. */
const settings = new SettingsStore({
  envFile,
  dataDir,
  env: process.env,
});

/** Sandbox status, allowed domains, apply jobs */
const sandbox = new SandboxService({
  sandboxDir: paths.sandboxDir,
  jobRunner: paths.jobRunner,
  envFile,
  dataDir,
  env: process.env,
  toolPath,
});

const supervisor = manageBot
  ? new BotSupervisor({
      entry: paths.botEntry,
      repoRoot: paths.repoRoot,
      // The packaged app runs the bot from the writable data folder.
      cwd: paths.repoRoot ?? dataDir,
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

/** Resolved from the environment variable, then VERDA_DATA_DIR in the settings file, then the default (~/.verda). */
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
      // Without .env, the default is used.
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
  idle: "Stopped",
  building: "Building",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  crashed: "Crashed",
  external: "Running in terminal",
};

function botSummary(): { label: string; active: number } {
  const view = readBotStatus(dataDir);
  const status = view.alive ? view.status : undefined;
  const phase = supervisor?.current.phase;
  let label = phase ? PHASE_LABEL[phase] : status ? "Running" : "Stopped";
  if (status?.state === "running" && status.socket.state !== "connected") {
    label = `Socket Mode ${status.socket.state === "reconnecting" ? "reconnecting" : "disconnected"}`;
  } else if (
    status?.state === "running" &&
    (phase === "running" || phase === "external")
  ) {
    label = `Connected${phase === "external" ? " in terminal" : ""} (${status.reasoner ?? "?"})`;
  }
  return { label, active: status?.requests.active ?? 0 };
}

let lastTrayKey = "";
function updateTray(): void {
  if (!tray) return;
  const summary = botSummary();
  const phase = supervisor?.current.phase;
  const key = JSON.stringify([summary, phase]);
  if (key === lastTrayKey) return;
  lastTrayKey = key;
  tray.setToolTip(`${appName} - Bot: ${summary.label}`);
  // Shows the number of active requests next to the menu bar icon. (macOS)
  // Dev runs say so next to the tray icon, since the installed Verda may sit beside it.
  tray.setTitle(
    [app.isPackaged ? "" : "Dev", summary.active > 0 ? String(summary.active) : ""]
      .filter(Boolean)
      .join(" ")
  );
  // The tray holds only the status and quick actions. Bot control is on the Bot screen; app settings (start automatically, run history folder) are on the Settings screen.
  const live = phase === "running" || phase === "starting";
  const controls: MenuItemConstructorOptions[] = supervisor
    ? [
        live
          ? { label: "Restart bot", click: () => void supervisor.restart() }
          : {
              label: "Start bot",
              enabled: phase === "idle" || phase === "crashed",
              click: () => void supervisor.start(),
            },
        { type: "separator" },
      ]
    : [];
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Bot: ${summary.label}`, enabled: false },
      ...(summary.active > 0
        ? [
            {
              label: `${summary.active} active ${summary.active === 1 ? "request" : "requests"}`,
              enabled: false,
            },
          ]
        : []),
      { type: "separator" },
      ...controls,
      { label: `Open ${appName}`, click: showMainWindow },
      { type: "separator" },
      { label: `Quit ${appName}`, click: () => app.quit() },
    ])
  );
}

function createTray(): void {
  // If tray@2x.png is in the same directory, Retina displays use it automatically.
  tray = new Tray(nativeImage.createFromPath(path.join(distDir, "tray.png")));
  tray.on("click", () => tray?.popUpContextMenu());
  updateTray();
  setInterval(updateTray, 2_000).unref();
}

/** Bot control from the UI. Accepts requests only from the main window. */
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
      // New settings take effect only after the bot restarts. A stopped bot is started fresh.
      const phase = supervisor.current.phase;
      if (phase === "running" || phase === "starting") await supervisor.restart();
      else if (phase === "idle" || phase === "crashed") await supervisor.start();
      else return { issues, restarted: false };
      return { issues, restarted: true };
    }
  );
  ipcMain.handle("verda:settings:open-data-dir", (event) => {
    if (fromMainWindow(event)) void shell.openPath(dataDir);
  });
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
    fromMainWindow(event) ? sandbox.run(kind) : { error: "Denied" }
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
    // For captures the height can be changed to fit long screens.
    height: (captureFile && Number(process.env.VERDA_DESKTOP_CAPTURE_HEIGHT)) || 880,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: appName,
    icon: appIcon,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f1714" : "#fafdfb",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(distDir, "preload.cjs"),
      // Tells the UI it runs from the repository (preload reads it from argv).
      additionalArguments: app.isPackaged ? [] : ["--verda-dev"],
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
  // External addresses such as Slack links open in the default browser.
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

/** Waits until the dev server is up. (pnpm desktop:dev starts the UI and the app together) */
async function waitForUrl(url: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Could not connect to ${url}.`);
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
  dialog.showErrorBox(`${appName} could not start`, message);
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
        app.dock?.setIcon(nativeImage.createFromPath(appIcon));
      }
      if (!captureFile) createTray();
      // The bot starts independently of the window and does not wait for it.
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
  // A bot started by the app finishes active requests before it stops. (up to 30 seconds)
  if (supervisor?.managing && !botStopped) {
    event.preventDefault();
    tray?.setToolTip(`${appName} - Bot: Stopping`);
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
