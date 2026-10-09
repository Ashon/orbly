import type { WebClient } from "@slack/web-api";
import type { Logger } from "../logger.js";

const TTL_MS = 60 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;

export interface ChannelInfo {
  id: string;
  /** Display name in "#name" form */
  label: string;
  /** Whether this is a public channel. false for private channels, DMs, and group DMs */
  isPublic: boolean;
}

interface CacheEntry<T> {
  value: Promise<T>;
  expiresAt: number;
}

/** Looks up user/channel info with a short cache. Falls back to the ID on failure. */
export class Directory {
  private readonly cache = new Map<string, CacheEntry<unknown>>();

  constructor(
    private readonly client: WebClient,
    private readonly log: Logger
  ) {}

  userName(userId: string): Promise<string> {
    return this.cached(
      `user:${userId}`,
      async () => {
        const res = await this.client.users.info({ user: userId });
        const user = res.user;
        return user?.profile?.display_name || user?.real_name || user?.name || userId;
      },
      userId
    );
  }

  async userNames(userIds: Iterable<string>): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    const names = await Promise.all(ids.map((id) => this.userName(id)));
    return new Map(ids.map((id, i) => [id, names[i]!]));
  }

  channel(channelId: string): Promise<ChannelInfo> {
    return this.cached(
      `channel:${channelId}`,
      async () => {
        const res = await this.client.conversations.info({ channel: channelId });
        const channel = res.channel;
        return {
          id: channelId,
          label: `#${channel?.name ?? channelId}`,
          isPublic: Boolean(
            channel?.is_channel &&
            !channel.is_private &&
            !channel.is_im &&
            !channel.is_mpim
          ),
        };
      },
      // If the lookup fails, does not assume a public channel.
      { id: channelId, label: channelId, isPublic: false }
    );
  }

  private cached<T>(key: string, load: () => Promise<T>, fallback: T): Promise<T> {
    const hit = this.cache.get(key) as CacheEntry<T> | undefined;
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const value: Promise<T> = load().catch((err: unknown) => {
      this.log.warn(`Lookup failed for ${key}: ${(err as Error).message}`);
      // Failures are cached only briefly so the next request tries again.
      this.cache.set(key, { value, expiresAt: Date.now() + FAILURE_TTL_MS });
      return fallback;
    });
    this.cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  }
}
