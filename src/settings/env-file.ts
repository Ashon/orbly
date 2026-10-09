import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const PLAIN_VALUE = /^[A-Za-z0-9_./:@,~+%=-]*$/;

/** Reads values with the same rules as node --env-file. */
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
 * Quotes the value if it has spaces or special characters. node's .env parsing has no escapes, so
 * it picks a quote type the value does not contain. (Single quote, double quote, then backtick. Text inside single quotes and backticks is read as is)
 */
export function formatEnvValue(value: string): string {
  if (value.includes("\n")) throw new Error("Config values cannot contain line breaks.");
  if (PLAIN_VALUE.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes("\\")) return `"${value}"`;
  if (!value.includes("`")) return `\`${value}\``;
  throw new Error(
    "The value contains single quotes, double quotes, and backticks, so it cannot be written to .env."
  );
}

/**
 * Updates .env content. Comments, blank lines, order, and unhandled entries are kept as is.
 * - For an existing entry, changes the value on its first line and deletes later duplicates. (So only one value remains)
 * - null clears it to "KEY=". (The bot treats an empty value as unset and uses the default)
 * - New entries are appended together at the end.
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
    out.push("# Added from the Pacenote app settings screen");
    for (const [key, value] of added) out.push(`${key}=${formatEnvValue(value)}`);
  }
  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

/** Replaces the file so no half-written file is left. Keeps the existing file's mode, 600 for a new file */
export function writeEnvFile(file: string, text: string): void {
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  writeFileSync(`${file}.tmp`, text, { mode });
  renameSync(`${file}.tmp`, file);
}

export function readEnvFile(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}
