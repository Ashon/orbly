import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

// Exposes only the platform (window button placement), bot control, settings read/write, and sandbox management to the UI. History queries go through verda://app/api.
contextBridge.exposeInMainWorld("verdaDesktop", {
  platform: process.platform,
  // Runs from the repository (Verda Dev), as opposed to the installed app.
  dev: process.argv.includes("--verda-dev"),
  bot: {
    state: () => ipcRenderer.invoke("verda:bot:state"),
    start: () => ipcRenderer.invoke("verda:bot:start"),
    stop: () => ipcRenderer.invoke("verda:bot:stop"),
    restart: (rebuild = false) => ipcRenderer.invoke("verda:bot:restart", rebuild),
    setAutoStart: (value: boolean) => ipcRenderer.invoke("verda:bot:auto-start", value),
    openLogs: () => ipcRenderer.invoke("verda:bot:open-logs"),
    onChange: (callback: (state: unknown) => void) => {
      const listener = (_event: IpcRendererEvent, state: unknown) => callback(state);
      ipcRenderer.on("verda:bot:changed", listener);
      return () => ipcRenderer.removeListener("verda:bot:changed", listener);
    },
  },
  settings: {
    get: () => ipcRenderer.invoke("verda:settings:get"),
    validate: (changes: unknown) =>
      ipcRenderer.invoke("verda:settings:validate", changes),
    checkSlack: (changes: unknown) =>
      ipcRenderer.invoke("verda:settings:check-slack", changes),
    save: (changes: unknown, restart = false) =>
      ipcRenderer.invoke("verda:settings:save", changes, restart),
    revealEnv: () => ipcRenderer.invoke("verda:settings:reveal-env"),
    openDataDir: () => ipcRenderer.invoke("verda:settings:open-data-dir"),
  },
  sandbox: {
    status: () => ipcRenderer.invoke("verda:sandbox:status"),
    job: () => ipcRenderer.invoke("verda:sandbox:job"),
    run: (kind: string) => ipcRenderer.invoke("verda:sandbox:run", kind),
    saveAllowlist: (domains: string[]) =>
      ipcRenderer.invoke("verda:sandbox:save-allowlist", domains),
    onJob: (callback: (job: unknown) => void) => {
      const listener = (_event: IpcRendererEvent, job: unknown) => callback(job);
      ipcRenderer.on("verda:sandbox:job-changed", listener);
      return () => ipcRenderer.removeListener("verda:sandbox:job-changed", listener);
    },
  },
});
