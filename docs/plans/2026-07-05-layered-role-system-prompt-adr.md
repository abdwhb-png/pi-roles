# ADR: Layered role system prompt composition

**Date:** 2026-07-05
**Status:** Proposed
**Repository:** `pi-integrations/pi-roles`

## Context

`pi-roles` originally made the active role authoritative by replacing Pi's
system prompt with the role body. That helped roles feel strong, but it also
discarded the invariant prompt layers that Pi normally loads: `SYSTEM.md`,
`AGENTS.md`, `APPEND_SYSTEM.md`, and other platform or extension-provided
instructions.

The current fork changed that behavior: by default, `composeSystemPrompt`
keeps Pi's original `event.systemPrompt` and appends the role body. Full
replacement remains available through `enableSystemPromptAppend: false`.

This preserves invariants, but weak and mid-tier models still sometimes follow
only the generic project instructions and under-apply the selected role. The
current composition is a plain concatenation:

```text
<Pi original system prompt>

<role markdown body>

<optional intercom addendum>
```

That shape does not explicitly tell the model which instructions are invariant,
which instructions are persona/task strategy, and what to do when they appear to
conflict.

Research against VS Code/Copilot agent architecture suggests a better pattern:
agent prompts are built as explicit layers. Core identity/safety/system rules,
model-specific agent instructions, custom instructions, workspace context,
history, user query, tool instructions, and final reminders are separate prompt
elements. Some internals use prompt element priorities so core rules survive
compaction better. The public VS Code extension API also exposes chat
participants as handlers that construct structured language-model messages,
rather than relying on one unstructured prompt blob.

## Decision

`pi-roles` will treat roles as an additive persona and task-strategy layer by
default, not as a replacement for Pi's invariant system prompt.

Prompt composition will become an explicit layered contract:

1. Preserve Pi's original system prompt first.
2. Add a small `pi-roles` priority contract explaining instruction precedence.
3. Add the active role inside a clearly named and bounded role-persona section.
4. Add optional integration addenda, such as intercom.
5. Add a short final priority reminder for weak models.

The default behavior will be strict additive composition: invariants always win,
and role content guides expertise, tone, domain framing, task strategy, and
workflow only inside those invariant boundaries.

Full replacement will remain possible, but only through an explicit legacy or
advanced setting. The default must never silently discard Pi's invariant prompt
layers.

## Prompt Contract

The composed prompt should have this conceptual shape:

```text
<Pi original system prompt>

# pi-roles Instruction Priority

Pi core invariants are mandatory and have highest priority. These include
SYSTEM.md, AGENTS.md, APPEND_SYSTEM.md, platform safety/tool rules, and any
instructions already present in the original system prompt.

The active role is a persona and task-strategy layer. It must be followed only
within the boundaries of the core invariants. If the role conflicts with core
invariants, follow the core invariants and adapt the role accordingly.

# Active Role: <role name>

<role body>

<optional integration addendum>

# pi-roles Final Reminder

Follow Pi core invariants first. Use the active role for expertise, tone, and
strategy. On conflict, core invariants win.
```

The exact text can be tuned, but the section boundaries and conflict policy are
part of the design.

## Settings Model

Introduce a new explicit setting, tentatively named `systemPromptMode`:

- `strict-additive` (default): preserve original prompt, wrap role as persona,
  append final reminder.
- `role-last`: preserve original prompt, put role late, append final reminder.
  This remains invariant-preserving but optimizes for weaker models that follow
  recent instructions more strongly.
- `legacy-replace`: replace the original prompt with the role body, matching
  the original package behavior. This is advanced and opt-in.

Keep backward compatibility with `enableSystemPromptAppend`:

- `enableSystemPromptAppend: false` maps to `legacy-replace` unless
  `systemPromptMode` is explicitly set.
- Missing `enableSystemPromptAppend` maps to `strict-additive`.
- `enableSystemPromptAppend: true` maps to `strict-additive` unless
  `systemPromptMode` is explicitly set.

The new setting should be the documented one. The old setting remains accepted
for compatibility.

## Consequences

Positive:

- Pi invariants are preserved by default.
- Roles become stronger on non-frontier models because the prompt contains an
  explicit role section and a final priority reminder.
- The behavior is easier to test with deterministic prompt snapshots.
- Legacy replacement remains available for users who intentionally want it.

Negative:

- Prompts get slightly longer because of wrapper and reminder text.
- Existing docs/comments that describe role-body replacement need updates.
- If role files are already written as full system prompts, authors may need to
  adjust wording so they read as persona/task guidance instead of global law.

## Alternatives Considered

### Keep simple append

Rejected as default. It preserves invariants but does not give weaker models a
clear instruction hierarchy, conflict policy, or final reminder.

### Restore full replacement

Rejected as default. It makes roles strong but discards `AGENTS.md`,
`APPEND_SYSTEM.md`, and future `SYSTEM.md` invariants. This contradicts the
desired Pi contract.

### Automatically summarize/compress role files

Deferred. A role compiler could help long roles, but it risks losing nuance and
requires separate evaluation. The first step should be deterministic prompt
layering.

## Validation

Implementation should be validated with tests that assert:

- Default mode preserves original prompt and wraps the role.
- Default mode includes a conflict policy and final reminder.
- `role-last` preserves original prompt and keeps the role near the end.
- `legacy-replace` omits the original prompt.
- `enableSystemPromptAppend: false` still maps to replacement when no new mode
  is configured.
- Intercom addenda remain included in all non-empty role modes.

Manual validation should compare the final prompt text before and after the
change with at least one project role and one user role.