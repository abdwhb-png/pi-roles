/**
 * `switch_role` tool — LLM-callable role switching.
 *
 * This is the programmatic counterpart to the `/role <name>` command. It
 * resolves the named role through the same `applyResolved` path used by the
 * command handler, so model/thinking/tools/session-name are mutated
 * identically. The only difference is the entry point: a tool call instead
 * of a TUI command.
 *
 * Design notes:
 *   - The tool is registered in `index.ts` because it needs access to the
 *     module-scoped `RuntimeState` (active role, discovered roles, settings,
 *     intent). The pure helpers live here so they can be unit-tested without
 *     spinning up a fake `ExtensionAPI`.
 *   - We do NOT clear conversation history on switch (no `--reset`). The
 *     `/role` command supports `--reset` for a fresh start; the tool
 *     intentionally keeps history so the LLM retains plan context when
 *     handing off from planning to implementation.
 *   - On unknown role, we return an error result to the LLM (not a throw) so
 *     the agent can recover by listing roles via `/role list`.
 */

import type { RawRole } from "./schemas.ts";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Validate that `roleName` refers to a discovered role. Returns `null` when
 * valid, or a user-facing error string when not.
 *
 * The error message lists available role names so the LLM can self-correct
 * without an extra round-trip.
 */
export function validateRoleName(roleName: string, roles: RawRole[]): string | null {
  const trimmed = roleName.trim();
  if (!trimmed) {
    return "Role name is required.";
  }

  const exists = roles.some((r) => r.frontmatter.name === trimmed);
  if (exists) return null;

  const available = roles
    .map((r) => r.frontmatter.name)
    .filter(Boolean)
    .sort()
    .join(", ");
  if (!available) {
    return `Role "${trimmed}" not found. No roles are available.`;
  }
  return `Role "${trimmed}" not found. Available roles: ${available}`;
}

/**
 * Compose the LLM-facing result text for a successful switch.
 *
 * Warnings (e.g. model not found, MCP tool missing) are surfaced inline so
 * the LLM is aware of degraded state.
 */
export function formatSwitchRoleResult(roleName: string, warnings: string[]): string {
  const header = `Switched to role "${roleName}".`;
  if (warnings.length === 0) return header;
  const list = warnings.map((w) => `- ${w}`).join("\n");
  return `${header}\n\nWarnings:\n${list}`;
}
