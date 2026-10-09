import { pathToFileURL } from "node:url";
import { loadEnv } from "../settings/load-env.js";
import { checkSlackTokens } from "../messengers/slack/check.js";

export { missingScopes, REQUIRED_BOT_SCOPES } from "../messengers/slack/check.js";

/** Checks with the .env tokens that the Slack app settings fit this bot. Sends no messages. */
async function main(): Promise<void> {
  for (const warning of loadEnv()) console.warn(`WARN ${warning}`);
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
    "\nThe app_mention bot event subscription cannot be checked through the API. Check it in the app settings (Event Subscriptions)."
  );
  process.exitCode = items.every((item) => item.ok) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
