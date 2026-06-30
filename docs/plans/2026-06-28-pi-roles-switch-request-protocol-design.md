# Design: pi-roles role-switch request protocol

**Date:** 2026-06-28
**Status:** Approved
**Repos affected:**
- `pi-integrations/pi-roles` (publishes the protocol + consumes it)
- `pi-integrations/plannotator/apps/pi-extension` (approval trigger source)
- `~/.pi/agent/extensions/` (trigger extensions: `plan-auto-switch`, new `prompt-role-switch`)
- `~/.pi/prompts/plan-fork-customization.md` (new `role:` frontmatter field)

## Problem

`plan-auto-switch.ts` switches the role by returning `{ systemPrompt }`
from its `before_agent_start` handler. Pi composes `before_agent_start`
handlers sequentially, last-write-wins (`runner.js:~L774`).
`resourcePrecedenceRank` loads user-auto-discovered extensions (rank 3)
before package extensions (rank 4), so **pi-roles' handler runs after
plan-auto-switch and overwrites its prompt** with the still-active plan
role's body. plan-auto-switch never updates pi-roles' in-memory
`state.activeRole`, so even on the one turn it wins, the next turn reverts.

Session-log proof (`2026-06-26T12:02:57...jsonl`): after
`plannotator:plan-approved`, the assistant stopped (`stopReason: stop`)
expecting a switch that never came; `pi-roles:active-role=pi-agent` only
appeared ~96s later with `source:"user"` — a manual `/role pi-agent`. The
`switch_role` tool was never called (`grep -c switch_role` = 0).

## Goal

A generalized, extension-pluggable role-switch protocol so that:
1. Triggers (`plan-auto-switch`, `prompt-role-switch`, future ones) request
   a role switch without owning the role state or the system prompt.
2. pi-roles is the sole owner of `state.activeRole` and the system prompt,
   and fulfills switch requests itself.
3. A prompt file with a `role:` frontmatter field auto-switches the role
   when that prompt is invoked.

## Non-goals

- No new Pi platform inter-extension function-call API.
- No cross-extension import of pi-roles' runtime state (`applyResolved`,
  `state`).
- No removal of the existing `switch_role` tool or `/role` command.

## Design

### Architecture

```
   trigger extension                 session log                  pi-roles
   ─────────────────                 ───────────                  ────────
   before_agent_start:                                            before_agent_start:
     detect event            ──►   pi-roles:switch-request  ──►   scan for unprocessed
     writeRoleSwitchRequest()         {targetRole, reason}          request
                                                                      │
     mark trigger event processed                                    ▼
                                                                  applyResolved(targetRole)
                                                                    (mutates state.activeRole,
                                                                     writes pi-roles:active-role,
                                                                     sets tools/model)
                                                                      │
                                                                      ▼
                                                                  write pi-roles:switch-processed
                                                                      │
                                                                      ▼
                                                                  return composeSystemPrompt(state)
                                                                  (state.activeRole is now the
                                                                   target — correct prompt)
```

The trigger never returns a `systemPrompt`. The last-write-wins conflict
disappears because nothing competes with pi-roles' prompt anymore.

### The mix: Option 1 mechanism + Option 2 surface

- **Option 1 (mechanism):** session-log entries — the only cross-extension
  channel Pi exposes. Already used by both pi-roles (restore on reload) and
  plan-auto-switch (find approvals). Async-safe, fork/reload-durable.
- **Option 2 (surface):** trigger extensions `import { writeRoleSwitchRequest,
  ROLE_SWITCH_REQUEST_ENTRY_TYPE } from "pi-roles/protocol"` — a pure
  subpath export with no pi-roles runtime state. Trigger extension authors
  don't hardcode the entry-type string or payload shape.

The importable helper is **narrow**: it only writes to the log. It does NOT
import or call pi-roles' `applyResolved`/`state` — the fragility that made
"raw Option 2" unsafe (cross-sandbox access to module-scoped mutable state)
is eliminated.

### Component 1 — `pi-roles/src/protocol.ts` (new)

A pure module. No imports from `index.ts`, `apply.ts`, or any pi-roles
runtime state. Exactly three exports:

```ts
import { Type } from "typebox";

export const ROLE_SWITCH_REQUEST_ENTRY_TYPE = "pi-roles:switch-request" as const;
export const ROLE_SWITCH_PROCESSED_TYPE      = "pi-roles:switch-processed" as const;

export const RoleSwitchRequest = Type.Object({
  targetRole:    Type.String(),
  reason:        Type.String(),
  sourceEntryId: Type.Optional(Type.String()),
  timestamp:     Type.Number(),
});

export function writeRoleSwitchRequest(
  pi: { appendEntry: (t: string, d?: unknown) => void },
  req: { targetRole: string; reason: string; sourceEntryId?: string },
): void {
  pi.appendEntry(ROLE_SWITCH_REQUEST_ENTRY_TYPE, { ...req, timestamp: Date.now() });
}

export function findUnprocessedSwitchRequest(
  entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown; id: string }>,
): { entry: { id: string }; data: { targetRole: string; reason: string; sourceEntryId?: string; timestamp: number } } | null;
```

`findUnprocessedSwitchRequest` mirrors the existing `findRestoredState` /
`findUnprocessedPlanApproval` shape: newest-first, skip any request that
has a subsequent `pi-roles:switch-processed` with matching `sourceEntryId`.

### Component 2 — pi-roles package manifest

`pi-roles/package.json`:
```json
"exports": {
  ".": "./dist/index.js",
  "./protocol": "./dist/protocol.js"
}
```
`pi-roles/tsup.config.ts`:
```ts
entry: ["src/index.ts", "src/protocol.ts"],
```
`files` already includes `dist/`, so the subpath ships for free.

### Component 3 — pi-roles `index.ts` consumer

Inside the existing `before_agent_start` handler, BEFORE the existing
`composeSystemPrompt` return, add:

```ts
const req = findUnprocessedSwitchRequest(ctx.sessionManager.getEntries());
if (req) {
  await applyResolved(pi, ctx, state, req.targetRole, {
    silent: false,
    preservedIntent: state.intent,
  });
  pi.appendEntry(ROLE_SWITCH_PROCESSED_TYPE, {
    sourceEntryId: req.entry.id,
    timestamp: Date.now(),
  });
}
// fall through to existing return composeSystemPrompt(state, pi)
```

pi-roles is now the sole owner of the prompt AND of role state, and
switches itself when asked. Same handler that already runs every turn.

### Component 4 — trigger extension (`plan-auto-switch.ts` rewritten)

Keeps its `before_agent_start` (find unprocessed
`plannotator:plan-approved`) and its `findUnprocessedPlanApproval` helper
+ `PROCESSED_MARKER_PREFIX` for its own idempotency. Deletes
`loadRoleForSwitch`, `parseRoleTools`, `setActiveTools`, and the
`systemPrompt` return.

```ts
import { writeRoleSwitchRequest } from "pi-roles/protocol";

export default function planAutoSwitch(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (_e, ctx) => {
    let entries;
    try { entries = ctx.sessionManager.getEntries(); } catch { return; }
    const approval = findUnprocessedPlanApproval(entries);
    if (!approval) return;
    writeRoleSwitchRequest(pi, {
      targetRole:    "pi-agent",
      reason:        "plannotator:plan-approved",
      sourceEntryId: approval.entry.id,
    });
    pi.appendEntry(PROCESSED_MARKER_PREFIX, { sourceEntryId: approval.entry.id });
  });
}
```

It declares `pi-roles` as a `dependencies` entry (not just peer) so the
`pi-roles/protocol` subpath resolves at runtime. (pi-roles is already a
package installed via settings.json; this adds a direct dep.)

### Component 5 — new trigger `prompt-role-switch.ts`

Lives in the planned general folder extension (the folder extension with
`index.ts` that registers both `plan-auto-switch` and
`prompt-role-switch`). Detects `/prompt-name args` in the user's raw
prompt, resolves the prompt file by scanning the same directories Pi scans
(global `~/.pi/agent/prompts/`, project `.pi/prompts/`, explicit
`promptPaths`), parses its frontmatter, and if a `role:` field exists,
writes a switch-request with `reason: "prompt:<name>"`.

```ts
import { writeRoleSwitchRequest } from "pi-roles/protocol";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// parseFrontmatter from @earendil-works/pi-coding-agent (peer dep)

pi.on("before_agent_start", async (event, ctx) => {
  const m = event.prompt.match(/^\s*\/([a-zA-Z0-9_-]+)/);
  if (!m) return;
  const promptFile = resolvePromptFile(m[1], ctx);  // scan Pi's prompt dirs
  if (!promptFile) return;
  const { frontmatter } = parseFrontmatter(readFileSync(promptFile, "utf-8"));
  if (!frontmatter.role) return;
  writeRoleSwitchRequest(pi, { targetRole: frontmatter.role, reason: `prompt:${m[1]}` });
});
```

It does NOT touch pi-roles' internals. Same channel, same protocol,
independent trigger. `resolvePromptFile` reuses the dir-precedence logic
already in pi-roles' `discoverRoles` (global → project → explicit), ported
for the `prompts/` dir or extracted to a shared util.

### Component 6 — `plan-fork-customization.md` frontmatter

```yaml
---
description: Plan a fork-customization workflow
role: plan
---
```

### Timing guarantee

`_appendEntry` (`session-manager.js:~L667`) pushes synchronously into
`fileEntries`; `getEntries()` reads the same in-memory array. So an
`appendEntry` from a trigger's `before_agent_start` IS visible to pi-roles'
handler later in the same pass. The switch happens same-turn — no
one-turn delay.

### Load-order safety

`resourcePrecedenceRank`: user-auto-discovered extensions (rank 3) load
before packages (rank 4). So plan-auto-switch (or the general folder
extension at rank 3) writes the request BEFORE pi-roles' handler runs
(rank 4). pi-roles sees the fresh entry same turn. This is the natural,
required order — and it's what the rank already gives us.

## Idempotency

- Trigger marks its own source event processed (existing
  `plan-auto-switch:processed` convention; new
  `prompt-role-switch:processed` for the prompt trigger) so it doesn't
  write duplicate requests.
- pi-roles marks each consumed request via
  `pi-roles:switch-processed` so it doesn't apply the same request twice.
- On `session_start reason="reload"|"resume"`, entries are preserved;
  unprocessed requests still fire correctly. Unprocessed triggers' own
  markers are also preserved (existing behavior).

## Error handling

- `targetRole` not found → `applyResolved` already falls back to built-in
  `pi-agent` with a warning toast (existing behavior). Request is still
  marked processed (no infinite retry).
- Prompt trigger can't resolve prompt file → returns silently (no switch).
- Trigger can't read frontmatter → returns silently.

## Testing

- `protocol.ts`: unit-test `findUnprocessedSwitchRequest` (unprocessed,
  processed, multiple, fork-branch scenarios) and
  `writeRoleSwitchRequest` (writes correct type + payload + timestamp).
- pi-roles `index.ts`: integration test that a `pi-roles:switch-request`
  entry in the session log causes `before_agent_start` to call
  `applyResolved` and write `switch-processed`, AND that
  `composeSystemPrompt` then returns the target role body.
- `plan-auto-switch.ts`: its test shrinks to
  `findUnprocessedPlanApproval` (existing) + a spy on
  `writeRoleSwitchRequest`.
- `prompt-role-switch.ts`: unit test `resolvePromptFile` dir precedence +
  a fixture prompt with `role:` frontmatter.

## Migration

- Bump pi-roles version (minor): publish `protocol` subpath + consumer.
  Backward compatible — no existing API changes.
- Rewrite `plan-auto-switch.ts` in place (user-local extension). Delete
  its old `loadRoleForSwitch`/`setActiveTools`/prompt-return code.
- Add the new general folder extension with `index.ts` registering both
  triggers; replace the two standalone `.ts` files in
  `~/.pi/agent/extensions/`.
- Add `role: plan` to `plan-fork-customization.md` frontmatter.

## Out of scope for this design (next phase)

- Documenting the protocol for third-party trigger authors (a short
  `README` section in pi-roles).
- Whether `switch_role` tool should also route through the new protocol
  entry for symmetry (currently it calls `applyResolved` directly — works
  fine, no change needed).