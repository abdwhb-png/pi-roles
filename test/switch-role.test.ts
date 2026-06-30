/**
 * Tests for the switch_role tool helpers.
 *
 * The tool itself is thin integration glue around `applyResolved` (same path
 * as `/role <name>`). The pure helpers below are the testable surface:
 *   - `validateRoleName` — does the role exist in the discovered set?
 *   - `formatSwitchRoleResult` — compose the LLM-facing result text
 */

import { describe, expect, it } from "vitest";
import {
  formatSwitchRoleResult,
  validateRoleName,
} from "../src/switch-role.ts";
import { parseRoleSource } from "../src/roles.ts";
import type { RawRole } from "../src/schemas.ts";

function makeRole(name: string, description = "test"): RawRole {
  return parseRoleSource(
    `---\nname: ${name}\ndescription: ${description}\n---\nbody`,
    `/v/${name}.md`,
    "project",
  );
}

// ---------------------------------------------------------------------------
// validateRoleName
// ---------------------------------------------------------------------------

describe("validateRoleName", () => {
  const roles = [makeRole("pi-agent"), makeRole("plan"), makeRole("architect")];

  it("returns null for a known role", () => {
    expect(validateRoleName("pi-agent", roles)).toBeNull();
    expect(validateRoleName("plan", roles)).toBeNull();
  });

  it("rejects empty string", () => {
    expect(validateRoleName("", roles)).toMatch(/required/i);
  });

  it("rejects whitespace-only string", () => {
    expect(validateRoleName("   ", roles)).toMatch(/required/i);
  });

  it("rejects unknown role with a helpful message", () => {
    const err = validateRoleName("ghost", roles);
    expect(err).toMatch(/not found/i);
    expect(err).toContain("ghost");
  });

  it("lists available roles in the error message", () => {
    const err = validateRoleName("ghost", roles);
    expect(err).toContain("pi-agent");
    expect(err).toContain("architect");
  });

  it("handles empty roles array", () => {
    const err = validateRoleName("anything", []);
    expect(err).toMatch(/not found|no roles/i);
  });
});

// ---------------------------------------------------------------------------
// formatSwitchRoleResult
// ---------------------------------------------------------------------------

describe("formatSwitchRoleResult", () => {
  it("success with no warnings", () => {
    const result = formatSwitchRoleResult("pi-agent", []);
    expect(result).toContain("Switched to role");
    expect(result).toContain("pi-agent");
  });

  it("success with warnings includes them", () => {
    const result = formatSwitchRoleResult("pi-agent", ["Model not found"]);
    expect(result).toContain("Switched to role");
    expect(result).toContain("pi-agent");
    expect(result).toContain("Model not found");
  });

  it("multiple warnings are listed", () => {
    const result = formatSwitchRoleResult("architect", ["w1", "w2"]);
    expect(result).toContain("w1");
    expect(result).toContain("w2");
  });
});
