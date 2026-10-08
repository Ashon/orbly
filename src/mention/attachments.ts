import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 멘션/스레드 첨부 파일을 모델 입력으로 바꾼다.
 * - 이미지: 파일로 저장해 CLI 에 이미지로 넘긴다.
 * - 텍스트(로그, 설정, 코드, 스니펫): 내용을 프롬프트에 데이터로 넣는다.
 * - PDF: 네트워크 없는 컨테이너에서 텍스트만 뽑아 넣는다.
 * - 그 밖의 형식, 외부 파일: 읽지 못한 이유를 알려 준다.
 */

export const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export const LIMITS = {
  images: 4,
  documents: 4,
  imageBytes: 10 * 1024 * 1024,
  textBytes: 2 * 1024 * 1024,
  pdfBytes: 20 * 1024 * 1024,
  charsPerDocument: 50_000,
  charsTotal: 120_000,
};

const TEXT_MIME = new Set([
  "application/json",
  "application/x-ndjson",
  "application/x-yaml",
  "application/yaml",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-sh",
  "application/x-shellscript",
  "application/toml",
  "application/sql",
  "application/x-python",
  "image/svg+xml",
]);

const TEXT_FILETYPES = new Set([
  "text",
  "markdown",
  "json",
  "yaml",
  "csv",
  "tsv",
  "log",
  "shell",
  "bash",
  "python",
  "javascript",
  "typescript",
  "go",
  "rust",
  "java",
  "kotlin",
  "c",
  "cpp",
  "csharp",
  "diff",
  "patch",
  "sql",
  "xml",
  "html",
  "css",
  "toml",
  "ini",
  "dockerfile",
  "makefile",
  "ruby",
  "php",
  "swift",
  "scala",
  "perl",
  "lua",
  "groovy",
  "properties",
  "terraform",
]);

const TEXT_EXTENSION =
  /\.(txt|log|out|md|json|jsonl|ya?ml|csv|tsv|conf|cfg|ini|toml|sh|bash|py|js|mjs|ts|go|rs|java|kt|c|h|cc|cpp|hpp|sql|xml|html|css|diff|patch|properties|tf|hcl|jsonnet|libsonnet|j2|tpl|service|svg)$/i;

export type AttachmentKind = "image" | "text" | "pdf" | "unsupported";

export interface SlackFileRef {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  mode?: string;
  size?: number;
  is_external?: boolean;
  file_access?: string;
  url_private_download?: string;
}

export interface FileCandidate {
  file: SlackFileRef;
  /** 프롬프트에 표시할 출처 (예: 요청 메시지, 스레드 10/08 14:20 @alice) */
  source: string;
}

export interface PlannedFile extends FileCandidate {
  kind: Exclude<AttachmentKind, "unsupported">;
}

export interface SkippedFile {
  name: string;
  reason: string;
}

export interface SavedImage {
  path: string;
  mimetype: string;
  name: string;
  source: string;
}

export interface LoadedDocument {
  name: string;
  source: string;
  kind: "text" | "pdf";
  content: string;
  /** 잘리기 전 전체 글자 수 */
  totalChars: number;
}

/** 이벤트의 파일 정보가 URL 없는 요약본으로 오면 files.info 로 다시 조회해야 한다. */
export function needsFileInfo(file: SlackFileRef): boolean {
  return (
    file.file_access === "check_file_info" || !file.url_private_download || !file.mimetype
  );
}

export function classify(file: SlackFileRef): AttachmentKind {
  const mimetype = (file.mimetype ?? "").toLowerCase();
  const filetype = (file.filetype ?? "").toLowerCase();
  if (mimetype in IMAGE_TYPES) return "image";
  if (mimetype === "application/pdf" || filetype === "pdf") return "pdf";
  if (
    file.mode === "snippet" ||
    mimetype.startsWith("text/") ||
    TEXT_MIME.has(mimetype) ||
    TEXT_FILETYPES.has(filetype) ||
    TEXT_EXTENSION.test(file.name ?? "")
  ) {
    return "text";
  }
  return "unsupported";
}

const displayName = (file: SlackFileRef) => file.name ?? file.title ?? file.id ?? "file";

/** 형식, 크기, 개수 제한으로 읽을 파일을 고른다. 앞에 있는 후보가 우선이다. */
export function planAttachments(candidates: FileCandidate[]): {
  planned: PlannedFile[];
  skipped: SkippedFile[];
} {
  const planned: PlannedFile[] = [];
  const skipped: SkippedFile[] = [];
  let images = 0;
  let documents = 0;
  for (const candidate of candidates) {
    const { file } = candidate;
    const name = displayName(file);
    if (file.is_external) {
      skipped.push({ name, reason: "외부 파일(Google Drive 등)은 읽을 수 없음" });
      continue;
    }
    if (!file.url_private_download) {
      skipped.push({
        name,
        reason: "다운로드 주소 없음 (files:read 권한 또는 파일 접근 제한)",
      });
      continue;
    }
    const kind = classify(file);
    if (kind === "unsupported") {
      skipped.push({
        name,
        reason: `지원하지 않는 형식 (${file.filetype || file.mimetype || "?"})`,
      });
      continue;
    }
    const size = file.size ?? 0;
    const limit =
      kind === "image"
        ? LIMITS.imageBytes
        : kind === "pdf"
          ? LIMITS.pdfBytes
          : LIMITS.textBytes;
    if (size > limit) {
      skipped.push({ name, reason: `크기 제한 초과 (${Math.round(size / 1024)}KB)` });
      continue;
    }
    if (kind === "image" ? images >= LIMITS.images : documents >= LIMITS.documents) {
      skipped.push({ name, reason: "개수 제한 초과" });
      continue;
    }
    if (kind === "image") images += 1;
    else documents += 1;
    planned.push({ ...candidate, kind });
  }
  return { planned, skipped };
}

/** 파일 이름을 경로에 안전한 형태로 바꾼다. */
export function safeFileName(
  index: number,
  name: string | undefined,
  extension: string
): string {
  const base = (name ?? "file")
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .slice(0, 40);
  return `${index + 1}-${base || "file"}.${extension}`;
}

/** 텍스트로 볼 수 있는 내용인지 (앞부분에 NUL 바이트가 없는지) */
export function looksLikeText(buffer: Buffer): boolean {
  return !buffer.subarray(0, 8192).includes(0);
}

/** 프롬프트 경계 태그를 내용이 끝내지 못하게 한다. */
export function escapeBoundary(text: string): string {
  return text.replace(/<\/attached_file/gi, "</attached_file_");
}

export interface DownloadDeps {
  token: string;
  dir: string;
  /** PDF 에서 텍스트를 뽑는다. (샌드박스 컨테이너 또는 호스트) */
  extractPdfText(pdfPath: string): Promise<string>;
  fetchImpl?: typeof fetch;
}

/**
 * 봇 토큰(files:read)으로 파일을 내려받는다.
 * 권한이 없으면 Slack 이 로그인 HTML 을 200 으로 돌려주므로 Content-Type 으로 실패를 구분한다.
 */
export async function loadAttachments(
  planned: PlannedFile[],
  deps: DownloadDeps
): Promise<{ images: SavedImage[]; documents: LoadedDocument[]; failed: SkippedFile[] }> {
  await mkdir(deps.dir, { recursive: true });
  const fetchImpl = deps.fetchImpl ?? fetch;
  const images: SavedImage[] = [];
  const documents: LoadedDocument[] = [];
  const failed: SkippedFile[] = [];
  let remainingChars = LIMITS.charsTotal;

  for (const [index, item] of planned.entries()) {
    const name = displayName(item.file);
    try {
      const res = await fetchImpl(item.file.url_private_download!, {
        headers: { Authorization: `Bearer ${deps.token}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      const isHtmlFile = (item.file.filetype ?? "") === "html";
      if (type.startsWith("text/html") && !isHtmlFile) {
        throw new Error("파일 대신 로그인 페이지가 왔습니다 (files:read 권한 확인)");
      }
      const buffer = Buffer.from(await res.arrayBuffer());

      if (item.kind === "image") {
        if (!type.startsWith("image/")) throw new Error("이미지가 아닌 응답");
        if (buffer.length > LIMITS.imageBytes) throw new Error("크기 제한 초과");
        const mimetype = item.file.mimetype!;
        const filePath = path.join(
          deps.dir,
          safeFileName(index, item.file.name, IMAGE_TYPES[mimetype]!)
        );
        await writeFile(filePath, buffer);
        images.push({ path: filePath, mimetype, name, source: item.source });
        continue;
      }

      let text: string;
      if (item.kind === "pdf") {
        if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-")
          throw new Error("PDF 가 아닌 응답");
        const filePath = path.join(deps.dir, safeFileName(index, item.file.name, "pdf"));
        await writeFile(filePath, buffer);
        text = await deps.extractPdfText(filePath);
        if (!text.trim())
          throw new Error("PDF 에서 텍스트를 찾지 못했습니다 (스캔 이미지일 수 있음)");
      } else {
        if (buffer.length > LIMITS.textBytes) throw new Error("크기 제한 초과");
        if (!looksLikeText(buffer)) throw new Error("텍스트 파일이 아닙니다");
        text = buffer.toString("utf8");
      }
      if (remainingChars <= 0) throw new Error("전체 분량 제한 초과");
      const limit = Math.min(LIMITS.charsPerDocument, remainingChars);
      const content = text.length > limit ? text.slice(0, limit) : text;
      remainingChars -= content.length;
      documents.push({
        name,
        source: item.source,
        kind: item.kind,
        content,
        totalChars: text.length,
      });
    } catch (err) {
      failed.push({ name, reason: (err as Error).message });
    }
  }
  return { images, documents, failed };
}

/** 모델에 넘긴 첨부의 목록, 출처, 읽지 못한 첨부, 텍스트 내용을 프롬프트 조각으로 만든다. */
export function attachmentSection(
  images: Pick<SavedImage, "name" | "source">[],
  documents: LoadedDocument[],
  unreadable: SkippedFile[]
): string[] {
  if (images.length + documents.length + unreadable.length === 0) return [];
  const lines = ["", "<attachments>"];
  images.forEach((image, i) =>
    lines.push(`이미지 ${i + 1}: ${image.name} (${image.source})`)
  );
  documents.forEach((doc, i) => {
    const cut =
      doc.content.length < doc.totalChars
        ? `, 전체 ${doc.totalChars}자 중 앞 ${doc.content.length}자`
        : "";
    lines.push(
      `파일 ${i + 1}: ${doc.name} (${doc.source}, ${doc.kind === "pdf" ? "PDF 텍스트" : "텍스트"}${cut})`
    );
  });
  for (const file of unreadable)
    lines.push(`읽지 못한 첨부: ${file.name} - ${file.reason}`);
  lines.push("</attachments>");
  documents.forEach((doc, i) => {
    lines.push(
      "",
      `<attached_file index="${i + 1}" name="${doc.name.replace(/"/g, "'")}">`,
      escapeBoundary(doc.content),
      "</attached_file>"
    );
  });
  return lines;
}
