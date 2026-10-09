import type { Config } from "../../config.js";
import type { Download, MessageFile } from "../types.js";

/** A file as Slack describes it in events, conversations.* and files.info */
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

const EXTERNAL = "External files (Google Drive, etc.) cannot be read";
const NO_URL = "No download URL (files:read scope or file access restriction)";

/** When the event's file info arrives as a summary without a URL, it must be looked up again with files.info. */
export function needsFileInfo(file: SlackFileRef): boolean {
  return (
    file.file_access === "check_file_info" || !file.url_private_download || !file.mimetype
  );
}

export function toMessageFile(file: SlackFileRef): MessageFile {
  return {
    id: file.id,
    name: file.name ?? file.title ?? file.id ?? "file",
    mimetype: file.mimetype,
    filetype: file.filetype,
    snippet: file.mode === "snippet" || undefined,
    size: file.size,
    handle: file.url_private_download,
    partial: needsFileInfo(file) || undefined,
    unreadable: file.is_external ? EXTERNAL : undefined,
  };
}

/** A file that still has no download URL after the lookup cannot be read. */
export function settle(file: MessageFile): MessageFile {
  return file.handle || file.unreadable ? file : { ...file, unreadable: NO_URL };
}

/** How files are downloaded: with the bot token, or through the hub with this desktop's hub token */
export interface SlackFileAccess {
  token: string;
  /** With the team hub, files are fetched through it (GET <hub>/files?url=...) */
  hubUrl?: string;
}

export function slackFileAccess(slack: Config["slack"]): SlackFileAccess {
  return slack.kind === "hub"
    ? { token: slack.hubToken, hubUrl: slack.hubUrl }
    : { token: slack.botToken };
}

/**
 * Downloads a file with the bot token (files:read). Without permission Slack returns a login HTML page with 200, so
 * that failure is detected by its Content-Type.
 */
export async function downloadSlackFile(
  file: MessageFile,
  access: SlackFileAccess,
  fetchImpl: typeof fetch = fetch
): Promise<Download> {
  if (!file.handle) throw new Error(NO_URL);
  const res = await fetchImpl(
    access.hubUrl
      ? `${access.hubUrl}/files?url=${encodeURIComponent(file.handle)}`
      : file.handle,
    {
      headers: { Authorization: `Bearer ${access.token}` },
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.startsWith("text/html") && file.filetype !== "html") {
    throw new Error("Got a login page instead of the file (check the files:read scope)");
  }
  return { contentType, data: Buffer.from(await res.arrayBuffer()) };
}
