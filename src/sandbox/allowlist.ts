import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { AllowlistIssue } from "./types.js";

export type { AllowlistIssue };

/** 추론 CLI 가 동작하려면 반드시 있어야 하는 도메인 */
export const REQUIRED_DOMAINS: Record<"claude" | "codex", string[]> = {
  claude: ["api.anthropic.com"],
  codex: ["chatgpt.com", "auth.openai.com", "api.openai.com"],
};

const LABEL = "(?!-)[a-z0-9-]{1,63}(?<!-)";
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(\\.${LABEL})+$`);

/** 프록시는 정확히 일치하는 호스트 이름만 허용한다. 문제가 있으면 이유를 돌려준다. */
export function domainProblem(domain: string): string | undefined {
  if (!domain) return "비어 있습니다.";
  if (/[*?]/.test(domain))
    return "와일드카드는 쓸 수 없습니다. 정확한 호스트 이름을 넣습니다.";
  if (/^[a-z]+:\/\//i.test(domain) || domain.includes("/"))
    return "주소가 아니라 호스트 이름만 넣습니다.";
  if (domain.includes(":")) return "포트는 넣지 않습니다. (HTTPS 443 만 허용)";
  if (/^\d+(\.\d+){3}$/.test(domain)) return "IP 주소는 쓸 수 없습니다.";
  if (!HOSTNAME.test(domain)) return "호스트 이름 형식이 아닙니다.";
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
 * 허용 목록 파일을 domains 로 맞춘다. 주석과 남는 줄의 위치는 그대로 두고,
 * 빠진 도메인 줄은 지우고, 새 도메인은 끝에 모아 붙인다.
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
    out.push("# Verda 앱 설정 화면에서 추가", ...added);
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
      issues.push({ domain: required, message: `${reasoner} 가 동작하려면 필요합니다.` });
    }
  }
  return issues;
}

export function readAllowlistFile(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

export function writeAllowlistFile(file: string, text: string): void {
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}
