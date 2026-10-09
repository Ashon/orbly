import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/mention/prompt.js";
import type { MessengerProfile } from "../src/messengers/types.js";
import {
  composeAnswer,
  extractDiagrams,
  MAX_DIAGRAMS,
  renderArgs,
} from "../src/render/diagrams.js";

const answer = [
  "The structure is as follows:",
  "```mermaid",
  "flowchart LR",
  "  a --> b",
  "```",
  "Example command:",
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
  it("picks only diagram language blocks, in order, and skips other code blocks", () => {
    const blocks = extractDiagrams(answer);
    expect(blocks.map((b) => b.format)).toEqual(["mermaid", "dot", "vega-lite"]);
    expect(blocks[0]!.source).toBe("flowchart LR\n  a --> b");
    expect(blocks[0]!.raw.startsWith("```mermaid")).toBe(true);
  });

  it("respects the maximum count and skips empty blocks", () => {
    const many = Array.from(
      { length: 5 },
      (_, i) => `\`\`\`dot\ndigraph { n${i} }\n\`\`\``
    ).join("\n");
    expect(extractDiagrams(many)).toHaveLength(MAX_DIAGRAMS);
    expect(extractDiagrams("```mermaid\n   \n```")).toEqual([]);
  });
});

describe("composeAnswer", () => {
  it("replaces rendered blocks with (Figure N) and keeps the source and a note for failed ones", () => {
    const [mermaid, dot, vega] = extractDiagrams(answer);
    const text = composeAnswer(answer, [
      { block: mermaid!, figure: 1 },
      { block: dot! },
      { block: vega!, figure: 2 },
    ]);
    expect(text).toContain("_(Figure 1: image below)_");
    expect(text).toContain("_(Figure 2: image below)_");
    expect(text).not.toContain("flowchart LR");
    expect(text).toContain(
      "```graphviz\ndigraph { a -> b }\n```\n_(Couldn't render this diagram, so the source is shown)_"
    );
    expect(text).toContain("```bash\nkubectl get pods\n```");
  });
});

describe("renderArgs", () => {
  it("renders in a disposable read-only container without network access", () => {
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

const slack: MessengerProfile = {
  name: "Slack",
  venues: "public channels",
  markup: "Slack mrkdwn",
  public: true,
};

describe("systemPrompt", () => {
  it("adds diagram instructions only when a renderer is available", () => {
    expect(systemPrompt(slack)).not.toContain("```mermaid");
    expect(systemPrompt(slack, { diagrams: true })).toContain("```mermaid");
  });
});

describe("generated images", () => {
  it("adds the writable /out mount only for codex runs", async () => {
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

  it("collects images from the output directory in creation order", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { collectGeneratedImages } = await import("../src/mention/generated.js");
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

  it("adds image generation instructions only for codex", () => {
    expect(systemPrompt(slack, { diagrams: true, imageGeneration: true })).toContain(
      "image generation tool"
    );
    expect(systemPrompt(slack, { diagrams: true })).not.toContain(
      "image generation tool"
    );
  });
});

describe("resizeArgs", () => {
  it("runs resize with the same isolation as rendering", async () => {
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
