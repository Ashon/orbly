import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** 경로 조각 중 하나라도 해당하면 제외하는 디렉터리 */
const DENY_DIRS = new Set([
  ".git",
  ".venv",
  "venv",
  "node_modules",
  ".terraform",
  "__pycache__",
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
]);

/** 파일 이름 기준 제외 규칙. 비밀이 들어 있을 가능성이 높은 형식 */
const DENY_FILES: RegExp[] = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|tfstate|tfstate\.backup)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/i,
  /kubeconfig/i,
  /admin\.conf$/i,
  /^\.?(credentials|netrc|npmrc|pypirc)$/i,
  /secret/i,
  /vault[^/]*\.ya?ml$/i,
  /\.token$/i,
];
const ALLOWED_DESPITE_DENY: RegExp[] = [/^\.env\.example$/i];

export const MAX_READ_LINES = 400;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 2_000;
const MAX_LIST_ENTRIES = 300;

/** 루트 기준 상대 경로가 제외 규칙에 걸리는지 */
export function isDenied(relativePath: string): boolean {
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.some((part) => DENY_DIRS.has(part))) return true;
  const base = parts.at(-1) ?? "";
  if (ALLOWED_DESPITE_DENY.some((pattern) => pattern.test(base))) return false;
  return DENY_FILES.some((pattern) => pattern.test(base));
}

/** ripgrep 에 넘길 제외 glob 목록 (isDenied 와 같은 규칙) */
export const RG_EXCLUDE_GLOBS = [
  ...[...DENY_DIRS].map((dir) => `!**/${dir}/**`),
  "!**/.env",
  "!**/.env.*",
  "!**/*.{pem,key,p12,pfx,jks,keystore,kdbx,tfstate,token}",
  "!**/id_rsa*",
  "!**/id_ed25519*",
  "!**/id_ecdsa*",
  "!**/*kubeconfig*",
  "!**/*admin.conf",
  "!**/*secret*",
  "!**/*vault*.y*ml",
  "!**/credentials",
];

/**
 * 모델이 준 경로를 루트 안의 실제 경로로 바꾼다. 절대 경로, 상위 이동, 루트 밖을 가리키는
 * 심볼릭 링크, 제외 대상은 거부한다.
 */
export async function resolveInRoot(root: string, requested: string): Promise<string> {
  let target = requested.trim() || ".";
  if (path.isAbsolute(target)) {
    // 루트 아래 절대 경로(/workspace/...)는 상대 경로로 바꿔 받는다.
    const fromRoot = path.relative(root, target);
    if (fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) {
      throw new Error(
        "경로는 작업 루트 기준 상대 경로로 지정하세요. (예: my-repo/README.md)"
      );
    }
    target = fromRoot || ".";
  }
  const joined = path.resolve(root, target);
  const rel = path.relative(root, joined);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error("작업 루트 밖은 볼 수 없습니다.");
  if (rel && isDenied(rel)) throw new Error(`접근이 제한된 경로입니다: ${rel}`);

  const real = await realpath(joined).catch(() => {
    throw new Error(`경로가 없습니다: ${rel || "."}`);
  });
  const realRoot = await realpath(root);
  const realRel = path.relative(realRoot, real);
  if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
    throw new Error("작업 루트 밖을 가리키는 링크입니다.");
  }
  if (realRel && isDenied(realRel))
    throw new Error(`접근이 제한된 경로입니다: ${realRel}`);
  return real;
}

export async function listDir(root: string, requested: string): Promise<string> {
  const dir = await resolveInRoot(root, requested);
  const entries = await readdir(dir, { withFileTypes: true });
  const relDir = path.relative(await realpath(root), dir);
  const lines = entries
    .filter((entry) => !isDenied(path.join(relDir, entry.name)))
    .sort(
      (a, b) =>
        Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
    )
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  const shown = lines.slice(0, MAX_LIST_ENTRIES);
  const more =
    lines.length > shown.length ? `\n... (${lines.length - shown.length}개 더)` : "";
  return `${relDir || "."}/\n${shown.join("\n")}${more}`;
}

export async function readText(
  root: string,
  requested: string,
  offset = 1,
  limit = MAX_READ_LINES
): Promise<string> {
  const file = await resolveInRoot(root, requested);
  const info = await stat(file);
  if (!info.isFile()) throw new Error("파일이 아닙니다. 디렉터리는 fs_list 를 쓰세요.");
  if (info.size > MAX_FILE_BYTES)
    throw new Error(`파일이 너무 큽니다 (${info.size} bytes).`);
  const buffer = await readFile(file);
  if (buffer.subarray(0, 8192).includes(0))
    throw new Error("바이너리 파일은 읽지 않습니다.");

  const all = buffer.toString("utf8").split("\n");
  const start = Math.max(1, offset);
  const count = Math.min(Math.max(1, limit), MAX_READ_LINES);
  const slice = all.slice(start - 1, start - 1 + count);
  const body = slice
    .map(
      (line, i) =>
        `${start + i}\t${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line}`
    )
    .join("\n");
  const end = start - 1 + slice.length;
  const tail =
    end < all.length
      ? `\n... (전체 ${all.length}줄 중 ${start}-${end}줄, offset 으로 이어서 읽기)`
      : "";
  return `${path.relative(await realpath(root), file)}\n${body}${tail}`;
}
