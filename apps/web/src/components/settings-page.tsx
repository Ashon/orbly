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
 * 설정 파일(~/.verda/.env)을 고치는 설정 화면. 데스크톱 앱에서만 쓸 수 있다.
 * draft 는 화면에서 바꾼 값이다. 빈 문자열은 기본값으로 되돌림을 뜻한다.
 */
export function SettingsPage() {
  const settings = bridge();
  const supervisor = useSupervisor();
  const sandbox = useSandbox();
  // #/settings/sandbox 로 열면 샌드박스 탭
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

  // 실제로 바뀐 값만 보낸다. 비밀 값은 새로 입력했을 때만 보낸다.
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
        설정은 데스크톱 앱에서 바꿀 수 있습니다.
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
          ? ` broker 설정은 "${APPLY_LABEL.broker}" 로 적용합니다.`
          : "";
        setNotice(
          restarted || !botChanged
            ? {
                tone: brokerChanged ? "warn" : "ok",
                text: `${restarted ? "저장하고 봇을 다시 시작했습니다." : "저장했습니다."}${brokerNote}`,
              }
            : {
                tone: "warn",
                text: `저장했습니다. 봇을 다시 시작해야 적용됩니다.${brokerNote}`,
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
            <h1 className="text-lg font-semibold tracking-tight">설정</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              봇은 저장소 밖의 설정 파일(아래 경로)을 읽습니다. 앱과 터미널 실행이 같은
              파일을 씁니다. 저장하면 봇을 다시 시작해야 적용됩니다.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="font-mono">{view.envFile}</span>
              {!view.exists && (
                <span className="text-status-interrupted">
                  (아직 없음, 저장하면 만듭니다)
                </span>
              )}
              <Button variant="ghost" size="xs" onClick={() => void settings.revealEnv()}>
                <FolderOpen />
                Finder 에서 보기
              </Button>
            </div>
          </div>

          <Tabs value={tab} onValueChange={(value) => setTab(value as SettingTab)}>
            <TabsList>
              <TabsTrigger value="bot">봇</TabsTrigger>
              <TabsTrigger value="sandbox">샌드박스</TabsTrigger>
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
                    setNotice({ tone: "ok", text: "봇을 다시 시작합니다." });
                  }}
                >
                  지금 재시작
                </Button>
              )}
            </div>
          )}

          {tab === "sandbox" &&
            (sandbox.available ? (
              <>
                <p className="text-xs text-muted-foreground">
                  실행 환경은 지금 <b>{view.values.REASONER_SANDBOX || "none"}</b> 입니다.
                  {(view.values.REASONER_SANDBOX || "none") !== "docker" &&
                    " 샌드박스 설정은 실행 환경이 docker 일 때 쓰입니다."}{" "}
                  (봇 탭의 추론 영역에서 바꿉니다)
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
              <section key={group.id} className="overflow-hidden rounded-xl bg-card">
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
                      연결 확인
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
            className={cn(
              "overflow-hidden rounded-xl bg-card",
              tab !== "bot" && "hidden"
            )}
          >
            <header className="border-b border-canvas px-4 py-3">
              <h2 className="text-sm font-semibold">앱</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                데스크톱 앱 설정은 .env 가 아니라 기록 폴더에 저장됩니다.
              </p>
            </header>
            <div className="divide-y divide-canvas">
              {supervisor && (
                <Row
                  label="앱을 열면 봇 자동 시작"
                  help="꺼 두면 봇 화면이나 메뉴 막대(트레이)에서 직접 시작합니다."
                >
                  <Switch
                    checked={supervisor.autoStart}
                    onChange={(value) => void botControl()?.setAutoStart(value)}
                  />
                </Row>
              )}
              <Row
                label="기록 위치"
                help="VERDA_DATA_DIR. 바꾸려면 설정 파일(.env)을 고치고 앱을 다시 실행합니다."
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
                    열기
                  </Button>
                </div>
              </Row>
              {view.otherKeys.length > 0 && (
                <Row
                  label="그 밖의 .env 항목"
                  help="설정 화면에서 다루지 않는 항목입니다. 저장해도 그대로 남습니다."
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
            <span className="text-sm font-medium">변경 {changeCount}개</span>
            {issues.length > 0 && (
              <span className="flex items-center gap-1 text-xs text-status-failed">
                <TriangleAlert className="size-3.5 shrink-0" />
                {generalIssues[0]?.message ?? `확인할 항목 ${issues.length}개`}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <Button variant="ghost" size="sm" onClick={reset} disabled={saving}>
                <RotateCcw />
                되돌리기
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => save(false)}
                disabled={saving || issues.length > 0}
              >
                <Save />
                저장
              </Button>
              {canRestart && (
                <Button
                  size="sm"
                  onClick={() => save(true)}
                  disabled={saving || issues.length > 0}
                >
                  {saving ? <LoaderCircle className="animate-spin" /> : <Save />}
                  저장 후 봇 재시작
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
  /** 바꾸면 무엇을 다시 적용해야 하는지 보여 준다. */
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
            <span className="size-1.5 rounded-full bg-primary" aria-label="변경됨" />
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
              적용: {APPLY_LABEL[field.applies ?? "bot"]}
            </span>
          )}
        </span>
      }
      sub={field.key}
      help={field.help}
      issue={issue}
      warning={
        overridden ? "앱의 환경 변수에 같은 값이 있어 .env 보다 우선합니다." : undefined
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
              {secret?.set ? secret.hint : "설정 안 됨"}
            </span>
            <Button size="xs" variant="outline" onClick={() => onEdit(true)}>
              {secret?.set ? "변경" : "입력"}
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
            취소
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
            (field.default ? `기본값 ${field.default}` : "비우면 사용 안 함")
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
        고급 설정 {count}개
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
