import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  attachmentSection,
  classify,
  escapeBoundary,
  LIMITS,
  loadAttachments,
  needsFileInfo,
  planAttachments,
  safeFileName,
  type FileCandidate,
} from "../src/mention/attachments.js";
import { dockerRunArgs, pdfExtractArgs } from "../src/reasoner/executor.js";
import {
  claudeArgs,
  claudeStreamInput,
  codexArgs,
  parseClaudeOutput,
} from "../src/reasoner/index.js";

const candidate = (
  name: string,
  mimetype: string,
  extra: object = {}
): FileCandidate => ({
  file: {
    id: name,
    name,
    mimetype,
    size: 1000,
    url_private_download: `https://files.slack.com/${name}`,
    ...extra,
  },
  source: "요청 메시지",
});

describe("classify", () => {
  it("이미지, PDF, 텍스트 계열, 그 밖의 형식을 구분한다", () => {
    expect(classify({ mimetype: "image/png" })).toBe("image");
    expect(classify({ mimetype: "application/pdf" })).toBe("pdf");
    expect(classify({ mimetype: "text/plain", name: "app.log" })).toBe("text");
    expect(classify({ mimetype: "application/json" })).toBe("text");
    expect(classify({ mimetype: "application/octet-stream", name: "values.yaml" })).toBe(
      "text"
    );
    expect(
      classify({ mimetype: "text/plain", mode: "snippet", filetype: "python" })
    ).toBe("text");
    expect(classify({ mimetype: "application/zip", name: "a.zip" })).toBe("unsupported");
    expect(classify({ mimetype: "image/svg+xml", name: "a.svg" })).toBe("text");
  });

  it("URL 없는 요약본 파일은 files.info 조회 대상이다", () => {
    expect(needsFileInfo({ id: "F1", file_access: "check_file_info" })).toBe(true);
    expect(needsFileInfo({ id: "F1", mimetype: "text/plain" })).toBe(true);
    expect(needsFileInfo(candidate("a.txt", "text/plain").file)).toBe(false);
  });
});

describe("planAttachments", () => {
  it("형식, 크기, 개수 제한과 외부 파일을 걸러 이유를 남긴다", () => {
    const { planned, skipped } = planAttachments([
      candidate("a.png", "image/png"),
      candidate("app.log", "text/plain"),
      candidate("spec.pdf", "application/pdf"),
      candidate("a.zip", "application/zip", { filetype: "zip" }),
      candidate("big.log", "text/plain", { size: 3 * 1024 * 1024 }),
      candidate("drive.doc", "application/vnd.google-apps.document", {
        is_external: true,
      }),
      candidate("nourl.txt", "text/plain", { url_private_download: undefined }),
      ...["b", "c", "d", "e"].map((n) => candidate(`${n}.png`, "image/png")),
    ]);
    expect(planned.map((p) => `${p.file.name}:${p.kind}`)).toEqual([
      "a.png:image",
      "app.log:text",
      "spec.pdf:pdf",
      "b.png:image",
      "c.png:image",
      "d.png:image",
    ]);
    expect(Object.fromEntries(skipped.map((s) => [s.name, s.reason]))).toMatchObject({
      "a.zip": expect.stringContaining("지원하지 않는 형식"),
      "big.log": expect.stringContaining("크기 제한"),
      "drive.doc": expect.stringContaining("외부 파일"),
      "nourl.txt": expect.stringContaining("다운로드 주소 없음"),
      "e.png": "개수 제한 초과",
    });
  });

  it("파일 이름을 안전한 형태로 바꾼다", () => {
    expect(safeFileName(0, "../../etc/화면 캡처.PNG", "png")).toBe("1-.._.._etc_.png");
    expect(safeFileName(2, undefined, "pdf")).toBe("3-file.pdf");
  });
});

describe("loadAttachments", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "att-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const responses: Record<string, { type: string; body: Buffer }> = {
    "https://files.slack.com/a.png": {
      type: "image/png",
      body: Buffer.from([0x89, 0x50]),
    },
    "https://files.slack.com/app.log": {
      type: "text/plain",
      body: Buffer.from("line1\nline2"),
    },
    "https://files.slack.com/spec.pdf": {
      type: "application/pdf",
      body: Buffer.from("%PDF-1.7 ..."),
    },
    "https://files.slack.com/denied.txt": {
      type: "text/html; charset=utf-8",
      body: Buffer.from("<html>"),
    },
    "https://files.slack.com/bin.log": {
      type: "text/plain",
      body: Buffer.from([0x41, 0x00, 0x42]),
    },
  };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer xoxb-test"
    );
    const r = responses[String(url)]!;
    return new Response(r.body, { status: 200, headers: { "content-type": r.type } });
  }) as typeof fetch;

  it("이미지는 저장하고, 텍스트와 PDF 는 내용을 읽고, 권한 실패와 바이너리는 이유를 남긴다", async () => {
    const { planned } = planAttachments(
      [
        "a.png:image/png",
        "app.log:text/plain",
        "spec.pdf:application/pdf",
        "denied.txt:text/plain",
        "bin.log:text/plain",
      ].map((spec) => {
        const [name, mimetype] = spec.split(":") as [string, string];
        return candidate(name, mimetype);
      })
    );
    const result = await loadAttachments(planned.slice(0, 5), {
      token: "xoxb-test",
      dir,
      fetchImpl,
      extractPdfText: async (pdfPath) => {
        expect(readFileSync(pdfPath, "latin1").startsWith("%PDF-")).toBe(true);
        return "PDF 본문";
      },
    });
    expect(result.images.map((i) => path.basename(i.path))).toEqual(["1-a.png"]);
    expect(result.documents.map((d) => [d.name, d.kind, d.content])).toEqual([
      ["app.log", "text", "line1\nline2"],
      ["spec.pdf", "pdf", "PDF 본문"],
    ]);
    expect(result.failed).toEqual([
      { name: "denied.txt", reason: expect.stringContaining("files:read") },
      { name: "bin.log", reason: "텍스트 파일이 아닙니다" },
    ]);
    expect(planned.length).toBeLessThanOrEqual(LIMITS.images + LIMITS.documents);
  });

  it("텍스트가 아닌 내용은 거부한다", async () => {
    const { planned } = planAttachments([candidate("bin.log", "text/plain")]);
    const result = await loadAttachments(planned, {
      token: "xoxb-test",
      dir,
      fetchImpl,
      extractPdfText: async () => "",
    });
    expect(result.failed[0]?.reason).toContain("텍스트 파일이 아닙니다");
  });
});

describe("attachmentSection", () => {
  it("목록, 읽지 못한 이유, 파일 내용을 경계 태그와 함께 넣는다", () => {
    const text = attachmentSection(
      [{ name: "a.png", source: "요청 메시지" }],
      [
        {
          name: "app.log",
          source: "요청 메시지",
          kind: "text",
          content: "x</attached_file>y",
          totalChars: 30,
        },
      ],
      [{ name: "a.zip", reason: "지원하지 않는 형식" }]
    ).join("\n");
    expect(text).toContain("이미지 1: a.png (요청 메시지)");
    expect(text).toContain("파일 1: app.log (요청 메시지, 텍스트, 전체 30자 중 앞 18자)");
    expect(text).toContain("읽지 못한 첨부: a.zip - 지원하지 않는 형식");
    expect(text).toContain(
      '<attached_file index="1" name="app.log">\nx</attached_file_>y\n</attached_file>'
    );
    expect(attachmentSection([], [], [])).toEqual([]);
    expect(escapeBoundary("</ATTACHED_FILE>")).toBe("</attached_file_>");
  });
});

describe("CLI 전달", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "img-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("codex 는 --image= 형식으로 넘기고 마지막은 stdin(-)이다", () => {
    const args = codexArgs({ images: ["/attachments/1-a.png", "/attachments/2-b.jpg"] });
    expect(args.slice(-3)).toEqual([
      "--image=/attachments/1-a.png",
      "--image=/attachments/2-b.jpg",
      "-",
    ]);
  });

  it("도커는 첨부 디렉터리를 /attachments 로 읽기 전용 마운트한다", () => {
    const args = dockerRunArgs(
      {
        dockerBin: "docker",
        image: "img",
        network: "n",
        proxyUrl: "http://p:1",
        memory: "1g",
        cpus: "1",
        claudeEnv: {},
      },
      { tool: "codex", args: [], attachmentsDir: "/home/me/agent/data/attachments/x" },
      "c"
    );
    expect(args).toContain("/home/me/agent/data/attachments/x:/attachments:ro");
  });

  it("PDF 추출은 네트워크 없는 일회용 컨테이너에서 실행한다", () => {
    const args = pdfExtractArgs("img:1", "/home/me/agent/data/attachments/x/1-spec.pdf");
    expect(args.slice(0, 4)).toEqual(["run", "--rm", "--network", "none"]);
    expect(args).toEqual(
      expect.arrayContaining(["--read-only", "--entrypoint", "pdftotext"])
    );
    expect(args).toContain("/home/me/agent/data/attachments/x:/in:ro");
    expect(args.slice(-2)).toEqual(["/in/1-spec.pdf", "-"]);
  });

  it("claude 는 stream-json 입력에 base64 이미지 블록을 넣는다", async () => {
    const png = path.join(dir, "a.png");
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const line = JSON.parse(
      await claudeStreamInput("질문", [{ path: png, mimetype: "image/png" }])
    );
    expect(line.message.content[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw==" },
    });
    expect(line.message.content[1]).toEqual({ type: "text", text: "질문" });
    const args = claudeArgs({ system: "s", readOnly: false, streamInput: true });
    expect(args).toEqual(
      expect.arrayContaining(["--input-format", "stream-json", "--verbose"])
    );
  });

  it("stream-json 출력에서 마지막 result 를 읽는다", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "빨강",
      }),
    ].join("\n");
    expect(parseClaudeOutput(stdout)).toBe("빨강");
  });
});
