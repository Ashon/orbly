import { randomBytes, randomInt } from "node:crypto";
import type { HubUser, PairStartResponse, PairStatus } from "./protocol.js";

/** Codes use letters and digits that are hard to mix up (no 0/O, 1/I/L). */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** How long a member has to send the code in Slack and confirm it in the app */
export const PAIRING_TTL_MS = 10 * 60_000;

interface Pending {
  pairingId: string;
  code: string;
  tokenHash: string;
  label: string;
  expiresAt: number;
  /** The Slack member who sent the code */
  user?: HubUser;
}

/** "abcd 2345" or "ABCD2345" -> "ABCD-2345" */
export function normalizeCode(code: string): string {
  const raw = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

/**
 * Pairings in progress, kept in memory (a hub restart only cancels pairings that have not been confirmed).
 * 1. start: the desktop sends its token's hash and gets a code
 * 2. bind: a member sends "@Pacey connect <code>" in Slack
 * 3. confirm: the desktop, shown who sent it, confirms with the token itself
 * A code binds to the first member who sends it, and the desktop's confirmation is what makes it count, so a code
 * someone else saw and sent first is turned down on the desktop.
 */
export class Pairings {
  private pending = new Map<string, Pending>();

  constructor(private readonly now: () => number = Date.now) {}

  start(tokenHash: string, label: string): PairStartResponse {
    this.prune();
    let code: string;
    do {
      code = normalizeCode(
        Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")
      );
    } while ([...this.pending.values()].some((p) => p.code === code));
    const pairingId = randomBytes(16).toString("hex");
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.pending.set(pairingId, { pairingId, code, tokenHash, label, expiresAt });
    return { pairingId, code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** A member sent a code in Slack. Returns the desktop's label when the code binds. */
  bind(
    code: string,
    user: HubUser
  ): { result: "bound"; label: string } | { result: "unknown" | "taken" } {
    this.prune();
    const pending = [...this.pending.values()].find(
      (p) => p.code === normalizeCode(code)
    );
    if (!pending) return { result: "unknown" };
    if (pending.user && pending.user.id !== user.id) return { result: "taken" };
    pending.user = user;
    return { result: "bound", label: pending.label };
  }

  status(pairingId: string): PairStatus {
    this.prune();
    const pending = this.pending.get(pairingId);
    if (!pending) return { status: "expired" };
    return pending.user ? { status: "bound", user: pending.user } : { status: "pending" };
  }

  /** The desktop confirms with its token (checked against the hash it started with). Ends the pairing. */
  confirm(
    pairingId: string,
    tokenHash: string
  ): { user: HubUser; label: string } | undefined {
    this.prune();
    const pending = this.pending.get(pairingId);
    if (!pending?.user || pending.tokenHash !== tokenHash) return undefined;
    this.pending.delete(pairingId);
    return { user: pending.user, label: pending.label };
  }

  cancel(pairingId: string): void {
    this.pending.delete(pairingId);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, pending] of this.pending)
      if (pending.expiresAt <= now) this.pending.delete(id);
  }
}
