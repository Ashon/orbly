import path from "node:path";
import { App, SocketModeReceiver } from "@slack/bolt";
import { consoleSink, createLogger } from "../logger.js";
import { slackLogger } from "../slack/logger.js";
import { loadHubConfig } from "./config.js";
import { slackGateway } from "./gateway.js";
import { Pairings } from "./pairing.js";
import { HubServer } from "./server.js";
import { DesktopStore } from "./store.js";

/**
 * Orbly team hub (README "Team hub"). Holds the Slack app's Socket Mode connection and tokens, and routes each
 * member's mentions to their own Orbly desktop, which connects here. Runs as a container on a server of its own
 * (deploy/hub), behind HTTPS.
 */
async function main(): Promise<void> {
  const config = loadHubConfig(process.env);
  const log = createLogger(config.logLevel, "hub", [consoleSink]);
  const receiver = new SocketModeReceiver({
    appToken: config.appToken,
    logger: slackLogger(log.child("socket"), config.logLevel),
  });
  const app = new App({
    token: config.botToken,
    receiver,
    logger: slackLogger(log.child("bolt"), config.logLevel),
  });
  const auth = await app.client.auth.test();
  const team = { id: auth.team_id ?? "", name: auth.team ?? "" };

  const hub = new HubServer({
    store: new DesktopStore(path.join(config.dataDir, "desktops.json")),
    pairings: new Pairings(),
    slack: slackGateway(config.botToken, app.client),
    team,
    allowedUsers: config.allowedUsers,
    publicUrl: config.publicUrl,
    log,
  });
  app.event("app_mention", async ({ body }) => {
    await hub.handleMention(body as unknown as Record<string, unknown>);
  });
  app.error(async (err) => {
    log.error("Slack event handling error", err);
  });

  await app.start();
  const port = await hub.listen(config.port, config.host);
  log.info(
    `Hub started: bot=${auth.user} @ ${team.name} (${team.id}), listening on ${config.host}:${port}, ` +
      `allowed members=${config.allowedUsers.length > 0 ? config.allowedUsers.length : "all"}`
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`Received ${signal}, shutting down.`);
    await hub.close();
    await app.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const fail = (err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
};
// A failure inside the Slack client's own startup should end the hub with a message, not a stack dump.
process.on("unhandledRejection", fail);
main().catch(fail);
