/// <reference types="vite/client" />

import type { SupervisorState } from "@runtime/types";
import type { SettingsChanges, SettingsIssue, SettingsView } from "@src/settings/fields";
import type { SlackCheckItem } from "@src/slack/check";
import type {
  AllowlistIssue,
  SandboxJob,
  SandboxJobKind,
  SandboxStatus,
} from "@src/sandbox/types";

declare global {
  interface Window {
    /** Present only in the desktop app (preload). */
    verdaDesktop?: {
      platform: string;
      bot: {
        state(): Promise<SupervisorState | null>;
        start(): Promise<void>;
        stop(): Promise<void>;
        restart(rebuild?: boolean): Promise<void>;
        setAutoStart(value: boolean): Promise<void>;
        openLogs(): Promise<void>;
        onChange(callback: (state: SupervisorState) => void): () => void;
      };
      settings: {
        get(): Promise<SettingsView | null>;
        validate(changes: SettingsChanges): Promise<SettingsIssue[]>;
        checkSlack(changes: SettingsChanges): Promise<SlackCheckItem[]>;
        save(
          changes: SettingsChanges,
          restart?: boolean
        ): Promise<{ issues: SettingsIssue[]; restarted: boolean }>;
        revealEnv(): Promise<void>;
        openDataDir(): Promise<void>;
      };
      sandbox: {
        status(): Promise<SandboxStatus | null>;
        job(): Promise<SandboxJob | null>;
        run(kind: SandboxJobKind): Promise<{ job?: SandboxJob; error?: string }>;
        saveAllowlist(domains: string[]): Promise<AllowlistIssue[]>;
        onJob(callback: (job: SandboxJob) => void): () => void;
      };
    };
  }
}
