/** slack-app-manifest.yaml 의 oauth_config.scopes.bot 과 같아야 한다. (tests/slack-check.test.ts) */
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
 * 토큰으로 Slack 앱 설정이 이 봇에 맞는지 점검한다. 메시지는 보내지 않는다.
 * - 봇 토큰(auth.test), 봇 스코프, 앱 토큰과 봇이 같은 앱인지(bots.info), Socket Mode(apps.connections.open)
 * apps.connections.open 은 접속 주소만 받고 연결하지 않는다. (주소는 버린다)
 */
export async function checkSlackTokens(
  tokens: { botToken?: string; appToken?: string },
  fetchImpl: typeof fetch = fetch
): Promise<SlackCheckItem[]> {
  const items: SlackCheckItem[] = [];
  const { botToken, appToken } = tokens;
  if (!botToken || !appToken) {
    return [{ label: "토큰", ok: false, detail: "봇 토큰과 앱 토큰이 모두 필요합니다." }];
  }
  const failure = (err: unknown) => (err as Error).message;

  let botId: string | undefined;
  try {
    const { body, headers } = await call(fetchImpl, "auth.test", botToken);
    if (!body.ok) {
      items.push({ label: "봇 토큰", ok: false, detail: body.error });
    } else {
      botId = body.bot_id as string | undefined;
      items.push({
        label: "봇 토큰",
        ok: true,
        detail: `${String(body.user)} (${String(body.user_id)}) @ ${String(body.team)}`,
      });
      const granted = (headers.get("x-oauth-scopes") ?? "")
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean);
      const missing = missingScopes(REQUIRED_BOT_SCOPES, granted);
      items.push({
        label: "봇 스코프",
        ok: missing.length === 0,
        detail: missing.length ? `없음: ${missing.join(", ")}` : undefined,
      });
    }
  } catch (err) {
    items.push({ label: "봇 토큰", ok: false, detail: failure(err) });
  }

  const appIdFromToken = appToken.split("-")[2];
  if (botId) {
    try {
      const { body } = await call(fetchImpl, "bots.info", botToken, { bot: botId });
      const appId = (body.bot as { app_id?: string } | undefined)?.app_id;
      items.push({
        label: "같은 앱",
        ok: body.ok && appId === appIdFromToken,
        detail: `봇=${appId ?? "?"}, 앱 토큰=${appIdFromToken ?? "?"}`,
      });
    } catch (err) {
      items.push({ label: "같은 앱", ok: false, detail: failure(err) });
    }
  }

  try {
    const { body } = await call(fetchImpl, "apps.connections.open", appToken);
    items.push({
      label: "Socket Mode",
      ok: body.ok,
      detail: body.ok ? "접속 주소 발급됨 (연결은 하지 않음)" : body.error,
    });
  } catch (err) {
    items.push({ label: "Socket Mode", ok: false, detail: failure(err) });
  }
  return items;
}
