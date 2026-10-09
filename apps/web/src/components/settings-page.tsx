import {
  SETTING_FIELDS,
  SETTING_GROUPS,
  SETTING_SECTIONS,
  settingSectionOf,
  type SettingField,
  type SettingGroup,
  type SettingGroupInfo,
  type SettingSection,
  type SettingsChanges,
  type SettingsIssue,
  type SettingsView,
} from "@src/settings/fields";
import type { HubUser } from "@src/hub/protocol";
import { MESSENGER_IDS, MESSENGER_NAMES, type MessengerId } from "@src/messengers/ids";
import type { BrokerHealth } from "@src/sandbox/types";
import type { SlackCheckItem } from "@src/messengers/slack/check";
import {
  Box,
  ChevronRight,
  CircleCheck,
  CircleX,
  FolderOpen,
  History,
  KeyRound,
  LoaderCircle,
  MessagesSquare,
  Monitor,
  Moon,
  Plug,
  PlugZap,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Sparkles,
  Sun,
  TriangleAlert,
  Wrench,
  type LucideIcon,
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
import { botControl, useSandbox, useSupervisor } from "@/lib/desktop";
import { useTheme, type ThemeMode } from "@/lib/theme";
import { cn } from "@/lib/utils";
import {
  AllowlistCard,
  APPLY_LABEL,
  JobsCard,
  PendingList,
  SandboxStatusCard,
} from "./sandbox-panel";

const bridge = () => window.orblyDesktop?.settings;

/** Settings sections: the bot's own (.env), then the desktop app's preferences. */
type Section = SettingSection | "general";

const SECTION_ICON: Record<SettingSection, LucideIcon> = {
  messengers: MessagesSquare,
  answers: Sparkles,
  sandbox: Box,
  ops: Wrench,
  logs: History,
};

const SECTION_INFO: Record<Section, { label: string; help: string; icon: LucideIcon }> = {
  ...(Object.fromEntries(
    SETTING_SECTIONS.map((info) => [
      info.id,
      { label: info.label, help: info.help, icon: SECTION_ICON[info.id] },
    ])
  ) as Record<SettingSection, { label: string; help: string; icon: LucideIcon }>),
  general: {
    label: "General",
    help: "Preferences for this app, and where Orbly keeps its settings and run history.",
    icon: SlidersHorizontal,
  },
};

/** The app's own preferences first, then the bot's settings (as macOS lists General first) */
const NAV: { label: string; items: Section[] }[] = [
  { label: "App", items: ["general"] },
  { label: "Bot", items: SETTING_SECTIONS.map((info) => info.id) },
];

const GROUP = Object.fromEntries(SETTING_GROUPS.map((info) => [info.id, info])) as Record<
  SettingGroup,
  SettingGroupInfo
>;
const FIELD = new Map(SETTING_FIELDS.map((field) => [field.key, field]));
/** What your own Slack app needs before the bot can start */
const SLACK_APP_TOKENS = ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"];

/**
 * #/settings/<section> picks the section; plain #/settings opens the first one, General. ("Setup needed" links straight
 * to the section to fix, such as #/settings/messengers.) #/settings/slack is the Messengers section's name from before.
 */
function readSection(): Section {
  const id = /^#\/settings\/([a-z]+)/.exec(window.location.hash)?.[1];
  if (id === "slack") return "messengers";
  return id && id in SECTION_INFO ? (id as Section) : "general";
}

function useSection(): [Section, (section: Section) => void] {
  const [section, setSection] = useState(readSection);
  useEffect(() => {
    const onChange = () => setSection(readSection());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return [section, (next) => (window.location.hash = `#/settings/${next}`)];
}

/** A short state shown beside a section in the navigation */
interface Hint {
  tone: "warn" | "muted";
  text: string;
}

/**
 * Settings screen that edits the settings file (~/.orbly/.env). Available only in the desktop app.
 * draft holds the values changed in the UI. An empty string means revert to default.
 * Changes are kept across sections and saved together from the bar at the bottom.
 */
export function SettingsPage() {
  const settings = bridge();
  const supervisor = useSupervisor();
  const sandbox = useSandbox();
  const [section, go] = useSection();
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

  /** The value in effect once the draft is saved: the draft, else .env, else the default. Secrets read "set" or "". */
  const valueOf = (key: string): string => {
    const field = FIELD.get(key);
    if (!field) return "";
    if (field.type === "secret") {
      const entered = editing.has(key) && Boolean(draft[key]?.trim());
      return entered || view.secrets[key]?.set ? "set" : "";
    }
    const value = key in draft ? draft[key]!.trim() : (view.values[key] ?? "");
    return value || field.default || "";
  };
  const isSet = (key: string) => valueOf(key) !== "";
  const shown = (field: SettingField) =>
    !field.internal &&
    (!field.shownWhen || valueOf(field.shownWhen.key) === field.shownWhen.equals);

  const set = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }));
  /** Opens a secret's input, or closes it and drops what was typed. */
  const edit = (key: string, on: boolean) => {
    setEditing((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
    if (!on) {
      setDraft((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };
  const reset = () => {
    setDraft({});
    setEditing(new Set());
    setIssues([]);
  };
  const runCheck = () => {
    setCheck("running");
    void settings.checkSlack(changes).then(setCheck);
  };
  // A running bot is restarted to apply settings; a stopped one (or one waiting for setup) is started.
  const botLive = supervisor?.phase === "running" || supervisor?.phase === "starting";
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
          ? ` Apply the ops tool changes with "${APPLY_LABEL.broker}".`
          : "";
        setNotice(
          restarted || !botChanged
            ? {
                tone: brokerChanged ? "warn" : "ok",
                text: `${restarted ? (botLive ? "Saved and restarted the bot." : "Saved and started the bot.") : "Saved."}${brokerNote}`,
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
  // A secret's own Save: stores just that value and closes its input, leaving the other unsaved changes as they are.
  const saveField = (field: SettingField) => {
    const value = draft[field.key]?.trim();
    if (!value) return;
    setSaving(true);
    void settings
      .save({ [field.key]: value }, false)
      .then(({ issues: found }) => {
        if (found.length > 0) {
          setIssues(found);
          return;
        }
        edit(field.key, false);
        load();
        sandbox.refresh();
        const label = field.label.charAt(0).toLowerCase() + field.label.slice(1);
        // Your own Slack app needs both tokens before the bot can start.
        const other = SLACK_APP_TOKENS.includes(field.key)
          ? SLACK_APP_TOKENS.find((key) => key !== field.key && !view.secrets[key]?.set)
          : undefined;
        setNotice(
          field.applies === "broker"
            ? {
                tone: "warn",
                text: `Saved the ${label}. Apply it with "${APPLY_LABEL.broker}".`,
              }
            : other
              ? {
                  tone: "ok",
                  text: `Saved the ${label}. Enter the ${FIELD.get(other)?.label.toLowerCase()} next.`,
                }
              : {
                  tone: "warn",
                  text: `Saved the ${label}. ${botLive ? "Restart" : "Start"} the bot to use it.`,
                  restart: true,
                }
        );
      })
      .finally(() => setSaving(false));
  };
  const issueOf = (key: string) => issues.find((issue) => issue.key === key)?.message;
  // Issues with no field on screen (general ones, or a field hidden by another value) are spelled out in the save bar.
  const offscreenIssues = issues.filter((issue) => {
    const field = issue.key ? FIELD.get(issue.key) : undefined;
    return !field || !shown(field);
  });
  const issueSection = issues.map((issue) => settingSectionOf(issue.key)).find(Boolean);
  const canRestart =
    supervisor && supervisor.phase !== "external" && supervisor.phase !== "building";

  // What each section shows in the navigation: an issue dot, its unsaved changes, or a short state.
  const sectionChanges = (id: Section) =>
    Object.keys(changes).filter((key) => settingSectionOf(key) === id).length;
  const sectionIssues = (id: Section) =>
    issues.filter((issue) => settingSectionOf(issue.key) === id).length;
  const docker = valueOf("REASONER_SANDBOX") === "docker";
  const opsOn = valueOf("OPS_TOOLS") === "on";
  const pending = sandbox.status?.pending ?? [];
  const opsReady = docker && isSet("MENTION_ALLOWED_USERS");
  const hubMode = valueOf("SLACK_CONNECTION") === "hub";
  const slackReady = hubMode
    ? isSet("HUB_URL") && isSet("HUB_TOKEN")
    : isSet("SLACK_APP_TOKEN") && isSet("SLACK_BOT_TOKEN");
  /** How each messenger is connected, beside its heading */
  const messengerChips: Record<MessengerId, React.ReactNode> = {
    slack: slackReady ? (
      <Chip tone="ok">{hubMode ? "Team hub" : "Your own app"}</Chip>
    ) : (
      <Chip tone="warn">{hubMode ? "Not paired" : "Not connected"}</Chip>
    ),
  };
  const hints: Partial<Record<Section, Hint>> = {
    // Short enough to sit beside "Messengers"; the Slack heading says what is missing.
    messengers: slackReady ? undefined : { tone: "warn", text: "Set up" },
    sandbox: !docker
      ? { tone: "muted", text: "Off" }
      : sandbox.status && !sandbox.status.docker.ok
        ? { tone: "warn", text: "No docker" }
        : pending.some((item) => item.component !== "broker")
          ? { tone: "warn", text: "Apply needed" }
          : undefined,
    ops: !opsOn
      ? { tone: "muted", text: "Off" }
      : !opsReady
        ? { tone: "warn", text: "Needs setup" }
        : pending.some((item) => item.component === "broker")
          ? { tone: "warn", text: "Apply needed" }
          : undefined,
  };

  const row = (field: SettingField) => (
    <FieldRow
      key={field.key}
      field={field}
      view={view}
      value={draft[field.key] ?? current(field)}
      changed={field.key in changes}
      editing={editing.has(field.key)}
      issue={issueOf(field.key)}
      onChange={(value) => set(field.key, value)}
      onEdit={(on) => edit(field.key, on)}
      onSave={() => saveField(field)}
      saving={saving}
    />
  );
  /** A group's card with only the fields the current values call for. Nothing when none are left. */
  const card = (
    id: SettingGroup,
    extra: Omit<React.ComponentProps<typeof GroupCard>, "info" | "fields" | "row"> = {}
  ) => {
    const fields = SETTING_FIELDS.filter((field) => field.group === id && shown(field));
    if (fields.length === 0 && !extra.children && !extra.after) return null;
    return <GroupCard key={id} info={GROUP[id]} fields={fields} row={row} {...extra} />;
  };
  /** An ops integration's card, with whether its fields turn it on and what the running broker reports. */
  const integration = (id: SettingGroup) => {
    const requires = GROUP[id].requires ?? [];
    const missing = requires.filter((key) => !isSet(key));
    const state =
      missing.length === 0
        ? "on"
        : missing.length === requires.length
          ? "off"
          : "partial";
    return card(id, {
      chip: (
        <StateChip
          state={state}
          title={
            state === "partial"
              ? `Still needed: ${missing.map((key) => FIELD.get(key)?.label ?? key).join(", ")}`
              : undefined
          }
        />
      ),
      live: brokerReport(id, sandbox.status?.broker),
    });
  };

  /** Each messenger's cards, shown under its heading in the Messengers section */
  const messengerCards: Record<MessengerId, React.ReactNode> = {
    slack: (
      <>
        {card("slack", {
          action: (
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
          ),
          children: check && check !== "running" ? <CheckResult items={check} /> : null,
          after: hubMode ? (
            <HubPairing
              hubUrl={valueOf("HUB_URL")}
              paired={
                view.values.SLACK_CONNECTION === "hub" &&
                Boolean(view.secrets.HUB_TOKEN?.set)
              }
              onPaired={(text) => {
                // Pairing saved the connection itself; drop those drafts and show what is saved now.
                setDraft((prev) => {
                  const next = { ...prev };
                  delete next.SLACK_CONNECTION;
                  delete next.HUB_URL;
                  return next;
                });
                setCheck(undefined);
                load();
                setNotice({ tone: "ok", text });
              }}
              onDisconnected={() => {
                setCheck(undefined);
                load();
                setNotice({
                  tone: "ok",
                  text: "Disconnected this desktop from the hub.",
                });
              }}
            />
          ) : undefined,
        })}
        {card("access")}
      </>
    ),
  };

  const content: Record<Section, React.ReactNode> = {
    messengers: MESSENGER_IDS.map((id) => (
      <div key={id} className="space-y-3">
        <SubHeading title={MESSENGER_NAMES[id]} chip={messengerChips[id]} />
        {messengerCards[id]}
      </div>
    )),
    answers: (
      <>
        {card("reasoner")}
        {card("requests")}
        {card("diagrams")}
      </>
    ),
    sandbox: (
      <>
        {card("environment")}
        {docker &&
          card("credentials", {
            help: credentialsHelp(valueOf("REASONER")),
            after:
              valueOf("REASONER") === "claude" ? (
                <ClaudeTokenSetup
                  hasToken={Boolean(view.secrets.SANDBOX_CLAUDE_OAUTH_TOKEN?.set)}
                  onSaved={() => {
                    load();
                    setNotice({
                      tone: "warn",
                      text: "Saved a new claude token. Restart the bot to use it.",
                      restart: true,
                    });
                  }}
                />
              ) : undefined,
          })}
        {docker && sandbox.available && <AllowlistCard sandbox={sandbox} />}
        {sandbox.available && (
          <>
            <SubHeading
              title="Status and maintenance"
              help="Docker, images, and the proxy and broker containers. Diagram rendering uses Docker in either run environment."
            />
            <SandboxStatusCard sandbox={sandbox} />
            <JobsCard sandbox={sandbox} />
          </>
        )}
      </>
    ),
    ops: (
      <>
        {card("ops", {
          after: (
            <Requirements
              items={[
                {
                  ok: docker,
                  label: "Docker sandbox",
                  detail: docker
                    ? "Requests run in the docker sandbox."
                    : "Choose the docker sandbox as the run environment.",
                  action: docker
                    ? undefined
                    : { label: "Open Sandbox", section: "sandbox" },
                },
                {
                  ok: isSet("MENTION_ALLOWED_USERS"),
                  label: "Allowed users",
                  detail: isSet("MENTION_ALLOWED_USERS")
                    ? "Only the allowed users can ask."
                    : "Limit who can ask, since the tools use your credentials.",
                  action: isSet("MENTION_ALLOWED_USERS")
                    ? undefined
                    : { label: "Open Messengers", section: "messengers" },
                },
              ]}
              onOpen={go}
            />
          ),
        })}
        {pending.some((item) => item.component === "broker") && (
          <section className="surface-card overflow-hidden">
            <PendingList
              pending={pending.filter((item) => item.component === "broker")}
              sandbox={sandbox}
            />
          </section>
        )}
        <SubHeading
          title="Integrations"
          help={`Each one turns on once its fields are filled in. Changes apply when the broker is recreated ("${APPLY_LABEL.broker}").${opsOn ? "" : " Ops tools are off, so none are offered to the reasoner yet."}`}
        />
        {integration("files")}
        {integration("github")}
        {integration("jira")}
        {integration("k8s")}
        {integration("ssh")}
      </>
    ),
    logs: (
      <>
        {card("history")}
        {card("logs")}
      </>
    ),
    general: (
      <>
        <section className="surface-card overflow-hidden">
          <CardHeader
            title="App"
            help="Stored with the run history, not in the settings file."
          />
          <div className="divide-y divide-canvas">
            <Row
              label="Theme"
              help="System follows the macOS appearance. ORBLY_DESKTOP_THEME in the environment overrides it."
            >
              <ThemePicker />
            </Row>
            {supervisor && (
              <Row
                label="Start the bot when the app opens"
                help="When off, start the bot from the Bot screen or the menu bar."
              >
                <Switch
                  checked={supervisor.autoStart}
                  onChange={(value) => void botControl()?.setAutoStart(value)}
                />
              </Row>
            )}
          </div>
        </section>
        <section className="surface-card overflow-hidden">
          <CardHeader
            title="Files"
            help="The bot reads its settings from a file outside the repository. Runs from the app and the terminal share it."
          />
          <div className="divide-y divide-canvas">
            <Row
              label="Settings file"
              help={
                view.exists
                  ? "Everything under Bot is saved here."
                  : "Does not exist yet. Saving any bot setting creates it."
              }
            >
              <PathControl
                path={view.envFile}
                label="Show in Finder"
                onOpen={() => void settings.revealEnv()}
              />
            </Row>
            <Row
              label="Run history folder"
              help="ORBLY_DATA_DIR. To change it, edit the settings file and relaunch the app."
            >
              <PathControl
                path={view.dataDir}
                label="Open"
                onOpen={() => void settings.openDataDir()}
              />
            </Row>
            {view.otherKeys.length > 0 && (
              <Row
                label="Other entries in the settings file"
                help="Settings this screen does not handle. Saving keeps them as they are."
              >
                <span className="max-w-72 text-right font-mono text-xs text-muted-foreground">
                  <span className="select-text">{view.otherKeys.join(", ")}</span>
                </span>
              </Row>
            )}
          </div>
        </section>
      </>
    ),
  };

  return (
    // A narrow screen keeps the section list as icons (@settings), and narrow content stacks each row (@content).
    <div className="@container/settings flex h-full min-h-0">
      <nav
        aria-label="Settings sections"
        className="flex w-56 shrink-0 flex-col gap-4 border-r border-sidebar-border px-2.5 py-5 @max-[44rem]/settings:w-14 @max-[44rem]/settings:px-2"
      >
        <h1 className="px-2.5 text-base font-semibold tracking-tight @max-[44rem]/settings:sr-only">
          Settings
        </h1>
        {NAV.map((group) => (
          <div key={group.label} className="space-y-0.5">
            <p className="px-2.5 pb-1 text-[11px] font-medium text-muted-foreground/80 @max-[44rem]/settings:sr-only">
              {group.label}
            </p>
            {group.items.map((id) => (
              <NavItem
                key={id}
                icon={SECTION_INFO[id].icon}
                label={SECTION_INFO[id].label}
                active={section === id}
                changes={sectionChanges(id)}
                issues={sectionIssues(id)}
                hint={hints[id]}
                onClick={() => go(id)}
              />
            ))}
          </div>
        ))}
      </nav>

      <div className="@container/content flex min-w-0 flex-1 flex-col">
        <ScrollArea className="min-h-0 flex-1">
          <div className="max-w-3xl space-y-4 px-8 py-6 @max-[36rem]/content:px-4">
            <header>
              <h2 className="text-lg font-semibold tracking-tight">
                {SECTION_INFO[section].label}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {SECTION_INFO[section].help}
              </p>
            </header>

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
                <span className="select-text">{notice.text}</span>
                {notice.restart && canRestart && (
                  <Button
                    size="xs"
                    variant="outline"
                    className="ml-auto"
                    onClick={() => {
                      const control = botControl();
                      void (botLive ? control?.restart() : control?.start());
                      setNotice({
                        tone: "ok",
                        text: botLive ? "Restarting the bot." : "Starting the bot.",
                      });
                    }}
                  >
                    {botLive ? "Restart now" : "Start bot"}
                  </Button>
                )}
              </div>
            )}

            {content[section]}
            <div className="h-10" />
          </div>
        </ScrollArea>

        {changeCount > 0 && (
          <footer className="shrink-0 border-t bg-canvas/95 px-8 py-3 backdrop-blur @max-[36rem]/content:px-4">
            <div className="flex max-w-3xl flex-wrap items-center gap-2">
              <span className="text-sm font-medium">
                {changeCount} unsaved {changeCount === 1 ? "change" : "changes"}
              </span>
              {issues.length > 0 && (
                <button
                  type="button"
                  disabled={!issueSection || issueSection === section}
                  onClick={() => issueSection && go(issueSection)}
                  className="flex min-w-0 items-center gap-1 text-left text-xs text-status-failed enabled:hover:underline"
                >
                  <TriangleAlert className="size-3.5 shrink-0" />
                  <span className="truncate">
                    {offscreenIssues[0]?.message ??
                      `${issues.length} ${issues.length === 1 ? "issue" : "issues"} to fix`}
                    {issueSection && issueSection !== section
                      ? ` (${SECTION_INFO[issueSection].label})`
                      : ""}
                  </span>
                </button>
              )}
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
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
                    {botLive ? "Save and restart bot" : "Save and start bot"}
                  </Button>
                )}
              </div>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}

function NavItem({
  icon: Icon,
  label,
  active,
  changes,
  issues,
  hint,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  changes: number;
  issues: number;
  hint?: Hint;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      title={label}
      className={cn(
        "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 @max-[44rem]/settings:justify-center @max-[44rem]/settings:px-0",
        active
          ? "bg-card font-medium text-foreground shadow-xs"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      )}
    >
      <span className="relative shrink-0">
        <Icon className="size-4" strokeWidth={1.75} />
        {/* With the list as icons, a dot stands in for the issue, change count or state text. */}
        {(issues > 0 || changes > 0 || hint?.tone === "warn") && (
          <span
            className={cn(
              "absolute -top-0.5 -right-0.5 hidden size-1.5 rounded-full @max-[44rem]/settings:block",
              issues > 0
                ? "bg-status-failed"
                : changes > 0
                  ? "bg-primary"
                  : "bg-status-interrupted"
            )}
          />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate @max-[44rem]/settings:sr-only">
        {label}
      </span>
      <span className="contents @max-[44rem]/settings:hidden">
        {issues > 0 ? (
          <span
            className="size-1.5 shrink-0 rounded-full bg-status-failed"
            title={`${issues} ${issues === 1 ? "issue" : "issues"} to fix`}
          />
        ) : changes > 0 ? (
          <span
            className="shrink-0 rounded-full bg-primary/12 px-1.5 text-[10px] font-semibold text-primary tabular-nums"
            title={`${changes} unsaved ${changes === 1 ? "change" : "changes"}`}
          >
            {changes}
          </span>
        ) : hint ? (
          <span
            className={cn(
              "shrink-0 text-[11px] font-normal",
              hint.tone === "warn"
                ? "text-status-interrupted"
                : "text-muted-foreground/70"
            )}
          >
            {hint.text}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function SubHeading({
  title,
  help,
  chip,
}: {
  title: string;
  help?: string;
  chip?: React.ReactNode;
}) {
  return (
    <div className="px-1 pt-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        {title}
        {chip}
      </h3>
      {help && <p className="mt-0.5 text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

function CardHeader({
  title,
  help,
  chip,
  live,
  action,
}: {
  title: string;
  help?: React.ReactNode;
  chip?: React.ReactNode;
  live?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="flex items-start gap-3 border-b border-canvas px-4 py-3">
      <div className="min-w-0 flex-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          {title}
          {chip}
        </h3>
        {help && <p className="mt-0.5 text-xs text-muted-foreground">{help}</p>}
        {live && (
          <p className="mt-0.5 text-xs text-muted-foreground/80">
            Running broker: {live}
          </p>
        )}
      </div>
      {action}
    </header>
  );
}

/** One group of settings fields as a card: its basic fields, then the advanced ones folded away. */
function GroupCard({
  info,
  fields,
  row,
  help,
  chip,
  live,
  action,
  children,
  after,
}: {
  info: SettingGroupInfo;
  fields: SettingField[];
  row: (field: SettingField) => React.ReactNode;
  /** Replaces the group's own help text */
  help?: string;
  chip?: React.ReactNode;
  live?: string;
  action?: React.ReactNode;
  /** Shown under the header, before the fields */
  children?: React.ReactNode;
  /** Shown after the basic fields, before the advanced ones */
  after?: React.ReactNode;
}) {
  const basic = fields.filter((field) => !field.advanced);
  const advanced = fields.filter((field) => field.advanced);
  return (
    <section className="surface-card overflow-hidden">
      <CardHeader
        title={info.label}
        help={help ?? info.help}
        chip={chip}
        live={live}
        action={action}
      />
      {children}
      {basic.length > 0 && <div className="divide-y divide-canvas">{basic.map(row)}</div>}
      {after}
      {advanced.length > 0 && (
        <Advanced
          count={advanced.length}
          bordered={basic.length > 0 || Boolean(children)}
        >
          {advanced.map(row)}
        </Advanced>
      )}
    </section>
  );
}

const STATE_CHIP = {
  on: { label: "On", className: "bg-status-succeeded/12 text-status-succeeded" },
  partial: {
    label: "Incomplete",
    className: "bg-status-interrupted/12 text-status-interrupted",
  },
  off: { label: "Off", className: "bg-muted text-muted-foreground" },
};

const CHIP_TONE = {
  ok: "bg-status-succeeded/12 text-status-succeeded",
  warn: "bg-status-interrupted/12 text-status-interrupted",
};

function Chip({
  tone,
  children,
}: {
  tone: keyof typeof CHIP_TONE;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn("rounded px-1.5 text-[10px] leading-4 font-medium", CHIP_TONE[tone])}
    >
      {children}
    </span>
  );
}

function StateChip({ state, title }: { state: keyof typeof STATE_CHIP; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "rounded px-1.5 text-[10px] leading-4 font-medium",
        STATE_CHIP[state].className
      )}
    >
      {STATE_CHIP[state].label}
    </span>
  );
}

/** What the running broker reports for an integration, to compare with what is set here */
function brokerReport(
  id: SettingGroup,
  broker: BrokerHealth | undefined
): string | undefined {
  if (!broker) return undefined;
  const list = (items: string[]) => (items.length ? items.join(", ") : "off");
  switch (id) {
    case "files":
      return broker.fs ? "on" : "off";
    case "github":
      return broker.github.length
        ? `${broker.github.join(", ")}, pull requests ${broker.git ? "on" : "off"}`
        : "off";
    case "jira":
      return list(broker.jira);
    case "k8s":
      return list(broker.k8s);
    case "ssh":
      return broker.sshHosts
        ? `${broker.sshHosts} ${broker.sshHosts === 1 ? "host" : "hosts"}`
        : "off";
    default:
      return undefined;
  }
}

function credentialsHelp(reasoner: string): string {
  return reasoner === "codex"
    ? "The codex login passed into each sandbox container. Your own CLI login on this Mac is not used there."
    : "The claude login passed into each sandbox container. Your own CLI login on this Mac is not used there.";
}

/**
 * Gets the sandbox's claude token from the Claude subscription: the app runs claude setup-token, the user approves
 * in the browser, and the token is saved to .env in the main process (it never reaches this screen).
 */
function ClaudeTokenSetup({
  hasToken,
  onSaved,
}: {
  /** A token is already saved; the action then replaces it */
  hasToken: boolean;
  onSaved: () => void;
}) {
  const bridge = window.orblyDesktop?.sandbox;
  const [state, setState] = useState<
    { step: "idle" } | { step: "waiting" } | { step: "error"; message: string }
  >({ step: "idle" });
  // Leaving the screen stops a run that is still waiting for the browser.
  useEffect(() => () => void bridge?.cancelClaudeToken?.(), [bridge]);
  if (!bridge?.claudeToken) return null;

  const start = () => {
    setState({ step: "waiting" });
    void bridge.claudeToken().then((res) => {
      if (res.ok) {
        setState({ step: "idle" });
        onSaved();
      } else
        setState(
          res.error === "Cancelled."
            ? { step: "idle" }
            : { step: "error", message: res.error }
        );
    });
  };

  return (
    <div className="border-t border-canvas bg-well/60 px-4 py-3">
      {state.step === "waiting" ? (
        <div className="flex items-center gap-3">
          <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
          <p className="min-w-0 flex-1 text-sm">
            Approve in the browser window that opened. The token is saved here when Claude
            hands it over.
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void bridge.cancelClaudeToken()}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          {state.step === "error" && (
            <TriangleAlert className="size-4 shrink-0 text-status-failed" />
          )}
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "text-sm",
                state.step === "error" ? "text-status-failed" : "font-medium"
              )}
            >
              {state.step === "error"
                ? state.message
                : hasToken
                  ? "Replace the token with a new one from your Claude subscription"
                  : "Get the token from your Claude subscription"}
            </p>
            {state.step === "idle" && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                Runs claude setup-token: approve in the browser and the one-year token is
                saved here. Needs a Pro, Max, Team or Enterprise plan.
              </p>
            )}
          </div>
          <Button
            size="sm"
            variant={state.step === "error" ? "outline" : "default"}
            onClick={start}
          >
            <KeyRound />
            {state.step === "error"
              ? "Try again"
              : hasToken
                ? "Get new token"
                : "Get token from Claude"}
          </Button>
        </div>
      )}
    </div>
  );
}

type PairState =
  | { step: "idle"; note?: string }
  | { step: "starting" }
  | { step: "waiting"; code: string }
  | { step: "bound"; user: HubUser }
  | { step: "confirming"; user: HubUser }
  | { step: "error"; message: string };

/**
 * Pairs this desktop with the team hub: get a code, send "@orbly connect <code>" in Slack, then confirm the Slack
 * member who sent it. Confirming is what makes it count, so a code someone else saw and sent first is turned down here.
 */
function HubPairing({
  hubUrl,
  paired,
  onPaired,
  onDisconnected,
}: {
  hubUrl: string;
  paired: boolean;
  onPaired: (notice: string) => void;
  onDisconnected: () => void;
}) {
  const hub = window.orblyDesktop?.hub;
  const [state, setState] = useState<PairState>({ step: "idle" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state.step !== "waiting" || !hub) return;
    const timer = setInterval(() => {
      void hub.pairStatus().then((res) => {
        if ("error" in res) setState({ step: "error", message: res.error });
        else if (res.status === "bound") setState({ step: "bound", user: res.user });
        else if (res.status === "expired")
          setState({
            step: "error",
            message: "The code expired. Connect again for a new one.",
          });
      });
    }, 2_000);
    return () => clearInterval(timer);
  }, [state.step, hub]);
  // Leaving the screen cancels a pairing that was not confirmed.
  useEffect(() => () => void hub?.pairCancel(), [hub]);

  if (!hub) return null;
  const start = () => {
    setState({ step: "starting" });
    void hub
      .pairStart(hubUrl)
      .then((res) =>
        setState(
          "error" in res
            ? { step: "error", message: res.error }
            : { step: "waiting", code: res.code }
        )
      );
  };
  const cancel = (note?: string) => {
    void hub.pairCancel();
    setState({ step: "idle", note });
  };
  const confirm = (user: HubUser) => {
    setState({ step: "confirming", user });
    void hub.pairConfirm().then((res) => {
      if ("error" in res) return setState({ step: "error", message: res.error });
      if (res.issues.length > 0)
        return setState({
          step: "error",
          message: res.issues.map((i) => i.message).join(" "),
        });
      setState({ step: "idle" });
      onPaired(
        `Paired with the hub as ${res.user.name} @ ${res.team.name}.${res.started ? " Started the bot." : ""}`
      );
    });
  };
  const disconnect = () => {
    setBusy(true);
    void hub
      .disconnect()
      .then((res) => {
        if ("error" in res) setState({ step: "error", message: res.error });
        else onDisconnected();
      })
      .finally(() => setBusy(false));
  };

  const body = (() => {
    switch (state.step) {
      case "idle":
        return paired ? (
          <div className="flex items-center gap-3">
            <CircleCheck className="size-4 shrink-0 text-status-succeeded" />
            <p className="min-w-0 flex-1 text-sm">
              This desktop is paired with the hub. Use Check connection to see as whom.
            </p>
            <Button size="sm" variant="outline" onClick={disconnect} disabled={busy}>
              {busy && <LoaderCircle className="animate-spin" />}
              Disconnect
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Pair this desktop</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {state.note ??
                  "You get a code to send to Orbly in Slack. Mentions you make then come to this desktop."}
              </p>
            </div>
            <Button size="sm" onClick={start} disabled={!hubUrl}>
              <Plug />
              Connect
            </Button>
          </div>
        );
      case "starting":
        return (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            Getting a code from the hub
          </p>
        );
      case "waiting":
        return (
          <div className="space-y-2.5">
            <p className="text-sm">
              In Slack, mention Orbly with this code in any channel it is in:
            </p>
            <div className="flex items-center gap-3">
              <code className="rounded-lg bg-card px-3 py-2 font-mono text-base font-semibold tracking-wide shadow-xs select-all">
                @orbly connect {state.code}
              </code>
              <Button size="sm" variant="ghost" onClick={() => cancel()}>
                Cancel
              </Button>
            </div>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" />
              Waiting for the code. It expires in 10 minutes.
            </p>
          </div>
        );
      case "bound":
      case "confirming":
        return (
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 text-sm">
              <b>{state.user.name}</b>{" "}
              <span className="font-mono text-xs text-muted-foreground">
                ({state.user.id})
              </span>{" "}
              sent the code. Is this your Slack account?
            </p>
            <Button
              size="sm"
              variant="ghost"
              disabled={state.step === "confirming"}
              onClick={() =>
                cancel(
                  "Cancelled. If someone else sent your code, connect again to get a new one."
                )
              }
            >
              No
            </Button>
            <Button
              size="sm"
              disabled={state.step === "confirming"}
              onClick={() => confirm(state.user)}
            >
              {state.step === "confirming" && <LoaderCircle className="animate-spin" />}
              Yes, pair
            </Button>
          </div>
        );
      case "error":
        return (
          <div className="flex items-center gap-3">
            <TriangleAlert className="size-4 shrink-0 text-status-failed" />
            <p className="min-w-0 flex-1 text-sm text-status-failed">{state.message}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setState({ step: "idle" })}
            >
              Try again
            </Button>
          </div>
        );
    }
  })();
  return <div className="border-t border-canvas bg-well/60 px-4 py-3">{body}</div>;
}

/** Conditions a feature needs, each with a way to the section that fixes it */
function Requirements({
  items,
  onOpen,
}: {
  items: {
    ok: boolean;
    label: string;
    detail: string;
    action?: { label: string; section: Section };
  }[];
  onOpen: (section: Section) => void;
}) {
  return (
    <ul className="space-y-1.5 border-t border-canvas bg-well/60 px-4 py-2.5">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-2 text-xs">
          {item.ok ? (
            <CircleCheck className="size-3.5 shrink-0 text-status-succeeded" />
          ) : (
            <CircleX className="size-3.5 shrink-0 text-status-interrupted" />
          )}
          <span className="w-28 shrink-0 font-medium">{item.label}</span>
          <span className="min-w-0 flex-1 text-muted-foreground select-text">
            {item.detail}
          </span>
          {item.action && (
            <Button
              size="xs"
              variant="outline"
              onClick={() => onOpen(item.action!.section)}
            >
              {item.action.label}
              <ChevronRight />
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function PathControl({
  path,
  label,
  onOpen,
}: {
  path: string;
  label: string;
  onOpen: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {/* A long path is cut short here; hover shows it whole. */}
      <span
        title={path}
        className="max-w-64 truncate font-mono text-xs text-muted-foreground select-text"
      >
        {path}
      </span>
      <Button variant="ghost" size="xs" onClick={onOpen}>
        <FolderOpen />
        {label}
      </Button>
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
  onChange,
  onEdit,
  onSave,
  saving,
}: {
  field: SettingField;
  view: SettingsView;
  value: string;
  changed: boolean;
  editing: boolean;
  issue?: string;
  onChange: (value: string) => void;
  onEdit: (on: boolean) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const overridden = view.overridden.includes(field.key);
  const label = (
    <span className="flex items-center gap-1.5">
      {field.label}
      {changed && (
        <span className="size-1.5 rounded-full bg-primary" aria-label="Changed" />
      )}
    </span>
  );
  const warning = overridden
    ? "This variable is set in the app environment and takes precedence over the settings file."
    : undefined;
  // Options that explain themselves are laid out as cards. The card's title names the choice, and the
  // variable stays visible below for editing the settings file by hand.
  if (field.type === "select" && field.options?.some((option) => option.help)) {
    return (
      <div className="px-4 py-3">
        <Choice field={field} value={value} onChange={onChange} />
        <div className="mt-2 flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground/80">
          <span className="select-text">{field.key}</span>
          {changed && (
            <span className="size-1.5 rounded-full bg-primary" aria-label="Changed" />
          )}
        </div>
        <RowNotes warning={warning} issue={issue} />
      </div>
    );
  }
  return (
    <Row label={label} sub={field.key} help={field.help} issue={issue} warning={warning}>
      <Control
        field={field}
        view={view}
        value={value}
        editing={editing}
        onChange={onChange}
        onEdit={onEdit}
        onSave={onSave}
        saving={saving}
      />
    </Row>
  );
}

function Choice({
  field,
  value,
  onChange,
}: {
  field: SettingField;
  value: string;
  onChange: (value: string) => void;
}) {
  const selected = value || field.default || "";
  return (
    <div
      role="radiogroup"
      aria-label={field.label}
      className="grid grid-cols-2 gap-2 @max-[36rem]/content:grid-cols-1"
    >
      {field.options?.map((option) => {
        const checked = option.value === selected;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-xl border px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
              checked
                ? "border-primary/50 bg-primary/6"
                : "border-border hover:border-primary/30 hover:bg-muted/40"
            )}
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <span
                className={cn(
                  "grid size-3.5 shrink-0 place-items-center rounded-full border",
                  checked ? "border-primary" : "border-muted-foreground/40"
                )}
              >
                {checked && <span className="size-1.5 rounded-full bg-primary" />}
              </span>
              {option.label}
            </span>
            {option.help && (
              <span className="mt-1 block text-xs text-muted-foreground">
                {option.help}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function Control({
  field,
  view,
  value,
  editing,
  onChange,
  onEdit,
  onSave,
  saving,
}: {
  field: SettingField;
  view: SettingsView;
  value: string;
  editing: boolean;
  onChange: (value: string) => void;
  onEdit: (on: boolean) => void;
  /** Saves just this secret (Enter); Escape cancels */
  onSave: () => void;
  saving: boolean;
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
        <div className="flex w-80 max-w-full items-center gap-1.5">
          <Input
            type="password"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={value}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && value.trim() && !saving) {
                e.preventDefault();
                onSave();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onEdit(false);
              }
            }}
            className="h-7 font-mono text-xs"
          />
          <Button size="xs" onClick={onSave} disabled={!value.trim() || saving}>
            Save
          </Button>
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
            field.placeholder ?? (field.default ? `Default ${field.default}` : "Not set")
          }
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "h-7 text-xs",
            field.type === "number" ? "w-32 text-right tabular-nums" : "w-72 max-w-full"
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
    <div
      data-setting={sub}
      className="flex items-start gap-4 px-4 py-3 @max-[36rem]/content:flex-col @max-[36rem]/content:gap-2"
    >
      <div className="min-w-0 flex-1 @max-[36rem]/content:w-full">
        <div className="text-sm font-medium">{label}</div>
        {sub && (
          <div className="font-mono text-[10.5px] text-muted-foreground/80 select-text">
            {sub}
          </div>
        )}
        {help && <p className="mt-0.5 text-xs text-muted-foreground">{help}</p>}
        <RowNotes warning={warning} issue={issue} />
      </div>
      <div className="flex min-h-7 max-w-full shrink-0 items-center">{children}</div>
    </div>
  );
}

function RowNotes({ warning, issue }: { warning?: string; issue?: string }) {
  return (
    <>
      {warning && (
        <p className="mt-1 flex items-center gap-1 text-xs text-status-interrupted">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="select-text">{warning}</span>
        </p>
      )}
      {issue && <p className="mt-1 text-xs text-status-failed select-text">{issue}</p>}
    </>
  );
}

const THEMES: { mode: ThemeMode; label: string; icon: typeof Monitor }[] = [
  { mode: "system", label: "System", icon: Monitor },
  { mode: "light", label: "Light", icon: Sun },
  { mode: "dark", label: "Dark", icon: Moon },
];

/** System / Light / Dark, as a segmented control like the run list's status filter. */
function ThemePicker() {
  const { mode, setMode } = useTheme();
  return (
    <div role="radiogroup" aria-label="Theme" className="flex rounded-lg bg-muted p-0.5">
      {THEMES.map(({ mode: value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={mode === value}
          onClick={() => setMode(value)}
          className={cn(
            "flex h-6 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none",
            mode === value
              ? "bg-card text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <Icon className="size-3.5" />
          {label}
        </button>
      ))}
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

function Advanced({
  count,
  bordered,
  children,
}: {
  count: number;
  /** Separates the toggle from rows above it */
  bordered: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(bordered && "border-t border-canvas")}
    >
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
          <span className="text-muted-foreground select-text">{item.detail}</span>
        </li>
      ))}
    </ul>
  );
}
