/**
 * protocol.ts — Pure role-switch request protocol definitions.
 *
 * This module is intentionally dependency-free from pi-roles runtime state
 * (no imports from index.ts, apply.ts, roles.ts, etc.). Trigger extensions
 * import from "pi-roles/protocol" to write switch-requests into the session
 * log. pi-roles consumes those requests in its own before_agent_start handler.
 *
 * The protocol is two entries:
 *   1. pi-roles:switch-request   — trigger writes; pi-roles reads
 *   2. pi-roles:switch-processed — pi-roles writes after applying the role
 *      (idempotency marker, keyed on the request entry's id)
 */

import { Type } from "typebox";

// ── Entry-type constants ──

/** Custom entry type for trigger extensions to request a role switch. */
export const ROLE_SWITCH_REQUEST_ENTRY_TYPE = "pi-roles:switch-request" as const;

/** Custom entry type pi-roles writes after consuming a request. */
export const ROLE_SWITCH_PROCESSED_TYPE = "pi-roles:switch-processed" as const;

// ── Payload schema ──

export const RoleSwitchRequest = Type.Object({
  /** Name of the target role (e.g. "pi-agent"). Must exist in the role registry. */
  targetRole: Type.String(),
  /** Human-readable reason for the switch (e.g. "plannotator:plan-approved", "prompt:plan-fork-customization"). */
  reason: Type.String(),
  /** Optional id of the triggering session entry, for deduplication. */
  sourceEntryId: Type.Optional(Type.String()),
  /** Unix epoch milliseconds when the request was written. */
  timestamp: Type.Number(),
});
export type RoleSwitchRequest = {
  targetRole: string;
  reason: string;
  sourceEntryId?: string;
  timestamp: number;
};

/** Payload written in the pi-roles:switch-processed marker entry. */
export interface SwitchProcessedPayload {
  sourceEntryId: string;
  timestamp: number;
}

// ── Pure helpers ──

/**
 * Write a role-switch request to the session log. Trigger extensions call
 * this with their ExtensionAPI instance.
 *
 * Does NOT touch pi-roles' runtime state — this is purely a log write.
 * pi-roles consumes the request in its own `before_agent_start` handler,
 * which is where the actual role application happens (applyResolved).
 */
export function writeRoleSwitchRequest(
  pi: { appendEntry: (customType: string, data?: unknown) => void },
  req: { targetRole: string; reason: string; sourceEntryId?: string },
): void {
  pi.appendEntry(ROLE_SWITCH_REQUEST_ENTRY_TYPE, {
    targetRole: req.targetRole,
    reason: req.reason,
    sourceEntryId: req.sourceEntryId,
    timestamp: Date.now(),
  } satisfies RoleSwitchRequest);
}

/**
 * Scan session entries (newest-first) for an unprocessed
 * `pi-roles:switch-request`.
 *
 * "Unprocessed" means there is no subsequent `pi-roles:switch-processed`
 * entry with a matching `sourceEntryId`.
 *
 * Returns `{ entry, data }` for the latest unprocessed request, or `null`.
 */
export function findUnprocessedSwitchRequest(
  entries: ReadonlyArray<{
    type: string;
    customType?: string;
    data?: unknown;
    id: string;
  }>,
): { entry: { id: string }; data: RoleSwitchRequest } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.type !== "custom" || e.customType !== ROLE_SWITCH_REQUEST_ENTRY_TYPE) continue;

    const data = (e.data ?? {}) as RoleSwitchRequest;
    if (typeof data.targetRole !== "string" || !data.targetRole) continue;

    // Check if this request has already been processed.
    const processed = entries
      .slice(i + 1)
      .some(
        (p) =>
          p &&
          p.type === "custom" &&
          p.customType === ROLE_SWITCH_PROCESSED_TYPE &&
          ((p.data as SwitchProcessedPayload | undefined)?.sourceEntryId === e.id),
      );

    if (!processed) {
      return { entry: { id: e.id }, data };
    }
  }
  return null;
}