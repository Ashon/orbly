import { pathToFileURL } from "node:url";
import { checkSlackTokens } from "../slack/check.js";

export { missingScopes, REQUIRED_BOT_SCOPES } from "../slack/check.js";

/** .env 의 토큰으로 Slack 앱 설정이 이 봇에 맞는지 점검한다. 메시지는 보내지 않는다. */
async function main(): Promise<void> {
  const items = await checkSlackTokens({
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
  });
  for (const item of items) {
    console.log(
      `${item.ok ? "OK  " : "FAIL"} ${item.label}${item.detail ? `: ${item.detail}` : ""}`
    );
  }
  console.log(
    "\n봇 이벤트 app_mention 구독은 API 로 확인할 수 없어 앱 설정 화면(Event Subscriptions)에서 확인합니다."
  );
  process.exitCode = items.every((item) => item.ok) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
