import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { AllowlistIssue } from "./types.js";

export type { AllowlistIssue };

/** Domains the reasoner CLI must have in order to work */
export const REQUIRED_DOMAINS: Record<"claude" | "codex", string[]> = {
  claude: ["api.anthropic.com"],
  codex: ["chatgpt.com", "auth.openai.com", "api.openai.com"],
};

const LABEL = "(?!-)[a-z0-9-]{1,63}(?<!-)";
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(\\.${LABEL})+$`);

/** The proxy allows only exact host name matches. Returns the reason if there is a problem. */
export function domainProblem(domain: string): string | undefined {
  if (!domain) return "The domain is empty.";
  if (/[*?]/.test(domain)) return "Wildcards are not allowed. Enter an exact host name.";
  if (/^[a-z]+:\/\//i.test(domain) || domain.includes("/"))
    return "Enter only a host name, not a URL.";
  if (domain.includes(":")) return "Do not include a port. (Only HTTPS 443 is allowed)";
  if (/^\d+(\.\d+){3}$/.test(domain)) return "IP addresses are not allowed.";
  if (!HOSTNAME.test(domain)) return "Not a valid host name.";
  return undefined;
}

export const normalizeDomain = (domain: string) =>
  domain.trim().toLowerCase().replace(/\.$/, "");

export function parseAllowlist(text: string): string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .map((line) => line.replace(/#.*/, "").trim())
        .filter(Boolean)
        .map(normalizeDomain)
    ),
  ];
}

/**
 * Syncs the allowlist file to domains. Comments and kept lines stay in place,
 * lines for removed domains are deleted, and new domains are appended together at the end.
 */
export function updateAllowlist(text: string, domains: string[]): string {
  const wanted = new Set(domains.map(normalizeDomain));
  const kept = new Set<string>();
  const out: string[] = [];
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const domain = normalizeDomain(line.replace(/#.*/, ""));
    if (!domain) {
      out.push(line);
      continue;
    }
    if (!wanted.has(domain) || kept.has(domain)) continue;
    kept.add(domain);
    out.push(line);
  }
  const added = [...wanted].filter((domain) => !kept.has(domain));
  if (added.length > 0) {
    if (out.length > 0 && out.at(-1) !== "") out.push("");
    out.push("# Added from the Pacenote app settings screen", ...added);
  }
  return `${out.join("\n")}\n`;
}

export function checkAllowlist(
  domains: string[],
  reasoner: "claude" | "codex"
): AllowlistIssue[] {
  const issues: AllowlistIssue[] = [];
  for (const domain of domains) {
    const problem = domainProblem(normalizeDomain(domain));
    if (problem) issues.push({ domain, message: problem });
  }
  const normalized = new Set(domains.map(normalizeDomain));
  for (const required of REQUIRED_DOMAINS[reasoner]) {
    if (!normalized.has(required)) {
      issues.push({ domain: required, message: `Required for ${reasoner} to work.` });
    }
  }
  return issues;
}

export function readAllowlistFile(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** Creates the allowlist from the default list (template, sandbox/proxy/allowed-domains.txt) if it is missing. */
export function ensureAllowlistFile(file: string, template: string): void {
  if (existsSync(file)) return;
  mkdirSync(path.dirname(file), { recursive: true });
  copyFileSync(template, file);
}

export function writeAllowlistFile(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}
