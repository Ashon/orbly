import type { WebClient } from "@slack/web-api";
import { DEFAULT_SLACK_API_URL } from "../messengers/slack/api.js";
import type { SlackGateway } from "./server.js";

/** The hub's Slack calls, made with the bot token. The token never leaves this process. */
export function slackGateway(
  botToken: string,
  client: WebClient,
  apiUrl = DEFAULT_SLACK_API_URL,
  fetchImpl: typeof fetch = fetch
): SlackGateway {
  const auth = { Authorization: `Bearer ${botToken}` };
  return {
    async call(method, body, contentType) {
      const res = await fetchImpl(`${apiUrl}${method}`, {
        method: "POST",
        headers: { ...auth, "Content-Type": contentType },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      const json = (await res
        .json()
        .catch(() => ({ ok: false, error: "invalid_response" }))) as Record<
        string,
        unknown
      >;
      return {
        status: res.status,
        json,
        retryAfter: res.headers.get("retry-after") ?? undefined,
      };
    },
    download: (url) =>
      fetchImpl(url, { headers: auth, signal: AbortSignal.timeout(120_000) }),
    upload: (url, body, contentType) =>
      fetchImpl(url, {
        method: "POST",
        headers: { ...auth, ...(contentType ? { "Content-Type": contentType } : {}) },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(120_000),
      }),
    async postEphemeral(channel, user, text, threadTs) {
      await client.chat.postEphemeral({ channel, user, text, thread_ts: threadTs });
    },
    async userName(userId) {
      const res = await client.users.info({ user: userId });
      const user = res.user;
      return user?.profile?.display_name || user?.real_name || user?.name || userId;
    },
  };
}
