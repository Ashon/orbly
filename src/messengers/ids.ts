/** The chat apps the bot can answer in. Has no Node APIs, so the desktop UI imports it too. */
export const MESSENGER_IDS = ["slack"] as const;

export type MessengerId = (typeof MESSENGER_IDS)[number];

/** What the screens call each one */
export const MESSENGER_NAMES: Record<MessengerId, string> = {
  slack: "Slack",
};
