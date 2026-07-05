/**
 * Tests for src/protocol.ts — the role-switch request protocol.
 *
 * Covers:
 *   (a) findUnprocessedSwitchRequest returns latest unprocessed
 *   (b) processed request is skipped
 *   (c) multiple requests → latest unprocessed wins
 *   (d) writeRoleSwitchRequest calls appendEntry with correct type + payload + timestamp
 *   (e) sourceEntryId absent in switch-processed doesn't match a request (defensive)
 */

import { describe, expect, it, vi } from "vitest";
import {
  ACTIVE_ROLE_ENTRY_TYPE,
  ROLE_SWITCH_REQUEST_ENTRY_TYPE,
  ROLE_SWITCH_PROCESSED_TYPE,
  findLatestActiveRoleState,
  findUnprocessedSwitchRequest,
  writeActiveRoleState,
  writeRoleSwitchRequest,
} from "../src/protocol.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal entry shape mimicking Pi's session-log entries. */
interface LogEntry {
  type: string;
  customType?: string;
  data?: unknown;
  id: string;
}

function reqEntry(
  id: string,
  targetRole: string,
  reason = "test",
  sourceEntryId?: string,
): LogEntry {
  return {
    type: "custom",
    customType: ROLE_SWITCH_REQUEST_ENTRY_TYPE,
    data: { targetRole, reason, sourceEntryId, timestamp: Date.now() },
    id,
  };
}

function processedEntry(sourceEntryId: string): LogEntry {
  return {
    type: "custom",
    customType: ROLE_SWITCH_PROCESSED_TYPE,
    data: { sourceEntryId, timestamp: Date.now() },
    id: `processed-${sourceEntryId}`,
  };
}

function makeEntries(...items: LogEntry[]): ReadonlyArray<LogEntry> {
  return items;
}

// ---------------------------------------------------------------------------
// findUnprocessedSwitchRequest
// ---------------------------------------------------------------------------

describe("findUnprocessedSwitchRequest", () => {
  it("(a) returns the latest unprocessed request", () => {
    const entries = makeEntries(reqEntry("r1", "pi-agent"));
    const result = findUnprocessedSwitchRequest(entries);
    expect(result).not.toBeNull();
    expect(result!.data.targetRole).toBe("pi-agent");
    expect(result!.entry.id).toBe("r1");
  });

  it("(b) skips a processed request", () => {
    const entries = makeEntries(
      reqEntry("r1", "plan"),
      processedEntry("r1"),
    );
    const result = findUnprocessedSwitchRequest(entries);
    expect(result).toBeNull();
  });

  it("(c) multiple requests — latest unprocessed wins", () => {
    const entries = makeEntries(
      reqEntry("r1", "ask"),
      processedEntry("r1"),
      reqEntry("r2", "pi-agent"),
      reqEntry("r3", "fallow"),
    );
    const result = findUnprocessedSwitchRequest(entries);
    expect(result).not.toBeNull();
    expect(result!.data.targetRole).toBe("fallow");
    expect(result!.entry.id).toBe("r3");
  });

  it("(d) only the last processed request matters — earlier ones still blocked", () => {
    // r1 processed, r2 NOT processed, r3 processed. Only r4 (latest) is unprocessed.
    const entries = makeEntries(
      reqEntry("r1", "ask"),
      processedEntry("r1"),
      reqEntry("r2", "pi-agent"),
      reqEntry("r3", "plan"),
      processedEntry("r3"),
      reqEntry("r4", "fallow"),
    );
    const result = findUnprocessedSwitchRequest(entries);
    expect(result).not.toBeNull();
    expect(result!.entry.id).toBe("r4");
  });

  it("(e) sourceEntryId absent in switch-processed does NOT match a request (defensive)", () => {
    // A malformed processed entry without a sourceEntryId field should not
    // suppress the request.
    const entries = makeEntries(
      reqEntry("r1", "plan", "test", "trigger-1"),
      { type: "custom", customType: ROLE_SWITCH_PROCESSED_TYPE, data: {}, id: "bad-processed" },
    );
    const result = findUnprocessedSwitchRequest(entries);
    expect(result).not.toBeNull();
    expect(result!.entry.id).toBe("r1");
  });

  it("returns null for empty entries", () => {
    expect(findUnprocessedSwitchRequest(makeEntries())).toBeNull();
  });

  it("skips entries with missing targetRole field", () => {
    const entries = makeEntries({
      type: "custom",
      customType: ROLE_SWITCH_REQUEST_ENTRY_TYPE,
      data: { reason: "test" },
      id: "bad-req",
    });
    expect(findUnprocessedSwitchRequest(entries)).toBeNull();
  });

  it("skips entries that are not custom type", () => {
    const entries: ReadonlyArray<LogEntry> = [
      { type: "message", id: "m1", data: {} },
    ];
    expect(findUnprocessedSwitchRequest(entries)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// writeRoleSwitchRequest
// ---------------------------------------------------------------------------

describe("writeRoleSwitchRequest", () => {
  it("(d) calls appendEntry with correct type + payload + timestamp", () => {
    const spy = vi.fn();
    const fakePi = { appendEntry: spy };

    writeRoleSwitchRequest(fakePi, {
      targetRole: "pi-agent",
      reason: "plannotator:plan-approved",
      sourceEntryId: "abc-123",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      ROLE_SWITCH_REQUEST_ENTRY_TYPE,
      expect.objectContaining({
        targetRole: "pi-agent",
        reason: "plannotator:plan-approved",
        sourceEntryId: "abc-123",
        timestamp: expect.any(Number),
      }),
    );

    const [, payload] = spy.mock.calls[0] as [string, { timestamp: number }];
    // Timestamp should be within last 5 seconds.
    expect(payload.timestamp).toBeGreaterThan(Date.now() - 5000);
    expect(payload.timestamp).toBeLessThanOrEqual(Date.now() + 100);
  });

  it("omits sourceEntryId when not provided", () => {
    const spy = vi.fn();
    const fakePi = { appendEntry: spy };

    writeRoleSwitchRequest(fakePi, { targetRole: "ask", reason: "prompt:foo" });

    expect(spy).toHaveBeenCalledTimes(1);
    const [, payload] = spy.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.sourceEntryId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Active role state
// ---------------------------------------------------------------------------

describe("active role state helpers", () => {
  it("writes the active role state", () => {
    const spy = vi.fn();
    const fakePi = { appendEntry: spy };

    writeActiveRoleState(fakePi, {
      name: "pi-caveman",
      source: "user",
      path: "/roles/pi-caveman.md",
    });

    expect(spy).toHaveBeenCalledWith(
      ACTIVE_ROLE_ENTRY_TYPE,
      expect.objectContaining({
        name: "pi-caveman",
        source: "user",
        path: "/roles/pi-caveman.md",
        appliedAt: expect.any(Number),
      }),
    );
  });

  it("finds the latest active role state", () => {
    const entries = makeEntries(
      { type: "custom", customType: ACTIVE_ROLE_ENTRY_TYPE, data: { name: "planner", source: "project", path: "/planner.md", appliedAt: 1 }, id: "a1" },
      { type: "custom", customType: ACTIVE_ROLE_ENTRY_TYPE, data: { name: "pi-caveman", source: "user", path: "/pi-caveman.md", appliedAt: 2 }, id: "a2" },
    );

    expect(findLatestActiveRoleState(entries)?.name).toBe("pi-caveman");
  });
});