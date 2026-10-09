import {
  SETTING_FIELDS,
  SETTING_GROUPS,
  type SettingField,
  type SettingsChanges,
  type SettingsIssue,
  type SettingsView,
  type SettingTab,
} from "@src/settings/fields";
import type { SlackCheckItem } from "@src/slack/check";
import {
  ChevronRight,
  CircleCheck,
  CircleX,
  FolderOpen,
  LoaderCircle,
  PlugZap,
  RotateCcw,
  Save,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { botControl, useSandbox, useSupervisor } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { AllowlistCard, APPLY_LABEL, JobsCard, SandboxStatusCard } from "./sandbox-panel";

const bridge = () => window.verdaDesktop?.settings;

/**
 * Settings screen that edits the settings file (~/.verda/.env). Available only in the desktop app.
 * draft holds the values changed in the UI. An empty string means revert to default.
 */
export function SettingsPage() {
  const settings = bridge();
  const supervisor = useSupervisor();
  const sandbox = useSandbox();
  // Opening #/settings/sandbox selects the Sandbox tab
  const [tab, setTab] = useState<SettingTab>(
    window.location.hash.startsWith("#/settings/sandbox") ? "sandbox" : "bot"
  );
  const [view, setView] = useState<SettingsView>();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const [issues, setIssues] = useState<SettingsIssue[]>([]);
  const [check, setCheck] = useState<SlackCheckItem[] | "running">();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "ok" | "warn";
    text: string;
    restart?: boolean;
  }>();

  const load = useCallback(() => {
    void settings?.get().then((value) => value && setView(value));
  }, [settings]);
  useEffect(load, [load]);

  const current = useCallback(
    (field: SettingField) =>
      field.type === "secret" ? "" : (view?.values[field.key] ?? ""),
    [view]
  );

  // Sends only values that actually changed. Secrets are sent only when newly entered.
  const changes = useMemo<SettingsChanges>(() => {
    const result: SettingsChanges = {};
    for (const field of SETTING_FIELDS) {
      if (!(field.key in draft)) continue;
      const value = draft[field.key]!.trim();
      if (field.type === "secret") {
        if (editing.has(field.key) && value) result[field.key] = value;
        continue;
      }
      if (value !== current(field)) result[field.key] = value === "" ? null : value;
    }
    return result;
  }, [draft, editing, current]);
  const changeCount = Object.keys(changes).length;

  useEffect(() => {
    if (!settings || changeCount === 0) {
      setIssues([]);
      return;
    }
    const timer = setTimeout(() => void settings.validate(changes).then(setIssues), 300);
    return () => clearTimeout(timer);
  }, [settings, changes, changeCount]);

  if (!settings) {
    return (
      <p className="p-10 text-center text-sm text-muted-foreground">
        Settings can be changed in the desktop app.
      </p>
    );
  }
  if (!view) return null;

  const set = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }));
  const reset = () => {
    setDraft({});
    setEditing(new Set());
    setIssues([]);
  };
  const runCheck = () => {
    setCheck("running");
    void settings.checkSlack(changes).then(setCheck);
  };
  const save = (restart: boolean) => {
    setSaving(true);
    void settings
      .save(changes, restart)
      .then(({ issues: found, restarted }) => {
        if (found.length > 0) {
          setIssues(found);
          return;
        }
        const brokerChanged = SETTING_FIELDS.some(
          (field) => field.applies === "broker" && field.key in changes
        );
        const botChanged = SETTING_FIELDS.some(
          (field) => field.applies !== "broker" && field.key in changes
        );
        reset();
        load();
        sandbox.refresh();
        const brokerNote = brokerChanged
          ? ` Apply broker settings with "${APPLY_LABEL.broker}".`
          : "";
        setNotice(
          restarted || !botChanged
            ? {
                tone: brokerChanged ? "warn" : "ok",
                text: `${restarted ? "Saved and restarted the bot." : "Saved."}${brokerNote}`,
              }
            : {
                tone: "warn",
                text: `Saved. Restart the bot to apply.${brokerNote}`,
                restart: Boolean(supervisor),
              }
        );
      })
      .finally(() => setSaving(false));
  };
  const issueOf = (key: string) => issues.find((issue) => issue.key === key)?.message;
  const generalIssues = issues.filter(
    (issue) => !issue.key || !SETTING_FIELDS.some((field) => field.key === issue.key)
  );
  const canRestart =
    supervisor && supervisor.phase !== "external" && supervisor.phase !== "building";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-3xl space-y-4 px-8 py-6">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The bot reads a settings file outside the repository (path below). The app
              and terminal runs use the same file. Saved changes take effect after the bot
              restarts.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="font-mono">{view.envFile}</span>
              {!view.exists && (
                <span className="text-status-interrupted">
                  (does not exist yet; saving creates it)
                </span>
              )}
              <Button variant="ghost" size="xs" onClick={() => void settings.revealEnv()}>
                <FolderOpen />
                Show in Finder
              </Button>
            </div>
          </div>

          <Tabs value={tab} onValueChange={(value) => setTab(value as SettingTab)}>
            <TabsList>
              <TabsTrigger value="bot">Bot</TabsTrigger>
              <TabsTrigger value="sandbox">Sandbox</TabsTrigger>
            </TabsList>
          </Tabs>

          {notice && (
            <div
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-2 text-sm",
                notice.tone === "ok"
                  ? "bg-status-succeeded/10 text-status-succeeded"
                  : "bg-status-interrupted/10 text-status-interrupted"
              )}
            >
              {notice.tone === "ok" ? (
                <CircleCheck className="size-4 shrink-0" />
              ) : (
                <TriangleAlert className="size-4 shrink-0" />
              )}
              {notice.text}
              {notice.restart && canRestart && (
                <Button
                  size="xs"
                  variant="outline"
                  className="ml-auto"
                  onClick={() => {
                    const control = botControl();
                    const live =
                      supervisor?.phase === "running" || supervisor?.phase === "starting";
                    void (live ? control?.restart() : control?.start());
                    setNotice({ tone: "ok", text: "Restarting the bot." });
                  }}
                >
                  Restart now
                </Button>
              )}
            </div>
          )}

          {tab === "sandbox" &&
            (sandbox.available ? (
              <>
                <p className="text-xs text-muted-foreground">
                  The execution environment is currently{" "}
                  <b>{view.values.REASONER_SANDBOX || "none"}</b>.
                  {(view.values.REASONER_SANDBOX || "none") !== "docker" &&
                    " Sandbox settings apply when the execution environment is docker."}{" "}
                  (Change it in the reasoner section of the Bot tab)
                </p>
                <SandboxStatusCard sandbox={sandbox} />
              </>
            ) : null)}

          {SETTING_GROUPS.filter((group) => group.tab === tab).map((group) => {
            const fields = SETTING_FIELDS.filter((field) => field.group === group.id);
            const basic = fields.filter((field) => !field.advanced);
            const advanced = fields.filter((field) => field.advanced);
            const row = (field: SettingField) => (
              <FieldRow
                key={field.key}
                field={field}
                view={view}
                value={draft[field.key] ?? current(field)}
                changed={field.key in changes}
                editing={editing.has(field.key)}
                issue={issueOf(field.key)}
                showApplies={tab === "sandbox"}
                onChange={(value) => set(field.key, value)}
                onEdit={(on) => {
                  setEditing((prev) => {
                    const next = new Set(prev);
                    if (on) next.add(field.key);
                    else next.delete(field.key);
                    return next;
                  });
                  if (!on) {
                    setDraft((prev) => {
                      const next = { ...prev };
                      delete next[field.key];
                      return next;
                    });
                  }
                }}
              />
            );
            return (
              <section key={group.id} className="surface-card overflow-hidden">
                <header className="flex items-start gap-3 border-b border-canvas px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-semibold">{group.label}</h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">{group.help}</p>
                  </div>
                  {group.id === "connection" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={runCheck}
                      disabled={check === "running"}
                    >
                      {check === "running" ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <PlugZap />
                      )}
                      Check connection
                    </Button>
                  )}
                </header>
                {group.id === "connection" && check && check !== "running" && (
                  <CheckResult items={check} />
                )}
                <div className="divide-y divide-canvas">{basic.map(row)}</div>
                {advanced.length > 0 && (
                  <Advanced count={advanced.length}>{advanced.map(row)}</Advanced>
                )}
              </section>
            );
          })}

          {tab === "sandbox" && sandbox.available && (
            <>
              <AllowlistCard sandbox={sandbox} />
              <JobsCard sandbox={sandbox} />
            </>
          )}

          <section
            className={cn("surface-card overflow-hidden", tab !== "bot" && "hidden")}
          >
            <header className="border-b border-canvas px-4 py-3">
              <h2 className="text-sm font-semibold">App</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Desktop app settings are stored in the run history folder, not in .env.
              </p>
            </header>
            <div className="divide-y divide-canvas">
              {supervisor && (
                <Row
                  label="Start the bot automatically when the app opens"
                  help="When off, start the bot from the Bot screen or the menu bar (tray)."
                >
                  <Switch
                    checked={supervisor.autoStart}
                    onChange={(value) => void botControl()?.setAutoStart(value)}
                  />
                </Row>
              )}
              <Row
                label="Run history folder"
                help="VERDA_DATA_DIR. To change it, edit the settings file (.env) and relaunch the app."
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-xs text-muted-foreground">
                    {view.dataDir}
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => void settings.openDataDir()}
                  >
                    <FolderOpen />
                    Open
                  </Button>
                </div>
              </Row>
              {view.otherKeys.length > 0 && (
                <Row
                  label="Other .env entries"
                  help="Entries the Settings screen does not handle. They are kept as is when saving."
                >
                  <span className="text-right font-mono text-xs text-muted-foreground">
                    {view.otherKeys.join(", ")}
                  </span>
                </Row>
              )}
            </div>
          </section>
          <div className="h-16" />
        </div>
      </ScrollArea>

      {changeCount > 0 && (
        <footer className="shrink-0 border-t bg-canvas/95 px-8 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-center gap-2">
            <span className="text-sm font-medium">
              {changeCount} {changeCount === 1 ? "change" : "changes"}
            </span>
            {issues.length > 0 && (
              <span className="flex items-center gap-1 text-xs text-status-failed">
                <TriangleAlert className="size-3.5 shrink-0" />
                {generalIssues[0]?.message ??
                  `${issues.length} ${issues.length === 1 ? "issue" : "issues"} to fix`}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <Button variant="ghost" size="sm" onClick={reset} disabled={saving}>
                <RotateCcw />
                Revert
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => save(false)}
                disabled={saving || issues.length > 0}
              >
                <Save />
                Save
              </Button>
              {canRestart && (
                <Button
                  size="sm"
                  onClick={() => save(true)}
                  disabled={saving || issues.length > 0}
                >
                  {saving ? <LoaderCircle className="animate-spin" /> : <Save />}
                  Save and restart bot
                </Button>
              )}
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}

function FieldRow({
  field,
  view,
  value,
  changed,
  editing,
  issue,
  showApplies,
  onChange,
  onEdit,
}: {
  field: SettingField;
  view: SettingsView;
  value: string;
  changed: boolean;
  editing: boolean;
  issue?: string;
  /** Shows what must be reapplied after a change. */
  showApplies?: boolean;
  onChange: (value: string) => void;
  onEdit: (on: boolean) => void;
}) {
  const overridden = view.overridden.includes(field.key);
  return (
    <Row
      label={
        <span className="flex items-center gap-1.5">
          {field.label}
          {changed && (
            <span className="size-1.5 rounded-full bg-primary" aria-label="Changed" />
          )}
          {showApplies && (
            <span
              className={cn(
                "rounded px-1.5 text-[10px] font-normal",
                field.applies === "broker"
                  ? "bg-status-running/12 text-status-running"
                  : "bg-muted text-muted-foreground"
              )}
            >
              Apply: {APPLY_LABEL[field.applies ?? "bot"]}
            </span>
          )}
        </span>
      }
      sub={field.key}
      help={field.help}
      issue={issue}
      warning={
        overridden
          ? "This variable is set in the app environment and takes precedence over .env."
          : undefined
      }
    >
      <Control
        field={field}
        view={view}
        value={value}
        editing={editing}
        onChange={onChange}
        onEdit={onEdit}
      />
    </Row>
  );
}

function Control({
  field,
  view,
  value,
  editing,
  onChange,
  onEdit,
}: {
  field: SettingField;
  view: SettingsView;
  value: string;
  editing: boolean;
  onChange: (value: string) => void;
  onEdit: (on: boolean) => void;
}) {
  switch (field.type) {
    case "secret": {
      const secret = view.secrets[field.key];
      if (!editing) {
        return (
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "font-mono text-xs",
                secret?.set ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {secret?.set ? secret.hint : "Not set"}
            </span>
            <Button size="xs" variant="outline" onClick={() => onEdit(true)}>
              {secret?.set ? "Change" : "Enter"}
            </Button>
          </div>
        );
      }
      return (
        <div className="flex w-72 items-center gap-1.5">
          <Input
            type="password"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={value}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
            className="h-7 font-mono text-xs"
          />
          <Button size="xs" variant="ghost" onClick={() => onEdit(false)}>
            Cancel
          </Button>
        </div>
      );
    }
    case "toggle":
      return (
        <Switch
          checked={(value || field.default) === "on"}
          onChange={(on) => onChange(on ? "on" : "off")}
        />
      );
    case "select":
      return (
        <select
          value={value || field.default || ""}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 dark:bg-input/30"
        >
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    default:
      return (
        <Input
          value={value}
          inputMode={field.type === "number" ? "numeric" : undefined}
          placeholder={
            field.placeholder ??
            (field.default ? `Default ${field.default}` : "Leave empty to disable")
          }
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "h-7 text-xs",
            field.type === "number" ? "w-32 text-right tabular-nums" : "w-72"
          )}
        />
      );
  }
}

function Row({
  label,
  sub,
  help,
  issue,
  warning,
  children,
}: {
  label: React.ReactNode;
  sub?: string;
  help?: string;
  issue?: string;
  warning?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        {sub && (
          <div className="font-mono text-[10.5px] text-muted-foreground/80">{sub}</div>
        )}
        {help && <p className="mt-0.5 text-xs text-muted-foreground">{help}</p>}
        {warning && (
          <p className="mt-1 flex items-center gap-1 text-xs text-status-interrupted">
            <TriangleAlert className="size-3.5 shrink-0" />
            {warning}
          </p>
        )}
        {issue && <p className="mt-1 text-xs text-status-failed">{issue}</p>}
      </div>
      <div className="flex min-h-7 shrink-0 items-center">{children}</div>
    </div>
  );
}

function Switch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 rounded-full transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none",
        checked ? "bg-primary" : "bg-input"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 size-4 rounded-full bg-background shadow transition-transform",
          checked && "translate-x-4"
        )}
      />
    </button>
  );
}

function Advanced({ count, children }: { count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-t border-canvas">
      <CollapsibleTrigger className="flex w-full items-center gap-1 px-4 py-2 text-left text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        Advanced ({count})
      </CollapsibleTrigger>
      <CollapsibleContent className="divide-y divide-canvas overflow-hidden border-t border-canvas data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function CheckResult({ items }: { items: SlackCheckItem[] }) {
  return (
    <ul className="space-y-1 border-b border-canvas bg-well/60 px-4 py-2.5">
      {items.map((item) => (
        <li key={item.label} className="flex items-start gap-2 text-xs">
          {item.ok ? (
            <CircleCheck className="mt-px size-3.5 shrink-0 text-status-succeeded" />
          ) : (
            <CircleX className="mt-px size-3.5 shrink-0 text-status-failed" />
          )}
          <span className="w-20 shrink-0 font-medium">{item.label}</span>
          <span className="text-muted-foreground">{item.detail}</span>
        </li>
      ))}
    </ul>
  );
}
