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
 * Ops check relay (ops-broker). An MCP (Streamable HTTP) server reachable only from the sandbox internal network.
 * SSH keys, kubeconfig, and the work directory exist only in this container; the reasoner container only requests predefined lookups.
 * - host_*: read-only host checks on inventory hosts (SSH)
 * - k8s_*: kubectl lookups with a read-only ServiceAccount
 * - fs_*: read-only browsing of the work directory (secret files excluded)
 * - ws_*: code edits and draft PR creation in a separate workspace created from the remote default branch
 * - gh_*: read-only lookups of GitHub repositories and PRs in allowed orgs (the token exists only in this container)
 * - jira_*: Jira issue lookups in allowed projects, plus issue creation and comments on request (the token exists only in this container)
 * Features with empty settings or an empty mounted file do not register their tools.
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

// ------------------------------------------------------------------ Per-feature setup

/** Unconfigured mounts arrive as an empty file or an empty directory. */
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
  // The mounted key may have the wrong owner/permissions, so copy it to tmpfs and set it to 600.
  mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
  copyFileSync(env.SSH_KEY_FILE, KEY);
  chmodSync(KEY, 0o600);
  if (nonEmptyFile(env.KNOWN_HOSTS_FILE)) copyFileSync(env.KNOWN_HOSTS_FILE, KNOWN_HOSTS);
}

const k8sEnabled = nonEmptyFile(env.KUBECONFIG_FILE);
let clusters: string[] = [];
const fsEnabled = nonEmptyDir(env.FS_ROOT);
/** Allowed owners shared by PR creation (ws_*) and GitHub lookups (gh_*) */
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

// ------------------------------------------------------------------ Shared execution

let running = 0;

/**
 * Environment variables for external commands (ssh, kubectl, rg). The broker environment holds credentials
 * such as GH_TOKEN and JIRA_TOKEN, so it is not passed down.
 */
const TOOL_ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: "/tmp" };

/** Runs an external command. A nonzero exit is also returned as a result, and the output has secrets redacted and is truncated. */
async function exec(
  tool: string,
  command: string,
  args: string[],
  meta: Record<string, unknown>
): Promise<string> {
  if (running >= env.MAX_CONCURRENT)
    throw new Error("Too many concurrent requests. Try again shortly.");
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
    ? `${clean.slice(0, env.OUTPUT_LIMIT)}\n... (output truncated, ${clean.length} characters total)`
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

// ------------------------------------------------------------------ Tool registration

function registerHostTools(server: McpServer): void {
  server.registerTool(
    "host_list",
    {
      description:
        "Lists host names and addresses available for checks (only inventory hosts within the allowed CIDR range).",
      annotations: readOnly,
    },
    async () =>
      respond(
        async () => [...hosts].map(([name, ip]) => `${name} ${ip}`).join("\n") || "(none)"
      )
  );

  server.registerTool(
    "host_check",
    {
      description: [
        "Runs a predefined read-only check on a host over SSH. Arbitrary commands cannot be run.",
        "check types:",
        ...CHECK_NAMES.map((name) => `- ${name}: ${CHECKS[name].description}`),
      ].join("\n"),
      inputSchema: {
        host: z.string().describe("Host name (a name from host_list, e.g. web-01)"),
        check: z.enum(CHECK_NAMES).describe("Check type"),
        lines: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Number of lines for dmesg/journal"),
        unit: z.string().optional().describe("systemd unit name for service/journal"),
        vendor: z
          .string()
          .optional()
          .describe("PCI vendor ID for pci_devices (4 hex digits, e.g. 10de)"),
      },
      annotations: readOnly,
    },
    async ({ host, check, lines, unit, vendor }) =>
      respond(async () => {
        const ip = hosts.get(host);
        if (!ip)
          throw new Error(`Host is not allowed: ${host} (see host_list for the list)`);
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
  const cluster = z.string().describe(`Cluster context (${clusters.join(", ")})`);
  const ns = z.string().optional().describe("Namespace");

  server.registerTool(
    "k8s_get",
    {
      description:
        "Looks up resources with kubectl get. Access is read-only and secrets cannot be viewed. Default output is wide.",
      inputSchema: {
        cluster,
        kind: z
          .string()
          .describe("Resource kind (e.g. pods, nodes, deployments, services)"),
        namespace: ns,
        name: z.string().optional().describe("Resource name"),
        selector: z.string().optional().describe("Label selector (e.g. app=nginx)"),
        all_namespaces: z.boolean().optional().describe("All namespaces"),
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
      description: "Shows resource details and recent events with kubectl describe.",
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
      description: `Last N lines of pod logs (default 200, max ${MAX_LOG_LINES}).`,
      inputSchema: {
        cluster,
        namespace: z.string(),
        pod: z.string(),
        container: z.string().optional(),
        tail: z.number().int().min(1).max(MAX_LOG_LINES).optional(),
        since: z.string().optional().describe("e.g. 30m, 2h"),
        previous: z
          .boolean()
          .optional()
          .describe("Logs of the previously terminated container"),
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
      description:
        "Shows events in chronological order. Omit namespace for all namespaces.",
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
      description: "CPU/memory usage of nodes or pods (metrics-server).",
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

/** Searching the whole root is too slow on the mount, so the scope must be at least one repository. */
function requireScope(requested: string): string {
  const scoped = requested
    .trim()
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "");
  if (!scoped || scoped === ".") {
    throw new Error(
      "Narrow path to a repository or a directory inside one (e.g. my-repo, my-repo/docs)."
    );
  }
  return scoped;
}

function registerFsTools(server: McpServer): void {
  const root = env.FS_ROOT;
  const rel = z.string().describe("Path relative to the work root (e.g. my-repo/docs)");

  server.registerTool(
    "fs_list",
    {
      description:
        "Lists the work directory. The top level holds repository directories. Read-only; secret files are hidden.",
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
      description: `Reads a text file with line numbers. Up to ${MAX_READ_LINES} lines at a time.`,
      inputSchema: {
        path: rel,
        offset: z.number().int().min(1).optional().describe("Starting line (1-based)"),
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
        "Searches file contents with ripgrep. Follows .gitignore and the secret file deny rules. Results are capped at 200 lines.",
      inputSchema: {
        pattern: z
          .string()
          .min(1)
          .max(200)
          .describe("Regular expression (ripgrep syntax)"),
        path: rel.describe("Subpath to search (a repository or deeper, e.g. my-repo)"),
        glob: z.string().max(100).optional().describe("File name filter (e.g. *.yaml)"),
        fixed_strings: z
          .boolean()
          .optional()
          .describe("Search for a literal string instead of a regex"),
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
          ? `${shown}\n... (${lines.length - 201} more ${lines.length - 201 === 1 ? "line" : "lines"}, narrow with path/glob)`
          : shown;
      })
  );

  server.registerTool(
    "fs_find",
    {
      description: "Finds files by file name glob (e.g. **/*.yaml).",
      inputSchema: {
        glob: z.string().min(1).max(100),
        path: rel.describe("Subpath to search (a repository or deeper)"),
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
          ? `${lines.slice(0, 201).join("\n")}\n... (${lines.length - 201} more)`
          : lines.join("\n");
      })
  );
}

function registerWorkspaceTools(server: McpServer, workspaces: GitWorkspaces): void {
  const ws = z.string().describe("Workspace id returned by ws_prepare");
  const file = z.string().describe("Path relative to the workspace");
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
        "Creates a workspace for code changes. Finds the GitHub remote from the local repository name (a top-level directory in fs_list)",
        "and creates a new verda/ branch from the remote default branch (or base). The user's local working tree is not changed.",
      ].join(" "),
      inputSchema: {
        repo: z.string().describe("Local repository directory name (e.g. my-repo)"),
        base: z
          .string()
          .optional()
          .describe("Base branch. Defaults to the remote default branch"),
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
      description: "Lists a directory in the workspace.",
      inputSchema: { ws, path: file.optional() },
      annotations: readOnly,
    },
    async (a) =>
      logged("ws_list", a, () => listDir(workspaces.get(a.ws).dir, a.path ?? "."))
  );

  server.registerTool(
    "ws_read",
    {
      description: `Reads a workspace file with line numbers. Up to ${MAX_READ_LINES} lines at a time.`,
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
      description: "Searches file contents in the workspace with ripgrep.",
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
        "Writes a new file in the workspace or overwrites a whole file. Use ws_edit to change only part of a file.",
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
        "Replaces old_string with new_string exactly in a file. old_string must appear exactly once in the file (unless replace_all).",
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
      description: "Deletes a file from the workspace.",
      inputSchema: { ws, path: file },
      annotations: { ...write, destructiveHint: true },
    },
    async (a) => logged("ws_delete", a, () => workspaces.remove(a.ws, a.path))
  );

  server.registerTool(
    "ws_diff",
    {
      description:
        "Shows the workspace changes (git diff). Always review them before creating a PR.",
      inputSchema: { ws },
      annotations: readOnly,
    },
    async (a) => logged("ws_diff", a, async () => finish(await workspaces.diff(a.ws)))
  );

  server.registerTool(
    "ws_create_pr",
    {
      description: [
        "Commits the changes, pushes them to the verda/ branch, and opens a draft PR.",
        "Use only when the user asked for a PR. The title follows the repository's commit message convention (e.g. feat: ..., fix: ...).",
        "Changes that touch protected paths (such as .github/workflows) or contain secrets are rejected.",
      ].join(" "),
      inputSchema: {
        ws,
        title: z.string().min(1).max(200),
        body: z
          .string()
          .max(10_000)
          .describe("Why the change was made, what changed, and how to verify it"),
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
      `Repository. Accepts owner/repo, repo (looked up in the allowed orgs), or a GitHub URL. Orgs available for lookup: ${owners}`
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
      description: `Finds GitHub repositories by name and description. Searches only within the orgs (${owners}). Use this first when unsure of a repository name.`,
      inputSchema: {
        query: z.string().min(1).describe("Search query (GitHub search syntax)"),
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
        "Lists a repository's PRs, newest first (number, title, author, state, branch, dates, labels).",
      inputSchema: {
        repo,
        state: z.enum(["open", "closed", "all"]).optional().describe("Default open"),
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
        "Searches PRs across repositories using GitHub search syntax.",
        "(e.g. is:open repo:owner/a repo:owner/b, is:open author:someone, review-requested:someone)",
        `Without repo: or org:, searches all of the orgs (${owners}).`,
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
        "Shows PR details: state, author, branch, change size, labels, review requests and review results, CI checks, body, and changed files.",
      inputSchema: {
        repo,
        number: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("PR number (omit if repo is owner/repo#number or a PR URL)"),
      },
      annotations: read,
    },
    async (a) => logged("gh_pr_view", a, () => reader.viewPull(a.repo, a.number))
  );

  server.registerTool(
    "gh_pr_diff",
    {
      description:
        "Shows a PR's changes (unified diff). Long output is truncated, so for large PRs pick files with path.",
      inputSchema: {
        repo,
        number: z.number().int().positive().optional(),
        path: z
          .string()
          .optional()
          .describe("Show only changes to this file (path prefix)"),
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
    .describe(`Issue key (e.g. ${client.projects[0]}-123) or issue URL`);
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
        `Searches Jira issues with JQL. Results are restricted to the allowed projects (${projects}).`,
        '(e.g. assignee = currentUser() AND statusCategory != Done, text ~ "keyword", updated >= -7d ORDER BY priority DESC)',
      ].join(" "),
      inputSchema: {
        jql: z
          .string()
          .min(1)
          .max(1000)
          .describe("JQL. The project condition is added automatically"),
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
        "Shows Jira issue details: type, status, assignee, description, subtasks, linked issues, recent comments, and link.",
      inputSchema: {
        key,
        comments: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe("Number of recent comments to show (default 10)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (a) => logged("jira_issue", a, () => client.viewIssue(a.key, a.comments))
  );

  server.registerTool(
    "jira_create_issue",
    {
      description: [
        `Creates a Jira issue. Issues can be created only in the allowed projects (${projects}) and are recorded under the token owner's account.`,
        "Use only when the user asked for an issue to be created. Check for similar issues with jira_search first.",
        "If the type is omitted, Task is used. Status changes are not supported.",
      ].join(" "),
      inputSchema: {
        project: z.string().describe(`Project key (${projects})`),
        summary: z.string().min(1).max(255).describe("Summary"),
        description: z
          .string()
          .max(20_000)
          .optional()
          .describe(
            "Description. Blank lines separate paragraphs, and lines starting with - become list items"
          ),
        issue_type: z
          .string()
          .optional()
          .describe("Issue type name (e.g. Task, Bug, Story, Sub-task)"),
        labels: z.array(z.string().max(50)).max(10).optional(),
        parent: z
          .string()
          .optional()
          .describe(
            "Parent issue key (when creating a subtask or an issue under an epic)"
          ),
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
        "Adds a comment to a Jira issue. Use only when the user asked for a comment. The comment is posted under the token owner's account.",
      inputSchema: {
        key,
        body: z
          .string()
          .min(1)
          .max(20_000)
          .describe("Comment body. Blank lines separate paragraphs"),
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
    // Stateless mode, so SSE stream and session termination requests are not accepted.
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
