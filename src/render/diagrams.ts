import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "../reasoner/process.js";

/**
 * Renders the diagram/chart code blocks in an answer to PNG.
 * Rendering runs in a disposable container without network access (sandbox/renderer).
 */
export type DiagramFormat = "mermaid" | "dot" | "vega-lite" | "svg";

const LANGUAGES: Record<string, DiagramFormat> = {
  mermaid: "mermaid",
  dot: "dot",
  graphviz: "dot",
  "vega-lite": "vega-lite",
  vegalite: "vega-lite",
  svg: "svg",
};
const EXTENSION: Record<DiagramFormat, string> = {
  mermaid: "mmd",
  dot: "dot",
  "vega-lite": "vl.json",
  svg: "svg",
};

export const MAX_DIAGRAMS = 3;
const MAX_SOURCE_CHARS = 20_000;
const MAX_PNG_BYTES = 10 * 1024 * 1024;

export interface DiagramBlock {
  format: DiagramFormat;
  source: string;
  /** Raw code block text in the answer (including the ```) */
  raw: string;
}

/** Finds diagram code blocks such as ```mermaid in order. Blocks in other languages are left alone. */
export function extractDiagrams(markdown: string): DiagramBlock[] {
  const blocks: DiagramBlock[] = [];
  for (const match of markdown.matchAll(
    /^```([A-Za-z-]+)[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm
  )) {
    const format = LANGUAGES[match[1]!.toLowerCase()];
    const source = match[2]!;
    if (!format || !source.trim() || source.length > MAX_SOURCE_CHARS) continue;
    blocks.push({ format, source, raw: match[0] });
    if (blocks.length >= MAX_DIAGRAMS) break;
  }
  return blocks;
}

/** Replaces rendered blocks with a (Figure N) marker and keeps the source of blocks that could not be rendered. */
export function composeAnswer(
  markdown: string,
  results: { block: DiagramBlock; figure?: number }[]
): string {
  let text = markdown;
  for (const { block, figure } of results) {
    text = text.replace(
      block.raw,
      figure !== undefined
        ? `_(Figure ${figure}: image below)_`
        : `${block.raw}\n_(Couldn't render this diagram, so the source is shown)_`
    );
  }
  return text;
}

/** Rendering container arguments. No network, read-only root, capabilities dropped, resource limits. */
export function renderArgs(
  image: string,
  dir: string,
  format: DiagramFormat,
  name: string
): string[] {
  return [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,size=256m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "1000:1000",
    "--memory",
    "1g",
    "--pids-limit",
    "256",
    "--label",
    "verda.role=renderer",
    "-v",
    `${dir}:/io`,
    image,
    format,
    `/io/${name}.${EXTENSION[format]}`,
    `/io/${name}.png`,
  ];
}

/** Image resize container arguments. Same isolation as rendering. */
export function resizeArgs(
  image: string,
  dir: string,
  name: string,
  maxPx: number
): string[] {
  const args = renderArgs(image, dir, "svg", name);
  // Replaces the last three renderArgs arguments (format, input, output) with the resize ones.
  return [
    ...args.slice(0, -3),
    "resize",
    `/io/${name}.src`,
    `/io/${name}.png`,
    String(maxPx),
  ];
}

export interface DiagramRendererOptions {
  dockerBin: string;
  image: string;
  timeoutMs: number;
}

export class DiagramRenderer {
  constructor(private readonly options: DiagramRendererOptions) {}

  /** Renders one block and returns the PNG buffer. dir must be a path under home that colima can mount. */
  async render(block: DiagramBlock, dir: string, name: string): Promise<Buffer> {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${name}.${EXTENSION[block.format]}`), block.source);
    await runProcess(
      this.options.dockerBin,
      renderArgs(this.options.image, dir, block.format, name),
      { cwd: process.cwd(), input: "", timeoutMs: this.options.timeoutMs }
    );
    const png = await readFile(path.join(dir, `${name}.png`));
    if (png.length === 0 || png.length > MAX_PNG_BYTES) {
      throw new Error(`Invalid PNG size (${png.length} bytes)`);
    }
    return png;
  }

  /** Returns a PNG scaled down with the aspect ratio kept when the long edge exceeds maxPx. */
  async resize(image: Buffer, dir: string, name: string, maxPx: number): Promise<Buffer> {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${name}.src`), image);
    await runProcess(
      this.options.dockerBin,
      resizeArgs(this.options.image, dir, name, maxPx),
      {
        cwd: process.cwd(),
        input: "",
        timeoutMs: this.options.timeoutMs,
      }
    );
    const png = await readFile(path.join(dir, `${name}.png`));
    if (png.length === 0) throw new Error("The resize result is empty.");
    return png;
  }

  async verify(): Promise<string[]> {
    try {
      await runProcess(this.options.dockerBin, ["image", "inspect", this.options.image], {
        cwd: process.cwd(),
        input: "",
        timeoutMs: 15_000,
      });
      return [];
    } catch {
      return [`Renderer image ${this.options.image} not found. (pnpm sandbox:build)`];
    }
  }
}
