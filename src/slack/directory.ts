import type { WebClient } from "@slack/web-api";
import type { Logger } from "../logger.js";

const TTL_MS = 60 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;

export interface ChannelInfo {
  id: string;
  /** "#name" 형식의 표시 이름 */
  label: string;
  /** 공개 채널인지. 비공개 채널, DM, 그룹 DM 은 false */
  isPublic: boolean;
}

interface CacheEntry<T> {
  value: Promise<T>;
  expiresAt: number;
}

/** 사용자/채널 정보를 짧게 캐시해서 조회한다. 실패하면 ID 를 그대로 쓴다. */
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
      // 조회에 실패하면 공개 채널로 단정하지 않는다.
      { id: channelId, label: channelId, isPublic: false }
    );
  }

  private cached<T>(key: string, load: () => Promise<T>, fallback: T): Promise<T> {
    const hit = this.cache.get(key) as CacheEntry<T> | undefined;
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const value: Promise<T> = load().catch((err: unknown) => {
      this.log.warn(`조회 실패 ${key}: ${(err as Error).message}`);
      // 실패는 짧게만 캐시해서 다음 요청에서 다시 시도한다.
      this.cache.set(key, { value, expiresAt: Date.now() + FAILURE_TTL_MS });
      return fallback;
    });
    this.cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  }
}
