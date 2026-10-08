import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const PLAIN_VALUE = /^[A-Za-z0-9_./:@,~+%=-]*$/;

/** node --env-file 과 같은 규칙으로 값을 읽는다. */
export function readEnvValues(text: string): Record<string, string> {
  return parseEnv(text) as Record<string, string>;
}

export function envKeys(text: string): string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .map((line) => ASSIGNMENT.exec(line)?.[1])
        .filter((key): key is string => Boolean(key))
    ),
  ];
}

/**
 * 공백이나 특수 문자가 있으면 따옴표로 감싼다. node 의 .env 해석에는 이스케이프가 없어서
 * 값에 없는 따옴표 종류를 고른다. (작은따옴표, 큰따옴표, 백틱 순, 작은따옴표와 백틱 안은 그대로 읽힌다)
 */
export function formatEnvValue(value: string): string {
  if (value.includes("\n")) throw new Error("설정 값에 줄바꿈을 넣을 수 없습니다.");
  if (PLAIN_VALUE.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes("\\")) return `"${value}"`;
  if (!value.includes("`")) return `\`${value}\``;
  throw new Error("값에 작은따옴표, 큰따옴표, 백틱이 모두 있어 .env 에 쓸 수 없습니다.");
}

/**
 * .env 내용을 바꾼다. 주석, 빈 줄, 순서, 다루지 않는 항목은 그대로 둔다.
 * - 있는 항목은 첫 줄의 값을 바꾸고, 같은 항목이 뒤에 또 있으면 지운다. (값이 하나만 남게)
 * - null 은 "KEY=" 로 비운다. (봇은 빈 값을 설정하지 않은 것으로 보고 기본값을 쓴다)
 * - 없던 항목은 끝에 모아 붙인다.
 */
export function updateEnvText(
  text: string,
  changes: Record<string, string | null>
): string {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const pending = new Map(Object.entries(changes));
  const done = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = ASSIGNMENT.exec(line)?.[1];
    if (key && pending.has(key)) {
      const value = pending.get(key)!;
      pending.delete(key);
      done.add(key);
      out.push(`${key}=${value === null ? "" : formatEnvValue(value)}`);
      continue;
    }
    if (key && done.has(key)) continue;
    out.push(line);
  }
  const added = [...pending].filter(([, value]) => value !== null) as [string, string][];
  if (added.length > 0) {
    if (out.length > 0 && out.at(-1) !== "") out.push("");
    out.push("# Verda 앱 설정 화면에서 추가");
    for (const [key, value] of added) out.push(`${key}=${formatEnvValue(value)}`);
  }
  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

/** 반쯤 쓴 파일이 남지 않게 바꿔 쓴다. 권한은 기존 파일을 따르고, 새 파일은 600 */
export function writeEnvFile(file: string, text: string): void {
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  writeFileSync(`${file}.tmp`, text, { mode });
  renameSync(`${file}.tmp`, file);
}

export function readEnvFile(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}
