/**
 * Built-in role accessor for `role-assistant`.
 *
 * The pi-roles package ships two built-in roles under `resources/roles/`:
 *
 *   - `pi-agent`        — default fallback; general-purpose agent persona
 *   - `role-assistant`  — interactive role builder; helps pick/build roles
 *
 * Both are discovered automatically by `roles.ts` via the built-in roles
 * directory. This module exists so other code (and tests) can:
 *
 *   - locate the bundled `role-assistant.md` file path without duplicating
 *     `import.meta.url` plumbing, and
 *   - load the role independently of full discovery (useful when a malformed
 *     project-scope role would otherwise prevent us from showing the
 *     fallback).
 *
 * Keep this module thin. The real loader is `loadRoleFile` in `roles.ts`;
 * we only add a guaranteed-bundled-path resolver and a self-check used by
 * tests.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRoleFile, RoleResolutionError } from "./roles.ts";
import { BUILTIN_ROLE_ASSISTANT_NAME, type RawRole } from "./schemas.ts";

/**
 * Absolute path to the bundled `role-assistant.md` file. Resolved relative
 * to this module so it works when pi-roles is installed under
 * `node_modules/` and when it's run from a checkout via `pi -e <path>`.
 */
export function builtInRoleAssistantPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "resources", "roles", `${BUILTIN_ROLE_ASSISTANT_NAME}.md`);
}

/**
 * Load the bundled role-assistant from disk. Throws `RoleResolutionError` if
 * the file is missing — that would mean the package was installed
 * incorrectly (the `files` field in package.json should always include
 * `resources/`).
 */
export function loadBuiltInRoleAssistant(): RawRole {
  const path = builtInRoleAssistantPath();
  if (!existsSync(path)) {
    throw new RoleResolutionError(
      `Built-in role-assistant not found at ${path}. The pi-roles package may be installed incorrectly; ensure 'resources/' is included.`,
    );
  }
  return loadRoleFile(path, "built-in");
}
