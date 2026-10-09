import type { AppMentionEvent } from "@slack/types";
import type { WebClient } from "@slack/web-api";
import type { Logger } from "../../logger.js";
import type {
  ContextMessage,
  Download,
  Mention,
  MessageFile,
  Messenger,
  MessengerProfile,
  Request,
  Upload,
  Venue,
} from "../types.js";
import type { Directory } from "./directory.js";
import {
  downloadSlackFile,
  settle,
  toMessageFile,
  type SlackFileAccess,
  type SlackFileRef,
} from "./files.js";
import { chunkText } from "../text.js";
import {
  extractUserIds,
  renderSlackText,
  SLACK_CHUNK_LIMIT,
  slackPermalink,
  stripBotMention,
  toSlackMrkdwn,
} from "./format.js";

/** Messages before a mention outside a thread, for context */
const ROOT_CONTEXT_MESSAGES = 10;
/** Thread replies read for context */
const THREAD_CONTEXT_MESSAGES = 100;
/** Files looked up again with files.info per request */
const MAX_FILE_LOOKUPS = 10;

export interface SlackMessengerOptions {
  client: WebClient;
  directory: Directory;
  botUserId: string;
  /** Workspace URL (https://xxx.slack.com/), for message links in the run history */
  workspaceUrl?: string;
  files: SlackFileAccess;
  allowedUsers: readonly string[];
  log: Logger;
  fetchImpl?: typeof fetch;
}

/** Slack through the Web API: the bot's own app (Socket Mode), or the team hub relaying the same calls. */
export class SlackMessenger implements Messenger {
  readonly id = "slack";
  readonly profile: MessengerProfile = {
    name: "Slack",
    venues: "public channels",
    markup: "Slack mrkdwn",
    public: true,
  };
  readonly allowedUsers: readonly string[];

  constructor(private readonly options: SlackMessengerOptions) {
    this.allowedUsers = options.allowedUsers;
  }

  /** An app_mention event as a Mention. None for mentions the bot does not answer: from other bots and integrations. */
  static mention(event: AppMentionEvent): Mention | undefined {
    if (!event.user || event.bot_id) return undefined;
    return {
      messenger: "slack",
      conversation: event.channel,
      message: event.ts,
      thread: event.thread_ts ?? event.ts,
      inThread: Boolean(event.thread_ts),
      userId: event.user,
      text: event.text,
      files: ((event.files ?? []) as SlackFileRef[]).map(toMessageFile),
    };
  }

  async venue(mention: Mention): Promise<Venue> {
    const channel = await this.options.directory.channel(mention.conversation);
    return channel.isPublic
      ? { label: channel.label, answerable: true }
      : {
          label: channel.label,
          answerable: false,
          refusal: "This bot only answers in public channels.",
        };
  }

  async request(mention: Mention): Promise<Request> {
    const names = await this.options.directory.userNames([
      mention.userId,
      ...extractUserIds(mention.text),
    ]);
    return {
      text: renderSlackText(stripBotMention(mention.text, this.options.botUserId), names),
      author: this.author(mention.userId, names),
      userName: names.get(mention.userId),
    };
  }

  /** The whole thread inside a thread, or the last few messages outside one */
  async context(mention: Mention, exclude: readonly string[]): Promise<ContextMessage[]> {
    const { client, directory, log } = this.options;
    try {
      const res = mention.inThread
        ? await client.conversations.replies({
            channel: mention.conversation,
            ts: mention.thread,
            limit: THREAD_CONTEXT_MESSAGES,
          })
        : await client.conversations.history({
            channel: mention.conversation,
            latest: mention.message,
            inclusive: false,
            limit: ROOT_CONTEXT_MESSAGES,
          });
      const messages = (res.messages ?? [])
        .filter((m) => m.ts && !exclude.includes(m.ts) && (m.text || m.files?.length))
        .sort((a, b) => Number(a.ts) - Number(b.ts));
      const names = await directory.userNames(
        messages.flatMap((m) => [
          ...(m.user ? [m.user] : []),
          ...extractUserIds(m.text ?? ""),
        ])
      );
      return messages.map((m) => ({
        id: m.ts!,
        at: Number(m.ts) * 1000,
        author: this.author(m.user, names),
        text: renderSlackText(m.text ?? "", names),
        files: ((m.files ?? []) as SlackFileRef[]).map(toMessageFile),
      }));
    } catch (err) {
      log.warn(`Failed to load conversation context: ${(err as Error).message}`);
      return [];
    }
  }

  /** Fills in files that arrived as a summary (file_access=check_file_info, etc.) with files.info. */
  async resolveFiles(files: MessageFile[]): Promise<MessageFile[]> {
    const { client, log } = this.options;
    let lookups = 0;
    const resolved: MessageFile[] = [];
    for (const file of files) {
      if (!file.partial || !file.id || lookups >= MAX_FILE_LOOKUPS) {
        resolved.push(settle(file));
        continue;
      }
      lookups += 1;
      try {
        const res = await client.files.info({ file: file.id });
        resolved.push(
          settle(toMessageFile({ name: file.name, ...(res.file as SlackFileRef) }))
        );
      } catch (err) {
        log.warn(`files.info failed for ${file.id}: ${(err as Error).message}`);
        resolved.push(settle(file));
      }
    }
    return resolved;
  }

  download(file: MessageFile): Promise<Download> {
    return downloadSlackFile(file, this.options.files, this.options.fetchImpl);
  }

  async notice(mention: Mention, text: string): Promise<void> {
    await this.options.client.chat
      .postEphemeral({
        channel: mention.conversation,
        user: mention.userId,
        text,
        thread_ts: mention.inThread ? mention.thread : undefined,
      })
      .catch((err: unknown) =>
        this.options.log.warn(`Failed to send notice: ${(err as Error).message}`)
      );
  }

  async post(mention: Mention, text: string): Promise<string> {
    const res = await this.options.client.chat.postMessage({
      channel: mention.conversation,
      thread_ts: mention.thread,
      text,
    });
    return res.ts!;
  }

  async update(mention: Mention, message: string, text: string): Promise<void> {
    await this.options.client.chat.update({
      channel: mention.conversation,
      ts: message,
      text,
    });
  }

  async upload(mention: Mention, files: Upload[]): Promise<void> {
    await this.options.client.files.uploadV2({
      channel_id: mention.conversation,
      thread_ts: mention.thread,
      file_uploads: files.map(({ data, filename, title }) => ({
        file: data,
        filename,
        title,
      })),
    });
  }

  render(markdown: string): string[] {
    return chunkText(toSlackMrkdwn(markdown), SLACK_CHUNK_LIMIT);
  }

  permalink(mention: Mention, message: string): string | undefined {
    const { workspaceUrl } = this.options;
    return workspaceUrl
      ? slackPermalink(workspaceUrl, mention.conversation, message, mention.thread)
      : undefined;
  }

  private author(userId: string | undefined, names: Map<string, string>): string {
    if (!userId) return "(bot)";
    const bot = userId === this.options.botUserId ? " (bot)" : "";
    return `@${names.get(userId) ?? userId}${bot}`;
  }
}
