/**
 * The reasoner CLIs Pacenote can run. Has no Node APIs, so the desktop UI
 * imports it too.
 */
export const REASONER_IDS = ['claude', 'codex'] as const

export type ReasonerId = (typeof REASONER_IDS)[number]
