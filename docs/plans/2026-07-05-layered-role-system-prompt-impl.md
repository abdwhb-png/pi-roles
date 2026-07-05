# Implementation Plan: layered role system prompt composition

**ADR:** `docs/plans/2026-07-05-layered-role-system-prompt-adr.md`
**Scope:** `pi-integrations/pi-roles`
**Status:** Proposed

## Goal

Replace plain `originalPrompt + role.body` concatenation with a structured,
configurable prompt composition strategy that preserves Pi invariants by
default and makes the selected role more salient for weaker models.

## Current Control Point

Primary implementation surface:

- `src/index.ts` — `composeSystemPrompt(...)`
- `src/schemas.ts` — `PiRolesSettingsSchema` and `PiRolesSettings`
- `src/settings.ts` — existing settings loader; probably no logic change unless
  migration helpers are added outside schema/default handling
- `test/override-system-prompt.test.ts` — current behavior tests
- `README.md` / `ARCHITECTURE.md` — docs that describe prompt behavior

No new Pi hook is needed. The existing `before_agent_start` handler is the
correct integration point because Pi rebuilds the prompt per turn and passes it
as `event.systemPrompt`.

## Phase 1 — RED: prompt mode tests

Update or replace `test/override-system-prompt.test.ts` before production code.

Add tests for the new default behavior:

1. No active role returns `undefined`.
2. Missing settings uses `strict-additive`.
3. `strict-additive` output includes the original prompt before the role.
4. `strict-additive` output wraps the role body in an `Active Role` section.
5. `strict-additive` output includes conflict policy text: core invariants win.
6. `strict-additive` output includes a final reminder after the role body.
7. Empty original prompt still produces a role prompt, with warning behavior
   unchanged when UI context exists.

Add tests for compatibility:

1. `enableSystemPromptAppend: false` maps to legacy replacement when
   `systemPromptMode` is missing.
2. `enableSystemPromptAppend: true` maps to `strict-additive` when
   `systemPromptMode` is missing.
3. Explicit `systemPromptMode` wins over `enableSystemPromptAppend`.

Add tests for each explicit mode:

1. `systemPromptMode: "strict-additive"` preserves original prompt, adds
   priority contract, adds role wrapper, adds final reminder.
2. `systemPromptMode: "role-last"` preserves original prompt and places the
   role close to the end with the final reminder after it.
3. `systemPromptMode: "legacy-replace"` omits original prompt and keeps role
   body authoritative, while still allowing the intercom addendum.

Add intercom regression tests if current coverage is missing:

1. Intercom addendum is appended after role content in additive modes.
2. Intercom addendum is appended in `legacy-replace` mode.

Run focused test and confirm it fails for the right reason:

```bash
bun test test/override-system-prompt.test.ts
```

## Phase 2 — GREEN: schema and composition helpers

Edit `src/schemas.ts`:

Add a prompt mode schema:

```ts
export const SystemPromptModeSchema = Type.Union(
  [
    Type.Literal("strict-additive"),
    Type.Literal("role-last"),
    Type.Literal("legacy-replace"),
  ],
  { description: "How pi-roles composes the active role with Pi's original system prompt." },
);
export type SystemPromptMode = Static<typeof SystemPromptModeSchema>;
```

Add to `PiRolesSettingsSchema`:

```ts
systemPromptMode: Type.Optional(SystemPromptModeSchema),
```

Keep `enableSystemPromptAppend` as deprecated compatibility input. Do not remove
it.

Edit `src/index.ts`:

Add small pure helpers near `composeSystemPrompt`:

```ts
function resolveSystemPromptMode(settings: Pick<PiRolesSettings, "systemPromptMode" | "enableSystemPromptAppend">): SystemPromptMode {
  if (settings.systemPromptMode) return settings.systemPromptMode;
  if (settings.enableSystemPromptAppend === false) return "legacy-replace";
  return "strict-additive";
}
```

Add section builders:

```ts
function buildRolePriorityContract(): string { ... }
function buildActiveRoleSection(role: ResolvedRole): string { ... }
function buildFinalPriorityReminder(): string { ... }
```

Keep strings short and deterministic. Avoid dynamic prose beyond role name/body.
Use stable headings so tests can assert against them.

Update `composeSystemPrompt` to:

1. Return `undefined` when no active role.
2. Resolve `mode` from settings.
3. Build `roleSection` from active role.
4. Build `addendum` exactly as today.
5. Compose by mode:

`strict-additive`:

```text
originalPrompt
priorityContract
roleSection
addendum
finalReminder
```

`role-last`:

```text
originalPrompt
priorityContract
addendum
roleSection
finalReminder
```

`legacy-replace`:

```text
role.body
addendum
```

For additive modes, if `originalPrompt` is missing and UI context exists, keep
the existing warning behavior. Do not warn in `legacy-replace` because that mode
intentionally ignores the original prompt.

Run focused test:

```bash
bun test test/override-system-prompt.test.ts
```

## Phase 3 — REFACTOR: naming and stale comments

Clean up comments in `src/index.ts` that still say the extension intentionally
ignores `event.systemPrompt` by default. Replace with the new contract:

- Default behavior preserves Pi's original prompt.
- Role body is an additive persona/task-strategy layer.
- `legacy-replace` exists for explicit full replacement.

If tests use repeated role fixture objects, extract a local `makeRole(...)`
helper in the test file. Keep it inside the test file unless shared elsewhere.

Do not refactor unrelated role switching, intercom, title, or tool selection
logic.

## Phase 4 — docs

Update `README.md` settings reference:

- Document `systemPromptMode` values.
- Mark `enableSystemPromptAppend` as compatibility/deprecated.
- Show recommended config:

```json
{
  "pi-roles": {
    "systemPromptMode": "strict-additive"
  }
}
```

Add a short explanation that `AGENTS.md`, `APPEND_SYSTEM.md`, `SYSTEM.md`, Pi
tool/safety rules, and existing prompt content remain invariant in the default
mode.

Update `ARCHITECTURE.md` if it describes prompt replacement or role authority.
Use the same vocabulary as the ADR: invariant layer, role persona layer, final
priority reminder.

## Phase 5 — verification

Run focused checks first:

```bash
bun test test/override-system-prompt.test.ts
```

Run all project tests:

```bash
bun test
```

Run typecheck if available in `package.json`:

```bash
bun run typecheck
```

Run lint if available in `package.json`:

```bash
bun run lint
```

Run a build only if package scripts show it is the standard verification path:

```bash
bun run build
```

Inspect final diff:

```bash
git diff -- src/index.ts src/schemas.ts test/override-system-prompt.test.ts README.md ARCHITECTURE.md docs/plans/2026-07-05-layered-role-system-prompt-adr.md docs/plans/2026-07-05-layered-role-system-prompt-impl.md
```

## Acceptance Criteria

- Default prompt composition preserves Pi's original system prompt.
- Default prompt composition includes explicit priority/conflict rules.
- Default prompt composition includes a bounded active-role section.
- Default prompt composition includes a short final reminder.
- `legacy-replace` preserves old replacement behavior by explicit config.
- Old `enableSystemPromptAppend` configs still behave compatibly.
- Unit tests cover all prompt modes and compatibility mapping.
- README documents the new setting and deprecates the old one.
- Stale comments claiming default prompt replacement are removed.

## Non-goals

- No automatic role summarization or compression.
- No changes to role discovery.
- No changes to `/role` command semantics.
- No changes to `switch_role` tool semantics.
- No changes to Pi core prompt assembly.

## Follow-up Ideas

- Add `/role debug-prompt` to show the composed prompt sections without sending
  a model request.
- Add prompt snapshot tests for real built-in roles.
- Add a role authoring guide explaining how to write role files as persona/task
  layers instead of full system prompts.
- Add optional role-body lint warnings for phrases that try to override core
  invariants, such as "ignore previous instructions".