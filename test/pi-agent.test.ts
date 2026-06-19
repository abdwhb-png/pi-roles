/**
 * Phase 6b tests: the bundled `pi-agent.md` exists, parses, surfaces in
 * `discoverRoles` results, and acts as the new default fallback role.
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { discoverRoles, findBuiltInAssistant, loadRoleFile, resolveRole } from "../src/roles.ts";
import { BUILTIN_ROLE_ASSISTANT_NAME, BUILTIN_ROLE_DEFAULT_NAME } from "../src/schemas.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const builtInRolesDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "resources",
  "roles",
);

const piAgentPath = resolve(builtInRolesDir, `${BUILTIN_ROLE_DEFAULT_NAME}.md`);

describe("built-in pi-agent", () => {
  it("file exists at the resources path", () => {
    expect(existsSync(piAgentPath)).toBe(true);
  });

  it("parses without errors", () => {
    const role = loadRoleFile(piAgentPath, "built-in");
    expect(role.frontmatter.name).toBe(BUILTIN_ROLE_DEFAULT_NAME);
    expect(role.frontmatter.description).toBeTruthy();
    expect(role.body.length).toBeGreaterThan(0);
    expect(role.source).toBe("built-in");
  });

  it("has no model/thinking/tools restrictions (default inherits everything)", () => {
    const role = loadRoleFile(piAgentPath, "built-in");
    expect(role.frontmatter.model).toBeUndefined();
    expect(role.frontmatter.thinking).toBeUndefined();
    // tools field absent → inherit (don't restrict the user's available tools)
    expect(role.frontmatter.tools).toBeUndefined();
  });

  it("appears in discoverRoles output as built-in", () => {
    // Use "project" scope (no user dir) to avoid shadowing from
    // ~/.pi/agent/roles/ when the user has their own pi-agent role.
    const result = discoverRoles("/tmp", "project");
    const found = result.roles.find(
      (r) => r.frontmatter.name === BUILTIN_ROLE_DEFAULT_NAME && r.source === "built-in",
    );
    expect(found).toBeDefined();
    expect(found!.source).toBe("built-in");
  });

  it("resolveRole on pi-agent returns a usable ResolvedRole", () => {
    const result = discoverRoles("/tmp", "project");
    const resolved = resolveRole(BUILTIN_ROLE_DEFAULT_NAME, result.roles);
    expect(resolved.name).toBe(BUILTIN_ROLE_DEFAULT_NAME);
    expect(resolved.body.length).toBeGreaterThan(0);
    expect(resolved.tools).toEqual({ kind: "inherit" });
  });

  it("both pi-agent and role-assistant appear as built-in roles", () => {
    // Use "project" scope to avoid user-level shadowing.
    const result = discoverRoles("/tmp", "project");
    const names = result.roles
      .filter((r) => r.source === "built-in")
      .map((r) => r.frontmatter.name)
      .sort();
    expect(names).toContain(BUILTIN_ROLE_DEFAULT_NAME);
    expect(names).toContain(BUILTIN_ROLE_ASSISTANT_NAME);
  });
});