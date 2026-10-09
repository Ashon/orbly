import { chmodSync, copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ProcessExitError, runProcess } from "../reasoner/process.js";
import { CHECK_NAMES, CHECKS, buildCheckCommand, type CheckName } from "./checks.js";
import {
  filterRgOutput,
  listDir,
  MAX_READ_LINES,
  readText,
  resolveInRoot,
  rgFilterArgs,
} from "./fs.js";
import { GitWorkspaces } from "./git.js";
import { GitHubReader } from "./github.js";
import { loadHostMap } from "./hosts.js";
import { JiraClient } from "./jira.js";
import {
  describeArgs,
  eventsArgs,
  getArgs,
  logsArgs,
  MAX_LOG_LINES,
  topArgs,
} from "./k8s.js";
import { redactSecrets } from "./redact.js";

/**
 * 운영 점검 중계(ops-broker). 샌드박스 내부 네트워크에서만 접근되는 MCP(Streamable HTTP) 서버다.
 * SSH 키, kubeconfig, 작업 디렉터리는 이 컨테이너에만 있고, 추론 컨테이너는 정해진 조회만 요청한다.
 * - host_*: 인벤토리 호스트 읽기 전용 점검 (SSH)
 * - k8s_*: 조회 전용 ServiceAccount 로 kubectl 조회
 * - fs_*: 작업 디렉터리 읽기 전용 탐색 (비밀 파일 제외)
 * - ws_*: 원격 기본 브랜치에서 만든 별도 작업 공간에서 코드 수정, draft PR 생성
 * - gh_*: 허용된 조직의 GitHub 저장소, PR 읽기 전용 조회 (토큰은 이 컨테이너에만 있다)
 * - jira_*: 허용된 프로젝트의 Jira 이슈 조회, 요청 시 이슈 생성과 댓글 (토큰은 이 컨테이너에만 있다)
 * 설정이 비어 있거나 마운트한 파일이 비어 있는 기능은 도구를 등록하지 않는다.
 */
const Env = z.object({
  BROKER_PORT: z.coerce.number().int().positive().default(8080),
  HOSTS_FILE: z.string().default("/etc/ops/hosts.json"),
  SSH_KEY_FILE: z.string().default("/run/secrets/ssh-key"),
  KNOWN_HOSTS_FILE: z.string().default("/run/secrets/known_hosts"),
  SSH_USER: z.string().default(""),
  ALLOWED_CIDR: z.string().default(""),
  KUBECONFIG_FILE: z.string().default("/run/secrets/kubeconfig"),
  FS_ROOT: z.string().default("/workspace"),
  WORK_ROOT: z.string().default("/work"),
  GH_TOKEN: z.string().optional(),
  GIT_AUTHOR_NAME: z.string().optional(),
  GIT_AUTHOR_EMAIL: z.string().optional(),
  GIT_ALLOWED_OWNERS: z.string().default(""),
  GIT_TIMEOUT_SEC: z.coerce.number().int().positive().default(300),
  JIRA_URL: z.string().default(""),
  JIRA_EMAIL: z.string().default(""),
  JIRA_TOKEN: z.string().optional(),
  JIRA_PROJECTS: z.string().default(""),
  COMMAND_TIMEOUT_SEC: z.coerce.number().int().positive().default(30),
  OUTPUT_LIMIT: z.coerce.number().int().positive().default(24_000),
  MAX_CONCURRENT: z.coerce.number().int().positive().default(4),
});
const env = Env.parse(process.env);

const SSH_DIR = "/tmp/ssh";
const KEY = `${SSH_DIR}/id`;
const KNOWN_HOSTS = `${SSH_DIR}/known_hosts`;

function audit(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

// ------------------------------------------------------------------ 기능별 준비

/** 설정하지 않은 마운트는 빈 파일이나 빈 디렉터리로 들어온다. */
function nonEmptyFile(file: string): boolean {
  try {
    const stat = statSync(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function nonEmptyDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

const sshEnabled =
  Boolean(env.SSH_USER && env.ALLOWED_CIDR) &&
  nonEmptyFile(env.HOSTS_FILE) &&
  nonEmptyFile(env.SSH_KEY_FILE);
const hosts = sshEnabled
  ? loadHostMap(env.HOSTS_FILE, env.ALLOWED_CIDR)
  : new Map<string, string>();
if (hosts.size > 0) {
  // 마운트된 키는 소유자/권한이 맞지 않을 수 있어 tmpfs 로 복사하고 600 으로 둔다.
  mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
  copyFileSync(env.SSH_KEY_FILE, KEY);
  chmodSync(KEY, 0o600);
  if (nonEmptyFile(env.KNOWN_HOSTS_FILE)) copyFileSync(env.KNOWN_HOSTS_FILE, KNOWN_HOSTS);
}

const k8sEnabled = nonEmptyFile(env.KUBECONFIG_FILE);
let clusters: string[] = [];
const fsEnabled = nonEmptyDir(env.FS_ROOT);
/** PR 생성(ws_*)과 GitHub 조회(gh_*)가 함께 쓰는 허용 조직 */
const allowedOwners = env.GIT_ALLOWED_OWNERS.split(",")
  .map((owner) => owner.trim())
  .filter(Boolean);

const git =
  fsEnabled &&
  allowedOwners.length > 0 &&
  env.GH_TOKEN &&
  env.GIT_AUTHOR_NAME &&
  env.GIT_AUTHOR_EMAIL
    ? new GitWorkspaces({
        localRoot: env.FS_ROOT,
        workRoot: env.WORK_ROOT,
        token: env.GH_TOKEN,
        authorName: env.GIT_AUTHOR_NAME,
        authorEmail: env.GIT_AUTHOR_EMAIL,
        allowedOwners,
        timeoutMs: env.GIT_TIMEOUT_SEC * 1000,
      })
    : undefined;

const github =
  env.GH_TOKEN && allowedOwners.length > 0
    ? new GitHubReader({ token: env.GH_TOKEN, allowedOwners })
    : undefined;

const jiraProjects = env.JIRA_PROJECTS.split(",")
  .map((project) => project.trim().toUpperCase())
  .filter(Boolean);
const jira =
  env.JIRA_URL && env.JIRA_EMAIL && env.JIRA_TOKEN && jiraProjects.length > 0
    ? new JiraClient({
        baseUrl: env.JIRA_URL,
        email: env.JIRA_EMAIL,
        token: env.JIRA_TOKEN,
        projects: jiraProjects,
      })
    : undefined;

// ------------------------------------------------------------------ 실행 공통

let running = 0;

/**
 * 외부 명령(ssh, kubectl, rg)의 환경 변수. broker 환경에는 GH_TOKEN, JIRA_TOKEN 같은 자격 증명이
 * 있으므로 물려주지 않는다.
 */
const TOOL_ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: "/tmp" };

/** 외부 명령을 실행한다. 0 이 아닌 종료도 결과로 돌려주고, 출력은 비밀 값을 가리고 자른다. */
async function exec(
  tool: string,
  command: string,
  args: string[],
  meta: Record<string, unknown>
): Promise<string> {
  if (running >= env.MAX_CONCURRENT)
    throw new Error("동시 요청이 많습니다. 잠시 후 다시 시도하세요.");
  running += 1;
  const started = Date.now();
  let exitCode: number | null = 0;
  let output: string;
  try {
    const result = await runProcess(command, args, {
      cwd: "/tmp",
      input: "",
      timeoutMs: env.COMMAND_TIMEOUT_SEC * 1000,
      env: TOOL_ENV,
    });
    output = result.stdout + result.stderr;
  } catch (err) {
    if (!(err instanceof ProcessExitError)) {
      audit({ tool, ...meta, error: (err as Error).message });
      throw err;
    }
    exitCode = err.code;
    output = err.stdout + err.stderr;
  } finally {
    running -= 1;
  }
  const ms = Date.now() - started;
  audit({ tool, ...meta, exit: exitCode, ms, bytes: output.length });
  return `(exit ${exitCode}, ${ms}ms)\n${finish(output)}`;
}

function finish(output: string): string {
  const clean = redactSecrets(output);
  return clean.length > env.OUTPUT_LIMIT
    ? `${clean.slice(0, env.OUTPUT_LIMIT)}\n... (출력 ${clean.length}자 중 앞부분만)`
    : clean;
}

const kubectl = (tool: string, args: string[], meta: Record<string, unknown>) =>
  exec(tool, "kubectl", ["--kubeconfig", env.KUBECONFIG_FILE, ...args], meta);

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
async function respond(run: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: await run() }] };
  } catch (err) {
    return { content: [{ type: "text", text: (err as Error).message }], isError: true };
  }
}
const readOnly = { readOnlyHint: true, openWorldHint: false };

// ------------------------------------------------------------------ 도구 등록

function registerHostTools(server: McpServer): void {
  server.registerTool(
    "host_list",
    {
      description:
        "점검할 수 있는 호스트 이름과 주소 목록 (인벤토리에서 허용 대역 안의 호스트만)",
      annotations: readOnly,
    },
    async () =>
      respond(
        async () => [...hosts].map(([name, ip]) => `${name} ${ip}`).join("\n") || "(없음)"
      )
  );

  server.registerTool(
    "host_check",
    {
      description: [
        "호스트에 SSH 로 정해진 읽기 전용 점검을 실행한다. 임의 명령은 실행할 수 없다.",
        "check 종류:",
        ...CHECK_NAMES.map((name) => `- ${name}: ${CHECKS[name].description}`),
      ].join("\n"),
      inputSchema: {
        host: z.string().describe("호스트 이름 (host_list 의 이름, 예: web-01)"),
        check: z.enum(CHECK_NAMES).describe("점검 종류"),
        lines: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("dmesg/journal 줄 수"),
        unit: z.string().optional().describe("service/journal 의 systemd 유닛 이름"),
        vendor: z
          .string()
          .optional()
          .describe("pci_devices 의 PCI 벤더 ID (16진수 4자리, 예: 10de)"),
      },
      annotations: readOnly,
    },
    async ({ host, check, lines, unit, vendor }) =>
      respond(async () => {
        const ip = hosts.get(host);
        if (!ip)
          throw new Error(`허용된 호스트가 아닙니다: ${host} (host_list 로 목록 확인)`);
        const command = buildCheckCommand(check as CheckName, { lines, unit, vendor });
        const sshArgs = [
          "-F",
          "/dev/null",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=8",
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          `UserKnownHostsFile=${KNOWN_HOSTS}`,
          "-i",
          KEY,
          "-l",
          env.SSH_USER,
          ip,
          command,
        ];
        const result = await exec("host_check", "ssh", sshArgs, {
          host,
          ip,
          check,
          lines,
          unit,
          vendor,
        });
        return `$ ${command}  (host ${host})\n${result}`;
      })
  );
}

function registerK8sTools(server: McpServer): void {
  const cluster = z.string().describe(`클러스터 컨텍스트 (${clusters.join(", ")})`);
  const ns = z.string().optional().describe("네임스페이스");

  server.registerTool(
    "k8s_get",
    {
      description:
        "kubectl get 으로 리소스를 조회한다. 조회 전용 권한이며 secrets 는 볼 수 없다. 기본 출력은 wide.",
      inputSchema: {
        cluster,
        kind: z.string().describe("리소스 종류 (예: pods, nodes, deployments, services)"),
        namespace: ns,
        name: z.string().optional().describe("리소스 이름"),
        selector: z.string().optional().describe("라벨 셀렉터 (예: app=nginx)"),
        all_namespaces: z.boolean().optional().describe("모든 네임스페이스"),
        output: z.enum(["wide", "yaml"]).optional(),
      },
      annotations: readOnly,
    },
    async (a) =>
      respond(() =>
        kubectl(
          "k8s_get",
          getArgs(
            {
              cluster: a.cluster,
              kind: a.kind,
              namespace: a.namespace,
              name: a.name,
              selector: a.selector,
              allNamespaces: a.all_namespaces,
              output: a.output,
            },
            clusters
          ),
          { cluster: a.cluster, kind: a.kind, namespace: a.namespace, name: a.name }
        )
      )
  );

  server.registerTool(
    "k8s_describe",
    {
      description: "kubectl describe 로 리소스 상세와 최근 이벤트를 본다.",
      inputSchema: { cluster, kind: z.string(), name: z.string(), namespace: ns },
      annotations: readOnly,
    },
    async (a) =>
      respond(() =>
        kubectl("k8s_describe", describeArgs(a, clusters), {
          cluster: a.cluster,
          kind: a.kind,
          namespace: a.namespace,
          name: a.name,
        })
      )
  );

  server.registerTool(
    "k8s_logs",
    {
      description: `파드 로그 마지막 N줄 (기본 200, 최대 ${MAX_LOG_LINES}).`,
      inputSchema: {
        cluster,
        namespace: z.string(),
        pod: z.string(),
        container: z.string().optional(),
        tail: z.number().int().min(1).max(MAX_LOG_LINES).optional(),
        since: z.string().optional().describe("예: 30m, 2h"),
        previous: z.boolean().optional().describe("직전에 종료된 컨테이너 로그"),
      },
      annotations: readOnly,
    },
    async (a) =>
      respond(() =>
        kubectl("k8s_logs", logsArgs(a, clusters), {
          cluster: a.cluster,
          namespace: a.namespace,
          pod: a.pod,
          container: a.container,
          tail: a.tail,
        })
      )
  );

  server.registerTool(
    "k8s_events",
    {
      description: "이벤트를 시간순으로 본다. namespace 를 생략하면 전체.",
      inputSchema: { cluster, namespace: ns },
      annotations: readOnly,
    },
    async (a) =>
      respond(() =>
        kubectl("k8s_events", eventsArgs(a, clusters), {
          cluster: a.cluster,
          namespace: a.namespace,
        })
      )
  );

  server.registerTool(
    "k8s_top",
    {
      description: "노드 또는 파드의 CPU/메모리 사용량 (metrics-server).",
      inputSchema: { cluster, target: z.enum(["nodes", "pods"]), namespace: ns },
      annotations: readOnly,
    },
    async (a) =>
      respond(() =>
        kubectl("k8s_top", topArgs(a, clusters), {
          cluster: a.cluster,
          target: a.target,
          namespace: a.namespace,
        })
      )
  );
}

/** 전체 루트 검색은 마운트 위에서 너무 느려서, 최소 저장소 단위로 좁혀서 받는다. */
function requireScope(requested: string): string {
  const scoped = requested
    .trim()
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "");
  if (!scoped || scoped === ".") {
    throw new Error(
      "path 를 저장소 이상으로 좁혀서 지정하세요. (예: my-repo, my-repo/docs)"
    );
  }
  return scoped;
}

function registerFsTools(server: McpServer): void {
  const root = env.FS_ROOT;
  const rel = z.string().describe("작업 루트 기준 상대 경로 (예: my-repo/docs)");

  server.registerTool(
    "fs_list",
    {
      description:
        "작업 디렉터리의 목록을 본다. 최상위는 저장소 디렉터리들이다. 읽기 전용이며 비밀 파일은 보이지 않는다.",
      inputSchema: { path: rel.optional() },
      annotations: readOnly,
    },
    async ({ path }) =>
      respond(async () => {
        audit({ tool: "fs_list", path });
        return listDir(root, path ?? ".");
      })
  );

  server.registerTool(
    "fs_read",
    {
      description: `텍스트 파일을 줄 번호와 함께 읽는다. 한 번에 최대 ${MAX_READ_LINES}줄.`,
      inputSchema: {
        path: rel,
        offset: z.number().int().min(1).optional().describe("시작 줄 (1부터)"),
        limit: z.number().int().min(1).max(MAX_READ_LINES).optional(),
      },
      annotations: readOnly,
    },
    async ({ path, offset, limit }) =>
      respond(async () => {
        audit({ tool: "fs_read", path, offset, limit });
        return finish(await readText(root, path, offset, limit));
      })
  );

  server.registerTool(
    "fs_search",
    {
      description:
        "ripgrep 으로 파일 내용을 검색한다. .gitignore 와 비밀 파일 제외 규칙을 따른다. 결과는 최대 200줄.",
      inputSchema: {
        pattern: z.string().min(1).max(200).describe("정규식 (ripgrep 문법)"),
        path: rel.describe("검색할 하위 경로 (저장소 이상, 예: my-repo)"),
        glob: z.string().max(100).optional().describe("파일 이름 필터 (예: *.yaml)"),
        fixed_strings: z.boolean().optional().describe("정규식이 아닌 문자열로 검색"),
      },
      annotations: readOnly,
    },
    async ({ pattern, path, glob, fixed_strings }) =>
      respond(async () => {
        const target = await resolveInRoot(root, requireScope(path));
        const args = [
          "--line-number",
          "--no-heading",
          "--null",
          "--color",
          "never",
          "--max-count",
          "20",
        ];
        args.push("--max-filesize", "1M", "--max-columns", "300");
        args.push(...rgFilterArgs(glob));
        if (fixed_strings) args.push("--fixed-strings");
        args.push("--", pattern, target);
        const output = await exec("fs_search", "rg", args, { pattern, path, glob });
        const lines = filterRgOutput(output, root).split("\n");
        const shown = lines.slice(0, 201).join("\n");
        return lines.length > 201
          ? `${shown}\n... (${lines.length - 201}줄 더, path/glob 으로 좁히세요)`
          : shown;
      })
  );

  server.registerTool(
    "fs_find",
    {
      description: "파일 이름 glob 으로 파일을 찾는다. (예: **/*.yaml)",
      inputSchema: {
        glob: z.string().min(1).max(100),
        path: rel.describe("찾을 하위 경로 (저장소 이상)"),
      },
      annotations: readOnly,
    },
    async ({ glob, path }) =>
      respond(async () => {
        const target = await resolveInRoot(root, requireScope(path));
        const args = ["--files", "--color", "never", ...rgFilterArgs(glob), target];
        const output = await exec("fs_find", "rg", args, { glob, path });
        const lines = filterRgOutput(output, root).split("\n");
        return lines.length > 201
          ? `${lines.slice(0, 201).join("\n")}\n... (${lines.length - 201}개 더)`
          : lines.join("\n");
      })
  );
}

function registerWorkspaceTools(server: McpServer, workspaces: GitWorkspaces): void {
  const ws = z.string().describe("ws_prepare 가 돌려준 작업 공간 id");
  const file = z.string().describe("작업 공간 기준 상대 경로");
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const logged = (
    tool: string,
    meta: Record<string, unknown>,
    run: () => Promise<string>
  ) =>
    respond(async () => {
      const started = Date.now();
      try {
        const result = await run();
        audit({ tool, ...meta, ms: Date.now() - started });
        return result;
      } catch (err) {
        audit({ tool, ...meta, error: (err as Error).message.slice(0, 300) });
        throw err;
      }
    });

  server.registerTool(
    "ws_prepare",
    {
      description: [
        "코드 수정용 작업 공간을 만든다. 로컬 저장소 이름(fs_list 의 최상위 디렉터리)으로 GitHub 원격을 찾아,",
        "원격 기본 브랜치(또는 base)에서 새 verda/ 브랜치를 만든다. 사용자의 로컬 작업 트리는 바뀌지 않는다.",
      ].join(" "),
      inputSchema: {
        repo: z.string().describe("로컬 저장소 디렉터리 이름 (예: my-repo)"),
        base: z.string().optional().describe("기준 브랜치. 생략하면 원격 기본 브랜치"),
      },
      annotations: { ...write, openWorldHint: true },
    },
    async ({ repo, base }) =>
      logged("ws_prepare", { repo, base }, async () => {
        const w = await workspaces.prepare(repo, base);
        return `ws=${w.id} repo=${w.slug.owner}/${w.slug.repo} branch=${w.branch} base=${w.base}`;
      })
  );

  server.registerTool(
    "ws_list",
    {
      description: "작업 공간의 디렉터리 목록",
      inputSchema: { ws, path: file.optional() },
      annotations: readOnly,
    },
    async (a) =>
      logged("ws_list", a, () => listDir(workspaces.get(a.ws).dir, a.path ?? "."))
  );

  server.registerTool(
    "ws_read",
    {
      description: `작업 공간의 파일을 줄 번호와 함께 읽는다. 한 번에 최대 ${MAX_READ_LINES}줄.`,
      inputSchema: {
        ws,
        path: file,
        offset: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(MAX_READ_LINES).optional(),
      },
      annotations: readOnly,
    },
    async (a) =>
      logged("ws_read", { ws: a.ws, path: a.path }, async () =>
        finish(await readText(workspaces.get(a.ws).dir, a.path, a.offset, a.limit))
      )
  );

  server.registerTool(
    "ws_search",
    {
      description: "작업 공간에서 ripgrep 으로 내용을 검색한다.",
      inputSchema: {
        ws,
        pattern: z.string().min(1).max(200),
        path: file.optional(),
        glob: z.string().max(100).optional(),
        fixed_strings: z.boolean().optional(),
      },
      annotations: readOnly,
    },
    async (a) =>
      respond(async () => {
        const dir = workspaces.get(a.ws).dir;
        const target = await resolveInRoot(dir, a.path ?? ".");
        const args = [
          "--line-number",
          "--no-heading",
          "--null",
          "--color",
          "never",
          "--max-count",
          "20",
        ];
        args.push(...rgFilterArgs(a.glob));
        if (a.fixed_strings) args.push("--fixed-strings");
        args.push("--", a.pattern, target);
        const output = await exec("ws_search", "rg", args, {
          ws: a.ws,
          pattern: a.pattern,
        });
        return filterRgOutput(output, dir).split("\n").slice(0, 201).join("\n");
      })
  );

  server.registerTool(
    "ws_write",
    {
      description:
        "작업 공간에 파일을 새로 쓰거나 전체를 덮어쓴다. 일부만 바꿀 때는 ws_edit 을 쓴다.",
      inputSchema: { ws, path: file, content: z.string() },
      annotations: write,
    },
    async (a) =>
      logged("ws_write", { ws: a.ws, path: a.path, bytes: a.content.length }, () =>
        workspaces.write(a.ws, a.path, a.content)
      )
  );

  server.registerTool(
    "ws_edit",
    {
      description:
        "파일에서 old_string 을 new_string 으로 정확히 바꾼다. old_string 은 파일에 한 번만 있어야 한다 (replace_all 제외).",
      inputSchema: {
        ws,
        path: file,
        old_string: z.string().min(1),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      },
      annotations: write,
    },
    async (a) =>
      logged("ws_edit", { ws: a.ws, path: a.path }, () =>
        workspaces.edit(a.ws, a.path, a.old_string, a.new_string, a.replace_all)
      )
  );

  server.registerTool(
    "ws_delete",
    {
      description: "작업 공간에서 파일을 지운다.",
      inputSchema: { ws, path: file },
      annotations: { ...write, destructiveHint: true },
    },
    async (a) => logged("ws_delete", a, () => workspaces.remove(a.ws, a.path))
  );

  server.registerTool(
    "ws_diff",
    {
      description: "작업 공간의 변경 내용(git diff)을 본다. PR 전에 반드시 확인한다.",
      inputSchema: { ws },
      annotations: readOnly,
    },
    async (a) => logged("ws_diff", a, async () => finish(await workspaces.diff(a.ws)))
  );

  server.registerTool(
    "ws_create_pr",
    {
      description: [
        "변경을 커밋하고 verda/ 브랜치로 push 한 뒤 draft PR 을 만든다.",
        "사용자가 PR 을 요청한 경우에만 쓴다. 제목은 저장소의 커밋 메시지 관례(예: feat: ..., fix: ...)를 따른다.",
        "보호 경로(.github/workflows 등)나 비밀 값이 포함된 변경은 거부된다.",
      ].join(" "),
      inputSchema: {
        ws,
        title: z.string().min(1).max(200),
        body: z.string().max(10_000).describe("변경 이유, 내용, 확인 방법"),
      },
      annotations: { ...write, openWorldHint: true },
    },
    async (a) =>
      logged("ws_create_pr", { ws: a.ws, title: a.title }, () =>
        workspaces.createPullRequest(a.ws, a.title, a.body)
      )
  );
}

function registerGitHubTools(server: McpServer, reader: GitHubReader): void {
  const owners = reader.owners.join(", ");
  const repo = z
    .string()
    .describe(
      `저장소. owner/repo, repo(허용된 조직에서 찾음), GitHub URL 모두 된다. 조회 가능한 조직: ${owners}`
    );
  const limit = z.number().int().min(1).max(50).optional();
  const read = { readOnlyHint: true, openWorldHint: true };
  const logged = (
    tool: string,
    meta: Record<string, unknown>,
    run: () => Promise<string>
  ) =>
    respond(async () => {
      const started = Date.now();
      try {
        const result = finish(await run());
        audit({ tool, ...meta, ms: Date.now() - started, bytes: result.length });
        return result;
      } catch (err) {
        audit({ tool, ...meta, error: (err as Error).message.slice(0, 300) });
        throw err;
      }
    });

  server.registerTool(
    "gh_repo_search",
    {
      description: `GitHub 저장소를 이름, 설명으로 찾는다. 조직(${owners}) 안에서만 찾는다. 저장소 이름이 확실하지 않을 때 먼저 쓴다.`,
      inputSchema: {
        query: z.string().min(1).describe("검색어 (GitHub 검색 문법)"),
        limit,
      },
      annotations: read,
    },
    async (a) => logged("gh_repo_search", a, () => reader.searchRepos(a.query, a.limit))
  );

  server.registerTool(
    "gh_pr_list",
    {
      description:
        "저장소의 PR 목록을 최근 생성 순으로 본다. (번호, 제목, 작성자, 상태, 브랜치, 날짜, 라벨)",
      inputSchema: {
        repo,
        state: z.enum(["open", "closed", "all"]).optional().describe("기본 open"),
        limit,
      },
      annotations: read,
    },
    async (a) =>
      logged("gh_pr_list", a, () => reader.listPulls(a.repo, a.state ?? "open", a.limit))
  );

  server.registerTool(
    "gh_pr_search",
    {
      description: [
        "여러 저장소에 걸쳐 PR 을 검색한다. GitHub 검색 문법을 쓴다.",
        "(예: is:open repo:owner/a repo:owner/b, is:open author:someone, review-requested:someone)",
        `repo:/org: 가 없으면 조직(${owners}) 전체에서 찾는다.`,
      ].join(" "),
      inputSchema: { query: z.string().min(1), limit },
      annotations: read,
    },
    async (a) => logged("gh_pr_search", a, () => reader.searchPulls(a.query, a.limit))
  );

  server.registerTool(
    "gh_pr_view",
    {
      description:
        "PR 상세를 본다. 상태, 작성자, 브랜치, 변경 규모, 라벨, 리뷰 요청과 리뷰 결과, CI 체크, 본문, 변경 파일 목록.",
      inputSchema: {
        repo,
        number: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("PR 번호 (repo 가 owner/repo#번호나 PR URL 이면 생략)"),
      },
      annotations: read,
    },
    async (a) => logged("gh_pr_view", a, () => reader.viewPull(a.repo, a.number))
  );

  server.registerTool(
    "gh_pr_diff",
    {
      description:
        "PR 의 변경 내용(unified diff)을 본다. 길면 잘리므로 큰 PR 은 path 로 파일을 골라 본다.",
      inputSchema: {
        repo,
        number: z.number().int().positive().optional(),
        path: z.string().optional().describe("이 파일(경로 앞부분)의 변경만 본다"),
      },
      annotations: read,
    },
    async (a) => logged("gh_pr_diff", a, () => reader.pullDiff(a.repo, a.number, a.path))
  );
}

function registerJiraTools(server: McpServer, client: JiraClient): void {
  const projects = client.projects.join(", ");
  const key = z
    .string()
    .describe(`이슈 키 (예: ${client.projects[0]}-123) 또는 이슈 URL`);
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
  const logged = (
    tool: string,
    meta: Record<string, unknown>,
    run: () => Promise<string>
  ) =>
    respond(async () => {
      const started = Date.now();
      try {
        const result = finish(await run());
        audit({ tool, ...meta, ms: Date.now() - started, bytes: result.length });
        return result;
      } catch (err) {
        audit({ tool, ...meta, error: (err as Error).message.slice(0, 300) });
        throw err;
      }
    });

  server.registerTool(
    "jira_search",
    {
      description: [
        `JQL 로 Jira 이슈를 검색한다. 결과는 허용 프로젝트(${projects}) 안으로 고정된다.`,
        '(예: assignee = currentUser() AND statusCategory != Done, text ~ "키워드", updated >= -7d ORDER BY priority DESC)',
      ].join(" "),
      inputSchema: {
        jql: z.string().min(1).max(1000).describe("JQL. project 조건은 자동으로 붙는다"),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => logged("jira_search", a, () => client.search(a.jql, a.limit))
  );

  server.registerTool(
    "jira_issue",
    {
      description:
        "Jira 이슈 상세를 본다. 유형, 상태, 담당, 설명, 하위 이슈, 연결된 이슈, 최근 댓글, 링크.",
      inputSchema: {
        key,
        comments: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe("보여 줄 최근 댓글 수 (기본 10)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => logged("jira_issue", a, () => client.viewIssue(a.key, a.comments))
  );

  server.registerTool(
    "jira_create_issue",
    {
      description: [
        `Jira 이슈를 만든다. 허용 프로젝트(${projects})에만 만들 수 있고, 토큰 주인 계정으로 남는다.`,
        "사용자가 이슈 생성을 요청한 경우에만 쓴다. 비슷한 이슈가 있는지 jira_search 로 먼저 확인한다.",
        "유형을 생략하면 Task(작업). 상태 변경은 할 수 없다.",
      ].join(" "),
      inputSchema: {
        project: z.string().describe(`프로젝트 키 (${projects})`),
        summary: z.string().min(1).max(255).describe("제목"),
        description: z
          .string()
          .max(20_000)
          .optional()
          .describe("설명. 빈 줄로 문단을 나누고, - 로 시작하는 줄은 목록이 된다"),
        issue_type: z
          .string()
          .optional()
          .describe("유형 이름 (예: Task, Bug, Story, Sub-task)"),
        labels: z.array(z.string().max(50)).max(10).optional(),
        parent: z
          .string()
          .optional()
          .describe("상위 이슈 키 (하위 작업이나 에픽 하위로 만들 때)"),
      },
      annotations: write,
    },
    async (a) =>
      logged(
        "jira_create_issue",
        {
          project: a.project,
          summary: a.summary.slice(0, 100),
          type: a.issue_type,
          parent: a.parent,
        },
        () =>
          client.createIssue({
            project: a.project,
            summary: a.summary,
            description: a.description,
            issueType: a.issue_type,
            labels: a.labels,
            parent: a.parent,
          })
      )
  );

  server.registerTool(
    "jira_add_comment",
    {
      description:
        "Jira 이슈에 댓글을 남긴다. 사용자가 댓글을 요청한 경우에만 쓴다. 토큰 주인 계정으로 남는다.",
      inputSchema: {
        key,
        body: z.string().min(1).max(20_000).describe("댓글 내용. 빈 줄로 문단을 나눈다"),
      },
      annotations: write,
    },
    async (a) =>
      logged("jira_add_comment", { key: a.key, bytes: a.body.length }, () =>
        client.addComment(a.key, a.body)
      )
  );
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "ops-broker", version: "0.3.0" });
  if (hosts.size > 0) registerHostTools(server);
  if (k8sEnabled && clusters.length > 0) registerK8sTools(server);
  if (fsEnabled) registerFsTools(server);
  if (git) registerWorkspaceTools(server, git);
  if (github) registerGitHubTools(server, github);
  if (jira) registerJiraTools(server, jira);
  return server;
}

// ------------------------------------------------------------------ HTTP

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.url === "/healthz") {
    res
      .writeHead(200)
      .end(
        `ok hosts=${hosts.size} k8s=[${clusters.join(",")}] fs=${fsEnabled ? env.FS_ROOT : "off"} git=${git ? "on" : "off"} github=${github ? allowedOwners.join("|") : "off"} jira=${jira ? jiraProjects.join("|") : "off"}`
      );
    return;
  }
  if (req.url !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  if (req.method !== "POST") {
    // 상태 없는(stateless) 모드라 SSE 스트림/세션 종료 요청은 받지 않는다.
    res.writeHead(405, { Allow: "POST" }).end();
    return;
  }
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, await readBody(req));
}

async function start(): Promise<void> {
  if (k8sEnabled) {
    const { stdout } = await runProcess(
      "kubectl",
      ["--kubeconfig", env.KUBECONFIG_FILE, "config", "get-contexts", "-o", "name"],
      {
        cwd: "/tmp",
        input: "",
        timeoutMs: 10_000,
        env: TOOL_ENV,
      }
    );
    clusters = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }
  createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      audit({ error: (err as Error).message });
      if (!res.headersSent) res.writeHead(500).end();
    });
  }).listen(env.BROKER_PORT, () => {
    audit({
      event: "start",
      port: env.BROKER_PORT,
      sshHosts: hosts.size,
      k8sClusters: clusters,
      fsRoot: fsEnabled ? env.FS_ROOT : null,
      git: git ? { workRoot: env.WORK_ROOT, owners: env.GIT_ALLOWED_OWNERS } : null,
      jira: jira ? { url: env.JIRA_URL, projects: jiraProjects } : null,
    });
  });
}

void start();
