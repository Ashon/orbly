import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

// Exposes only the platform (window button placement), bot control, settings read/write, and sandbox management to the UI. History queries go through orbly://app/api.
contextBridge.exposeInMainWorld("orblyDesktop", {
  platform: process.platform,
  // Runs from the repository (Orbly Dev), as opposed to the installed app.
  dev: process.argv.includes("--orbly-dev"),
  bot: {
    state: () => ipcRenderer.invoke("orbly:bot:state"),
    start: () => ipcRenderer.invoke("orbly:bot:start"),
    stop: () => ipcRenderer.invoke("orbly:bot:stop"),
    restart: (rebuild = false) => ipcRenderer.invoke("orbly:bot:restart", rebuild),
    setAutoStart: (value: boolean) => ipcRenderer.invoke("orbly:bot:auto-start", value),
    openLogs: () => ipcRenderer.invoke("orbly:bot:open-logs"),
    onChange: (callback: (state: unknown) => void) => {
      const listener = (_event: IpcRendererEvent, state: unknown) => callback(state);
      ipcRenderer.on("orbly:bot:changed", listener);
      return () => ipcRenderer.removeListener("orbly:bot:changed", listener);
    },
  },
  settings: {
    get: () => ipcRenderer.invoke("orbly:settings:get"),
    validate: (changes: unknown) =>
      ipcRenderer.invoke("orbly:settings:validate", changes),
    checkSlack: (changes: unknown) =>
      ipcRenderer.invoke("orbly:settings:check-slack", changes),
    save: (changes: unknown, restart = false) =>
      ipcRenderer.invoke("orbly:settings:save", changes, restart),
    revealEnv: () => ipcRenderer.invoke("orbly:settings:reveal-env"),
    openDataDir: () => ipcRenderer.invoke("orbly:settings:open-data-dir"),
  },
  // Team hub pairing. The token stays in the main process; these return { error } on failure.
  hub: {
    pairStart: (url: string) => ipcRenderer.invoke("orbly:hub:pair-start", url),
    pairStatus: () => ipcRenderer.invoke("orbly:hub:pair-status"),
    pairConfirm: () => ipcRenderer.invoke("orbly:hub:pair-confirm"),
    pairCancel: () => ipcRenderer.invoke("orbly:hub:pair-cancel"),
    disconnect: () => ipcRenderer.invoke("orbly:hub:disconnect"),
  },
  sandbox: {
    status: () => ipcRenderer.invoke("orbly:sandbox:status"),
    job: () => ipcRenderer.invoke("orbly:sandbox:job"),
    run: (kind: string) => ipcRenderer.invoke("orbly:sandbox:run", kind),
    saveAllowlist: (domains: string[]) =>
      ipcRenderer.invoke("orbly:sandbox:save-allowlist", domains),
    // Runs claude setup-token; the token goes to .env in the main process and never comes back here.
    claudeToken: () => ipcRenderer.invoke("orbly:sandbox:claude-token"),
    cancelClaudeToken: () => ipcRenderer.invoke("orbly:sandbox:claude-token-cancel"),
    onJob: (callback: (job: unknown) => void) => {
      const listener = (_event: IpcRendererEvent, job: unknown) => callback(job);
      ipcRenderer.on("orbly:sandbox:job-changed", listener);
      return () => ipcRenderer.removeListener("orbly:sandbox:job-changed", listener);
    },
  },
});
