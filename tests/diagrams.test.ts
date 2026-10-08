import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/mention/responder.js";
import {
  composeAnswer,
  extractDiagrams,
  MAX_DIAGRAMS,
  renderArgs,
} from "../src/render/diagrams.js";

const answer = [
  "구조는 다음과 같습니다.",
  "```mermaid",
  "flowchart LR",
  "  a --> b",
  "```",
  "명령 예시:",
  "```bash",
  "kubectl get pods",
  "```",
  "```graphviz",
  "digraph { a -> b }",
  "```",
  "```vega-lite",
  '{"mark":"bar","data":{"values":[]}}',
  "```",
].join("\n");

describe("extractDiagrams", () => {
  it("그림용 언어 블록만 순서대로 고르고 다른 코드 블록은 두지 않는다", () => {
    const blocks = extractDiagrams(answer);
    expect(blocks.map((b) => b.format)).toEqual(["mermaid", "dot", "vega-lite"]);
    expect(blocks[0]!.source).toBe("flowchart LR\n  a --> b");
    expect(blocks[0]!.raw.startsWith("```mermaid")).toBe(true);
  });

  it("최대 개수와 빈 블록을 지킨다", () => {
    const many = Array.from(
      { length: 5 },
      (_, i) => `\`\`\`dot\ndigraph { n${i} }\n\`\`\``
    ).join("\n");
    expect(extractDiagrams(many)).toHaveLength(MAX_DIAGRAMS);
    expect(extractDiagrams("```mermaid\n   \n```")).toEqual([]);
  });
});

describe("composeAnswer", () => {
  it("그린 블록은 (그림 N) 으로, 실패한 블록은 원문과 안내를 남긴다", () => {
    const [mermaid, dot, vega] = extractDiagrams(answer);
    const text = composeAnswer(answer, [
      { block: mermaid!, figure: 1 },
      { block: dot! },
      { block: vega!, figure: 2 },
    ]);
    expect(text).toContain("_(그림 1: 아래 이미지)_");
    expect(text).toContain("_(그림 2: 아래 이미지)_");
    expect(text).not.toContain("flowchart LR");
    expect(text).toContain(
      "```graphviz\ndigraph { a -> b }\n```\n_(그림으로 그리지 못해 원문을 남깁니다)_"
    );
    expect(text).toContain("```bash\nkubectl get pods\n```");
  });
});

describe("renderArgs", () => {
  it("네트워크 없는 읽기 전용 일회용 컨테이너로 그린다", () => {
    const args = renderArgs(
      "renderer:1",
      "/home/me/agent/data/x/renders",
      "mermaid",
      "figure-1"
    );
    expect(args.slice(0, 4)).toEqual(["run", "--rm", "--network", "none"]);
    expect(args).toEqual(expect.arrayContaining(["--read-only", "--cap-drop", "ALL"]));
    expect(args.slice(-4)).toEqual([
      "renderer:1",
      "mermaid",
      "/io/figure-1.mmd",
      "/io/figure-1.png",
    ]);
  });
});

describe("systemPrompt", () => {
  it("렌더러가 있을 때만 그림 안내를 넣는다", () => {
    expect(systemPrompt(false, false, false)).not.toContain("```mermaid");
    expect(systemPrompt(false, false, true)).toContain("```mermaid");
  });
});

describe("생성 이미지", () => {
  it("codex 실행에만 /out 쓰기 마운트를 붙인다", async () => {
    const { dockerRunArgs } = await import("../src/reasoner/executor.js");
    const options = {
      dockerBin: "docker",
      image: "img",
      network: "n",
      proxyUrl: "http://p:1",
      memory: "1g",
      cpus: "1",
      claudeEnv: {},
    };
    expect(
      dockerRunArgs(options, { tool: "codex", args: [], outputDir: "/h/out" }, "c")
    ).toContain("/h/out:/out");
    expect(
      dockerRunArgs(options, { tool: "claude", args: [], outputDir: "/h/out" }, "c")
    ).not.toContain("/h/out:/out");
  });

  it("출력 디렉터리의 이미지를 만든 순서대로 모은다", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { collectGeneratedImages } = await import("../src/mention/responder.js");
    const dir = mkdtempSync(path.join(tmpdir(), "gen-"));
    mkdirSync(path.join(dir, "thread-1"));
    writeFileSync(path.join(dir, "thread-1", "b.png"), "B");
    writeFileSync(path.join(dir, "thread-1", "a.png"), "A");
    writeFileSync(path.join(dir, "thread-1", "note.txt"), "x");
    writeFileSync(path.join(dir, "thread-1", "empty.png"), "");
    utimesSync(path.join(dir, "thread-1", "b.png"), new Date(1000), new Date(1000));
    utimesSync(path.join(dir, "thread-1", "a.png"), new Date(2000), new Date(2000));
    const images = await collectGeneratedImages(dir);
    expect(images.map((b) => b.toString())).toEqual(["B", "A"]);
    expect(await collectGeneratedImages(path.join(dir, "missing"))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("codex 일 때만 이미지 생성 안내를 넣는다", () => {
    expect(systemPrompt(false, false, true, true)).toContain("이미지 생성 도구");
    expect(systemPrompt(false, false, true, false)).not.toContain("이미지 생성 도구");
  });
});

describe("resizeArgs", () => {
  it("렌더링과 같은 격리 조건으로 resize 를 실행한다", async () => {
    const { resizeArgs } = await import("../src/render/diagrams.js");
    const args = resizeArgs("renderer:1", "/h/x/resized", "image-1", 512);
    expect(args.slice(0, 4)).toEqual(["run", "--rm", "--network", "none"]);
    expect(args.slice(-5)).toEqual([
      "renderer:1",
      "resize",
      "/io/image-1.src",
      "/io/image-1.png",
      "512",
    ]);
  });
});
