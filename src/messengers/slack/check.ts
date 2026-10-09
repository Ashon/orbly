/** Must match oauth_config.scopes.bot in slack-app-manifest.yaml. (tests/slack-check.test.ts) */
export const REQUIRED_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "files:read",
  "files:write",
  "users:read",
] as const;

export function missingScopes(required: readonly string[], granted: readonly string[]) {
  return required.filter((scope) => !granted.includes(scope));
}

export interface SlackCheckItem {
  label: string;
  ok: boolean;
  detail?: string;
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

async function call(
  fetchImpl: typeof fetch,
  method: string,
  token: string,
  params: Record<string, string> = {}
): Promise<{ body: SlackResponse; headers: Headers }> {
  const res = await fetchImpl(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { body: (await res.json()) as SlackResponse, headers: res.headers };
}

/**
 * Checks with the tokens that the Slack app settings fit this bot. Sends no messages.
 * - Bot token (auth.test), bot scopes, whether the app token and the bot belong to the same app (bots.info), Socket Mode (apps.connections.open)
 * apps.connections.open only obtains a connection URL and does not connect. (the URL is discarded)
 */
export async function checkSlackTokens(
  tokens: { botToken?: string; appToken?: string },
  fetchImpl: typeof fetch = fetch
): Promise<SlackCheckItem[]> {
  const items: SlackCheckItem[] = [];
  const { botToken, appToken } = tokens;
  if (!botToken || !appToken) {
    return [
      {
        label: "Tokens",
        ok: false,
        detail: "Both the bot token and the app token are required.",
      },
    ];
  }
  const failure = (err: unknown) => (err as Error).message;

  let botId: string | undefined;
  try {
    const { body, headers } = await call(fetchImpl, "auth.test", botToken);
    if (!body.ok) {
      items.push({ label: "Bot token", ok: false, detail: body.error });
    } else {
      botId = body.bot_id as string | undefined;
      items.push({
        label: "Bot token",
        ok: true,
        detail: `${String(body.user)} (${String(body.user_id)}) @ ${String(body.team)}`,
      });
      const granted = (headers.get("x-oauth-scopes") ?? "")
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean);
      const missing = missingScopes(REQUIRED_BOT_SCOPES, granted);
      items.push({
        label: "Bot scopes",
        ok: missing.length === 0,
        detail: missing.length ? `Missing: ${missing.join(", ")}` : undefined,
      });
    }
  } catch (err) {
    items.push({ label: "Bot token", ok: false, detail: failure(err) });
  }

  const appIdFromToken = appToken.split("-")[2];
  if (botId) {
    try {
      const { body } = await call(fetchImpl, "bots.info", botToken, { bot: botId });
      const appId = (body.bot as { app_id?: string } | undefined)?.app_id;
      items.push({
        label: "Same app",
        ok: body.ok && appId === appIdFromToken,
        detail: `bot=${appId ?? "?"}, app token=${appIdFromToken ?? "?"}`,
      });
    } catch (err) {
      items.push({ label: "Same app", ok: false, detail: failure(err) });
    }
  }

  try {
    const { body } = await call(fetchImpl, "apps.connections.open", appToken);
    items.push({
      label: "Socket Mode",
      ok: body.ok,
      detail: body.ok ? "Connection URL issued (not connected)" : body.error,
    });
  } catch (err) {
    items.push({ label: "Socket Mode", ok: false, detail: failure(err) });
  }
  return items;
}
