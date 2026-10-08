import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "../reasoner/process.js";

/**
 * 답변에 들어 있는 다이어그램/차트 코드 블록을 PNG 로 그린다.
 * 렌더링은 네트워크 없는 일회용 컨테이너(sandbox/renderer)에서 한다.
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
  /** 답변 안의 코드 블록 원문 (``` 포함) */
  raw: string;
}

/** ```mermaid 같은 그림용 코드 블록을 순서대로 찾는다. 다른 언어 블록은 그대로 둔다. */
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

/** 그린 블록은 (그림 N) 표시로 바꾸고, 그리지 못한 블록은 원문을 남긴다. */
export function composeAnswer(
  markdown: string,
  results: { block: DiagramBlock; figure?: number }[]
): string {
  let text = markdown;
  for (const { block, figure } of results) {
    text = text.replace(
      block.raw,
      figure !== undefined
        ? `_(그림 ${figure}: 아래 이미지)_`
        : `${block.raw}\n_(그림으로 그리지 못해 원문을 남깁니다)_`
    );
  }
  return text;
}

/** 렌더링 컨테이너 인자. 네트워크 없음, 읽기 전용 루트, 권한 제거, 자원 제한. */
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

/** 이미지 크기 조정 컨테이너 인자. 렌더링과 같은 격리 조건이다. */
export function resizeArgs(
  image: string,
  dir: string,
  name: string,
  maxPx: number
): string[] {
  const args = renderArgs(image, dir, "svg", name);
  // renderArgs 의 마지막 세 인자(형식, 입력, 출력)를 resize 용으로 바꾼다.
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

  /** 블록 하나를 그려 PNG 버퍼를 돌려준다. dir 은 colima 가 마운트할 수 있는 홈 아래 경로여야 한다. */
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
      throw new Error(`PNG 크기가 올바르지 않습니다 (${png.length} bytes)`);
    }
    return png;
  }

  /** 긴 변이 maxPx 를 넘으면 비율을 유지한 채 줄인 PNG 를 돌려준다. */
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
    if (png.length === 0) throw new Error("크기 조정 결과가 비어 있습니다.");
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
      return [`렌더링 이미지 ${this.options.image} 가 없습니다. (pnpm sandbox:build)`];
    }
  }
}
