import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { utilityProcess, type UtilityProcess } from "electron";
import { readBotStatus } from "../../../src/runtime/status.js";
import type { SupervisorState } from "../../../src/runtime/types.js";

export type { SupervisorState };

/**
 * 데스크톱 앱이 봇(Socket Mode)을 자식 프로세스로 띄우고 관리한다.
 * - 저장소의 빌드 결과(dist/index.js)를 Electron utilityProcess 로 실행한다. 소스가 더 새로우면 먼저 빌드한다.
 * - 터미널(pnpm dev 등)에서 이미 봇이 떠 있으면 건드리지 않고 "external" 로 보여 준다.
 * - 정상 동작하던 봇이 죽으면 몇 번까지 다시 띄운다. 시작하자마자 죽으면 설정 문제로 보고 멈춘다.
 * - 중지는 SIGTERM 이다. 봇은 처리 중인 요청을 최대 20초 기다리고, 남은 요청은 다음 시작 때 이어서 처리한다.
 */
interface Settings {
  autoStartBot: boolean;
}

const OUTPUT_LINES = 200;
const STOP_TIMEOUT_MS = 30_000;
/** 이 시간 이상 동작하다 죽었으면 다시 띄운다. */
const HEALTHY_UPTIME_MS = 30_000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60_000;

export class BotSupervisor extends EventEmitter<{ change: [SupervisorState] }> {
  private child?: UtilityProcess;
  private childStartedAt = 0;
  private stopRequested = false;
  private restartTimes: number[] = [];
  private poller?: NodeJS.Timeout;
  private state: SupervisorState;
  private readonly settingsFile: string;

  constructor(
    private readonly options: {
      repoRoot: string;
      /** 설정 파일 (저장소 밖, src/settings/paths.ts) */
      envFile: string;
      dataDir: string;
      /** 로그인 셸 PATH (Finder 로 띄운 앱에는 docker, codex, pnpm 경로가 없다) */
      toolPath: () => string;
      log: (message: string) => void;
    }
  ) {
    super();
    this.settingsFile = path.join(options.dataDir, "desktop.json");
    this.state = {
      phase: "idle",
      output: [],
      autoStart: this.readSettings().autoStartBot,
      restarts: 0,
    };
    this.refreshExternal();
    // 외부 봇이 뜨고 지는 것도 따라간다.
    this.poller = setInterval(() => this.refreshExternal(), 2_000);
    this.poller.unref();
  }

  get current(): SupervisorState {
    return this.state;
  }

  get managing(): boolean {
    return this.child !== undefined;
  }

  setAutoStart(value: boolean): void {
    writeFileSync(
      this.settingsFile,
      `${JSON.stringify({ autoStartBot: value }, null, 2)}\n`
    );
    this.set({ autoStart: value });
  }

  async start(options: { rebuild?: boolean } = {}): Promise<void> {
    if (this.child || this.state.phase === "building") return;
    this.refreshExternal();
    if (this.state.phase === "external") return;
    this.stopRequested = false;
    const entry = path.join(this.options.repoRoot, "dist/index.js");
    if (options.rebuild || this.needsBuild(entry)) {
      if (!(await this.build())) return;
    }
    this.spawn(entry);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopRequested = true;
    this.set({ phase: "stopping", message: "처리 중인 요청을 마무리하고 종료합니다." });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.pid) {
          try {
            process.kill(child.pid, "SIGKILL");
          } catch {
            // 이미 종료됨
          }
        }
        resolve();
      }, STOP_TIMEOUT_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }

  async restart(options: { rebuild?: boolean } = {}): Promise<void> {
    await this.stop();
    await this.start(options);
  }

  dispose(): void {
    if (this.poller) clearInterval(this.poller);
  }

  /** pnpm build (tsc). 출력은 output 에 남는다. */
  private build(): Promise<boolean> {
    this.set({ phase: "building", message: "봇을 빌드하는 중 (pnpm build)", output: [] });
    return new Promise((resolve) => {
      execFile(
        "pnpm",
        ["build"],
        {
          cwd: this.options.repoRoot,
          env: { ...process.env, PATH: this.options.toolPath() },
          timeout: 180_000,
          maxBuffer: 4 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          const output = `${stdout}${stderr}`
            .split("\n")
            .filter(Boolean)
            .slice(-OUTPUT_LINES);
          if (err) {
            this.options.log(`bot build failed: ${err.message}`);
            this.set({ phase: "crashed", message: "빌드에 실패했습니다.", output });
            resolve(false);
            return;
          }
          this.set({ phase: "idle", message: undefined, output });
          resolve(true);
        }
      );
    });
  }

  private spawn(entry: string): void {
    const env: Record<string, string> = {};
    // node --env-file 과 같이, 이미 있는 환경 변수가 설정 파일보다 우선한다.
    const { envFile } = this.options;
    if (existsSync(envFile)) Object.assign(env, parseEnv(readFileSync(envFile, "utf8")));
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("ELECTRON_")) env[key] = value;
    }
    env.PATH = this.options.toolPath();
    env.VERDA_MANAGED_BY = "desktop";
    env.VERDA_DATA_DIR = this.options.dataDir;
    env.NODE_ENV = "production";

    const child = utilityProcess.fork(entry, [], {
      cwd: this.options.repoRoot,
      env,
      stdio: "pipe",
      serviceName: "Verda bot",
    });
    this.child = child;
    this.childStartedAt = Date.now();
    this.set({ phase: "starting", pid: undefined, message: undefined, output: [] });

    const capture = (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      this.set({ output: [...this.state.output, ...lines].slice(-OUTPUT_LINES) });
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.once("spawn", () => this.set({ pid: child.pid }));
    child.once("exit", (code) => this.onExit(child, code));
  }

  private onExit(child: UtilityProcess, code: number): void {
    if (this.child !== child) return;
    this.child = undefined;
    const uptime = Date.now() - this.childStartedAt;
    this.options.log(`bot exited code=${code} uptime=${uptime}ms`);
    if (this.stopRequested) {
      this.set({ phase: "idle", pid: undefined, message: "중지됨" });
      return;
    }
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
    const last = this.state.output.at(-1) ?? "";
    if (uptime >= HEALTHY_UPTIME_MS && this.restartTimes.length < MAX_RESTARTS) {
      this.restartTimes.push(now);
      this.set({
        phase: "crashed",
        pid: undefined,
        restarts: this.restartTimes.length,
        message: `봇이 종료되어(code ${code}) 3초 뒤 다시 시작합니다.`,
      });
      setTimeout(() => void this.start(), 3_000);
      return;
    }
    this.set({
      phase: "crashed",
      pid: undefined,
      message:
        uptime < HEALTHY_UPTIME_MS
          ? `봇이 시작하자마자 종료되었습니다 (code ${code}). ${last}`.trim()
          : `봇이 반복해서 종료되어 다시 시작하지 않습니다 (code ${code}).`,
    });
  }

  /** bot.json 을 보고 phase 를 맞춘다. 직접 띄운 봇은 running, 남이 띄운 봇은 external */
  private refreshExternal(): void {
    const view = readBotStatus(this.options.dataDir);
    if (this.child) {
      const ours = view.alive && view.status?.pid === this.child.pid;
      const running = ours && view.status?.state === "running";
      if (running && this.state.phase === "starting") this.set({ phase: "running" });
      return;
    }
    const externalPid = view.alive ? view.status?.pid : undefined;
    if (externalPid && this.state.phase !== "external") {
      this.set({
        phase: "external",
        pid: externalPid,
        message:
          "터미널 등 다른 곳에서 실행 중인 봇입니다. 그 봇을 끄면 여기서 관리할 수 있습니다.",
      });
    } else if (!externalPid && this.state.phase === "external") {
      this.set({ phase: "idle", pid: undefined, message: "외부 봇이 종료되었습니다." });
      if (this.state.autoStart) void this.start();
    }
  }

  /** dist/index.js 가 없거나 src 가 더 새로우면 빌드가 필요하다. */
  private needsBuild(entry: string): boolean {
    if (!existsSync(entry)) return true;
    const built = statSync(entry).mtimeMs;
    const newest = (dir: string): number =>
      readdirSync(dir, { withFileTypes: true }).reduce((max, item) => {
        const file = path.join(dir, item.name);
        const mtime = item.isDirectory() ? newest(file) : statSync(file).mtimeMs;
        return Math.max(max, mtime);
      }, 0);
    return newest(path.join(this.options.repoRoot, "src")) > built;
  }

  private readSettings(): Settings {
    try {
      const parsed = JSON.parse(
        readFileSync(this.settingsFile, "utf8")
      ) as Partial<Settings>;
      return { autoStartBot: parsed.autoStartBot ?? true };
    } catch {
      return { autoStartBot: true };
    }
  }

  private set(patch: Partial<SupervisorState>): void {
    this.state = { ...this.state, ...patch };
    this.emit("change", this.state);
  }
}
