/**
 * What a desktop may do with the hub's Slack token. A desktop gets a grant for each mention routed to it (that
 * channel and thread), and its Slack calls must stay inside one: read that thread, post and edit in it, read and
 * upload its files. Calls the bot does not make are refused. (docs/team-hub.md)
 *
 * Arguments arrive as the Slack client sends them (form fields, nested values as JSON strings).
 */

/** How long a routed mention's grant lasts: enough for a long answer and its retries */
const GRANT_TTL_MS = 2 * 60 * 60_000;
/** conversations.history outside a thread reads only a few messages before the mention */
const MAX_HISTORY = 20;

export interface Grant {
  channel: string;
  /** thread_ts of the mention's thread, or the mention's ts when it is not in a thread */
  thread: string;
  /** The member who mentioned the bot (the desktop's owner) */
  user: string;
  /** Messages the desktop posted in the thread, which it may edit */
  messages: Set<string>;
  /** Files seen in the thread: id -> url_private_download */
  files: Map<string, string | undefined>;
  expiresAt: number;
}

/** The mention event fields the hub reads */
export interface MentionEvent {
  channel: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  files?: { id?: string; url_private_download?: string }[];
}

type Args = Record<string, string | undefined>;

export type Decision = { ok: true } | { ok: false; error: string };

const deny = (error: string): Decision => ({ ok: false, error });
const allow: Decision = { ok: true };

/** One desktop's grants and uploads */
export class Grants {
  private grants: Grant[] = [];
  /** File ids from files.getUploadURLExternal that the desktop may complete */
  private uploads = new Set<string>();

  constructor(
    private readonly now: () => number = Date.now,
    /** Where Slack serves files (slackFilesOrigin); downloads elsewhere are refused */
    private readonly filesOrigin = SLACK_FILES_ORIGIN
  ) {}

  /** Grants the thread of a mention routed to this desktop (or extends the grant it already has). */
  add(event: MentionEvent): Grant {
    this.prune();
    const thread = event.thread_ts ?? event.ts;
    let grant = this.find(event.channel, thread);
    if (!grant) {
      grant = {
        channel: event.channel,
        thread,
        user: event.user ?? "",
        messages: new Set(),
        files: new Map(),
        expiresAt: 0,
      };
      this.grants.push(grant);
    }
    grant.expiresAt = this.now() + GRANT_TTL_MS;
    this.addFiles(grant, event.files);
    return grant;
  }

  find(channel: string | undefined, thread?: string): Grant | undefined {
    const now = this.now();
    return this.grants.find(
      (g) =>
        g.expiresAt > now &&
        g.channel === channel &&
        (thread === undefined || g.thread === thread)
    );
  }

  /** The grant for exactly this thread. A call without a thread matches none, so it cannot reach the whole channel. */
  inThread(channel: string | undefined, thread: string | undefined): Grant | undefined {
    return thread ? this.find(channel, thread) : undefined;
  }

  /** Whether the desktop may download this file (url_private or url_private_download) */
  canDownload(url: string): boolean {
    const id = fileIdOf(url, this.filesOrigin);
    return Boolean(id && this.live().some((g) => g.files.has(id)));
  }

  authorize(method: string, args: Args): Decision {
    switch (method) {
      case "auth.test":
      case "users.info":
        return allow;
      case "conversations.info":
        return this.find(args.channel) ? allow : deny("channel_not_granted");
      case "conversations.replies":
        return this.inThread(args.channel, args.ts) ? allow : deny("thread_not_granted");
      case "conversations.history":
        // Only the messages just before a mention outside a thread: latest is the mention's ts.
        if (!this.inThread(args.channel, args.latest)) return deny("thread_not_granted");
        return Number(args.limit ?? "100") <= MAX_HISTORY
          ? allow
          : deny("limit_too_large");
      case "chat.postMessage":
        return this.inThread(args.channel, args.thread_ts)
          ? allow
          : deny("thread_not_granted");
      case "chat.update": {
        const ts = args.ts ?? "";
        const grant = this.live().find(
          (g) => g.channel === args.channel && g.messages.has(ts)
        );
        return grant ? allow : deny("message_not_granted");
      }
      case "chat.postEphemeral": {
        const grant = this.find(args.channel);
        return grant && grant.user === args.user ? allow : deny("user_not_granted");
      }
      case "files.info":
        return this.live().some((g) => g.files.has(args.file ?? ""))
          ? allow
          : deny("file_not_granted");
      case "files.getUploadURLExternal":
        return this.live().length > 0 ? allow : deny("no_active_thread");
      case "files.completeUploadExternal": {
        if (!this.inThread(args.channel_id, args.thread_ts))
          return deny("thread_not_granted");
        const ids = parseJson<{ id?: string }[]>(args.files)?.map((f) => f.id) ?? [];
        return ids.length > 0 && ids.every((id) => id && this.uploads.has(id))
          ? allow
          : deny("upload_not_granted");
      }
      default:
        return deny("method_not_allowed_by_hub");
    }
  }

  /** Records what a successful call adds to the grants: posted messages, files seen, upload ids. */
  observe(method: string, args: Args, response: Record<string, unknown>): void {
    if (response.ok !== true) return;
    switch (method) {
      case "chat.postMessage": {
        const grant = this.find(args.channel, args.thread_ts);
        if (grant && typeof response.ts === "string") grant.messages.add(response.ts);
        break;
      }
      case "conversations.replies":
      case "conversations.history": {
        const thread = method === "conversations.replies" ? args.ts : args.latest;
        const grant = this.find(args.channel, thread);
        const messages = (response.messages ?? []) as { files?: MentionEvent["files"] }[];
        if (grant) for (const message of messages) this.addFiles(grant, message.files);
        break;
      }
      case "files.info": {
        const file = response.file as
          { id?: string; url_private_download?: string } | undefined;
        for (const grant of this.live())
          if (file?.id && grant.files.has(file.id))
            grant.files.set(
              file.id,
              file.url_private_download ?? grant.files.get(file.id)
            );
        break;
      }
      case "files.getUploadURLExternal":
        if (typeof response.file_id === "string") this.uploads.add(response.file_id);
        break;
      case "files.completeUploadExternal":
        for (const f of parseJson<{ id?: string }[]>(args.files) ?? [])
          if (f.id) this.uploads.delete(f.id);
        break;
    }
  }

  private addFiles(grant: Grant, files: MentionEvent["files"]): void {
    for (const file of files ?? [])
      if (file.id) grant.files.set(file.id, file.url_private_download);
  }

  private live(): Grant[] {
    const now = this.now();
    return this.grants.filter((g) => g.expiresAt > now);
  }

  private prune(): void {
    this.grants = this.live();
  }
}

const SLACK_FILES_ORIGIN = "https://files.slack.com";

/** The file id in a Slack file URL: https://files.slack.com/files-pri/T123-F456/download/name.png -> F456 */
export function fileIdOf(
  url: string,
  filesOrigin = SLACK_FILES_ORIGIN
): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== filesOrigin) return undefined;
    return /^\/files-pri\/[A-Z0-9]+-([A-Z0-9]+)\//.exec(parsed.pathname)?.[1];
  } catch {
    return undefined;
  }
}

function parseJson<T>(value: string | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
