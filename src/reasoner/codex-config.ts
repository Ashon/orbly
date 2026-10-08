import { existsSync, readFileSync } from "node:fs";

export interface CodexDefaults {
  model?: string;
  reasoningEffort?: string;
}

/**
 * ~/.codex/config.toml 에서 최상위 model, model_reasoning_effort 만 읽는다.
 * 샌드박스 컨테이너에는 호스트 설정 파일을 넣지 않으므로 이 값만 인자로 넘긴다.
 */
export function parseCodexDefaults(toml: string): CodexDefaults {
  const topLevel = toml.split(/^\s*\[/m)[0] ?? "";
  const read = (key: string) =>
    new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(topLevel)?.[1];
  return { model: read("model"), reasoningEffort: read("model_reasoning_effort") };
}

export function readCodexDefaults(configFile: string): CodexDefaults {
  if (!existsSync(configFile)) return {};
  return parseCodexDefaults(readFileSync(configFile, "utf8"));
}
