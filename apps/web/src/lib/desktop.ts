import type { SupervisorState } from "@runtime/types";
import type { SandboxJob, SandboxJobKind, SandboxStatus } from "@src/sandbox/types";
import { useCallback, useEffect, useState } from "react";

/** Bot process state managed by the desktop app. undefined in the browser (dev server) */
export function useSupervisor(): SupervisorState | undefined {
  const bridge = window.verdaDesktop?.bot;
  const [state, setState] = useState<SupervisorState>();
  useEffect(() => {
    if (!bridge) return;
    void bridge.state().then((value) => value && setState(value));
    return bridge.onChange(setState);
  }, [bridge]);
  return state;
}

export const botControl = () => window.verdaDesktop?.bot;

/** Sandbox status and apply jobs. Reloads the status when a job finishes. */
export function useSandbox() {
  const bridge = window.verdaDesktop?.sandbox;
  const [status, setStatus] = useState<SandboxStatus>();
  const [loading, setLoading] = useState(false);
  const [job, setJob] = useState<SandboxJob>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(() => {
    if (!bridge) return;
    setLoading(true);
    void bridge
      .status()
      .then((value) => value && setStatus(value))
      .finally(() => setLoading(false));
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    refresh();
    void bridge.job().then((value) => value && setJob(value));
    return bridge.onJob((next) => {
      setJob(next);
      if (next.state !== "running") refresh();
    });
  }, [bridge, refresh]);

  const run = (kind: SandboxJobKind) => {
    setError(undefined);
    void bridge?.run(kind).then((result) => {
      if (result.error) setError(result.error);
      else if (result.job) setJob(result.job);
    });
  };

  return { available: Boolean(bridge), status, loading, refresh, job, run, error };
}
