# Implementation Plan: pi-roles role-switch request protocol

**Design:** `docs/plans/2026-06-28-pi-roles-switch-request-protocol-design.md` (commit `eef164c`)
**Scope:** multi-repo. Tasks 1–4 land in `pi-integrations/pi-roles`. Tasks 5–7 land in `~/.pi/agent/extensions/` and `~/.pi/prompts/`. Task 8 is verification.

Conventions:
- Every new code file gets a unit test next to it (task tagged with `test`).
- Keep diffs minimal and reviewable; do not reformat untouched code.
- `pi-roles` work happens on a branch off `main` in the `pi-integrations/pi-roles` git repo.
- Trigger-extension work happens in `~/.pi/agent/extensions/` (user-local, not a git repo) — keep backups of originals as `*.bak` before rewriting.

---

## Task 1 — `pi-roles/src/protocol.ts` + tests

Create `src/protocol.ts` — a pure module. No imports from `index.ts`, `apply.ts`, `roles.ts`, or any pi-roles runtime state. Exactly the exports from the design's Component 1:

- `ROLE_SWITCH_REQUEST_ENTRY_TYPE = "pi-roles:switch-request" as const`
- `ROLE_SWITCH_PROCESSED_TYPE = "pi-roles:switch-processed" as const`
- `RoleSwitchRequest` TypeBox schema (Object: `targetRole: String`, `reason: String`, `sourceEntryId: Optional(String)`, `timestamp: Number`)
- `writeRoleSwitchRequest(pi, req)` — calls `pi.appendEntry(ROLE_SWITCH_REQUEST_ENTRY_TYPE, { ...req, timestamp: Date.now() })`. `pi` param typed as `{ appendEntry: (t: string, d?: unknown) => void }` so it's pure and testable with a fake.
- `findUnprocessedSwitchRequest(entries)` — walk newest-first, return `{ entry: { id }, data }` for the latest `pi-roles:switch-request` entry that has no subsequent `pi-roles:switch-processed` with matching `sourceEntryId`. Same shape as the existing `findUnprocessedPlanApproval` in `plan-auto-switch.ts` (use it as a structural reference; do NOT import it).

**test:** `test/protocol.test.ts` — cover: (a) unprocessed request returned, (b) processed request skipped, (c) multiple requests → latest unprocessed wins, (d) `writeRoleSwitchRequest` calls `appendEntry` with the correct type + payload + timestamp (use a spy/fake `pi`), (e) `sourceEntryId` absent in `switch-processed` doesn't match a request (defensive).

**Verification:** `cd pi-roles && bun test test/protocol.test.ts` passes.

**Acceptance:** `attested` — run `bun test` and `bun run typecheck` and paste the green output.

---

## Task 2 — pi-roles package manifest + tsup build for `./protocol` subpath

Edit `pi-roles/package.json`:
- Add to `exports`:
  ```json
  "exports": {
    ".": "./dist/index.js",
    "./protocol": "./dist/protocol.js"
  }
  ```
- Add `"./dist/protocol.d.ts"` alongside if/when `tsup` is toggled to emit declarations (currently `dts: false`; leave off for this task — types are inline in `protocol.ts` and the import surface is narrow).
- No change to `files` — `dist/` already covered.

Edit `pi-roles/tsup.config.ts`:
- `entry: ["src/index.ts", "src/protocol.ts"]`

**test:** none (build config).

**Verification:** `cd pi-roles && bun run build` produces `dist/index.js` AND `dist/protocol.js`. `node -e "import('./dist/protocol.js').then(m => console.log(Object.keys(m)))"` prints the four exports.

**Acceptance:** `attested` — paste the build output + the `node -e` keys list.

---

## Task 3 — pi-roles `index.ts` consumes `switch-request` in its existing `before_agent_start`

In `pi-roles/src/index.ts`, inside the existing `pi.on("before_agent_start", async (event, ctx) => { ... })` handler, BEFORE the final `return composeSystemPrompt(state, pi);`, add:

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
```

Import `findUnprocessedSwitchRequest`, `ROLE_SWITCH_PROCESSED_TYPE` from `./protocol.ts`. `applyResolved` is already defined locally in `index.ts` — no new code there.

**Important ordering note:** this MUST run before the existing title-generation trigger guard (`state.titleInFlight` etc.) so the new role is in place before any title summarization fires. Place the switch-request consumption at the TOP of the handler body (after the `debugLog("index", "before_agent_start fired", ...)` line is fine).

Keep the existing `debugLog` calls and add one: `debugLog("index", "consumed switch-request", { targetRole: req?.targetRole });`.

**test:** extend the existing pi-roles test suite (or add `test/switch-request-consumer.test.ts`) with an integration-style test that: (a) seeds `ctx.sessionManager.getEntries()` with an unprocessed `pi-roles:switch-request { targetRole: "ask" }`, (b) invokes the handler, (c) asserts `applyResolved` was called with `"ask"` (mock it), (d) asserts `pi.appendEntry` was called with `pi-roles:switch-processed` + matching `sourceEntryId`, (e) asserts `composeSystemPrompt` now returns the ask role body (i.e. `state.activeRole.name === "ask"`).

**Verification:** `cd pi-roles && bun test` passes (existing tests still green + new test green). `bun run typecheck` clean.

**Acceptance:** `attested` — paste test + typecheck output.

---

## Task 4 — bump pi-roles version + bump dist

Edit `pi-roles/package.json` version: `0.2.3` → `0.3.0` (minor — new `./protocol` subpath is additive, backward-compatible per semver).

Rebuild: `cd pi-roles && bun run build`.

**test:** none.

**Verification:** `grep '"version"' pi-roles/package.json` shows `0.3.0`; `ls dist/` contains `index.js`, `protocol.js`.

**Acceptance:** `attested` — paste outputs.

**Do NOT `npm publish` in this task** — that's a manual user step after review. Leave the updated `dist/` and version bump staged for the user to publish.

---

## Task 5 — rewrite `~/.pi/agent/extensions/plan-auto-switch.ts` to use `pi-roles/protocol`

BACKUP first: `cp plan-auto-switch.ts plan-auto-switch.ts.bak` (the user-local extensions dir isn't a git repo, so keep a .bak).

Rewrite `plan-auto-switch.ts` to:
- Keep: `findUnprocessedPlanApproval`, `PROCESSED_MARKER_PREFIX`, the `PlanApprovedPayload` type, the `before_agent_start` registration and its body up to finding `approval`.
- Delete: `loadRoleForSwitch`, `parseRoleTools`, `LoadedRole`, `PlanAutoSwitchConfig`, `loadConfig`, `defaultRolesDir`, the `loadRoleForSwitch`/role-file-reading block, the `pi.setActiveTools(role.tools)` call, the `systemPrompt` return value, the "target role not found" warning block, the config-driven `targetRole`/`rolesDir` resolution.
- Add: `import { writeRoleSwitchRequest } from "pi-roles/protocol";` at the top.
- After finding `approval`, the body becomes:
  ```ts
  writeRoleSwitchRequest(pi, {
    targetRole:    "pi-agent",
    reason:        "plannotator:plan-approved",
    sourceEntryId: approval.entry.id,
  });
  pi.appendEntry(PROCESSED_MARKER_PREFIX, {
    sourceEntryId: approval.entry.id,
    timestamp: Date.now(),
  });
  return; // no systemPrompt — pi-roles consumes the request itself
  ```
- The default `targetRole` is now hardcoded `"pi-agent"` (the old `plan-auto-switch.json` config file is no longer used; remove its load code). If you want to keep configurability, you can read `targetRole` from the existing `~/.pi/agent/plan-auto-switch.json` and pass it to `writeRoleSwitchRequest` — but that's optional; the design's default is `pi-agent`.

Add `"pi-roles": "^0.3.0"` to `~/.pi/agent/package.json` `dependencies` so the `pi-roles/protocol` subpath resolves at runtime in the agent's npm node_modules.

**test:** update `~/.pi/agent/extensions/__tests__/plan-auto-switch.test.ts`:
- Delete tests for `parseRoleTools` and `loadRoleForSwitch` (functions no longer exist).
- Keep `findUnprocessedPlanApproval` tests.
- Add: a test that the handler, given a session with an unprocessed `plannotator:plan-approved`, calls `writeRoleSwitchRequest` with `targetRole: "pi-agent"`, `reason: "plannotator:plan-approved"`, `sourceEntryId: <approval id>`, AND writes `plan-auto-switch:processed`. Mock the `pi-roles/protocol` import with a spy.

**Verification:** `cd ~/.pi/agent && bun test extensions/__tests__/plan-auto-switch.test.ts` passes. `bun build --no-bundle extensions/plan-auto-switch.ts` succeeds (compiles cleanly against the `pi-roles/protocol` import).

**Acceptance:** `attested` — paste the test + build output. Also `diff plan-auto-switch.ts.bak plan-auto-switch.ts` summary (line-count delta).

---

## Task 6 — new trigger `~/.pi/agent/extensions/prompt-role-switch.ts` + tests

Create `~/.pi/agent/extensions/prompt-role-switch.ts`:

- `import { writeRoleSwitchRequest } from "pi-roles/protocol";`
- `import { existsSync, readFileSync } from "node:fs";`
- `import { join, resolve, extname } from "node:path";`
- `import { homedir } from "node:os";`
- `import { parseFrontmatter } from "@earendil-works/pi-coding-agent";`

Implement `resolvePromptFile(name: string, cwd: string, agentDir: string, promptPaths: string[]): string | null`:
- Candidate dirs IN Pi's resolution order (global first, because Pi's `expandPromptTemplate` returns the first match, so global wins on collision — we must read the SAME file Pi expands):
  1. `join(agentDir, "prompts")` (global `~/.pi/agent/prompts/`)
  2. `resolve(cwd, ".pi", "prompts")` (project)
  3. each path in `promptPaths` (explicit) — can be a dir or a file
- For each candidate dir (in order), check for `<name>.md` (and `.mdx`). Return the FIRST existing file path. This mirrors Pi's "first match wins" behavior.
- For explicit paths that are files, match by basename without extension.
- Return `null` when nothing matches.

Handler:
```ts
pi.on("before_agent_start", async (event, ctx) => {
  const m = event.prompt.match(/^\s*\/([a-zA-Z0-9_-]+)/);
  if (!m) return;
  const name = m[1];
  // ctx may carry explicit prompt paths via event.systemPromptOptions or
  // a ctx.promptPaths — check the ExtensionContext type for a populated
  // field; if none is exposed, fall back to agentDir + cwd/.pi/prompts only.
  const promptPaths: string[] = (ctx as any).promptPaths ?? [];
  const agentDir = homedir() + "/.pi/agent"; // or read from ctx if exposed
  const file = resolvePromptFile(name, ctx.cwd, agentDir, promptPaths);
  if (!file) return;
  const { frontmatter } = parseFrontmatter<Record<string, unknown>>(readFileSync(file, "utf-8"));
  const role = frontmatter?.role;
  if (typeof role !== "string" || !role.trim()) return;
  writeRoleSwitchRequest(pi, { targetRole: role.trim(), reason: `prompt:${name}` });
  // No own processed-marker needed: writing the same request idempotently
  // per-invocation is acceptable because Pi only expands /prompt-name
  // once per user input. If duplicate-request protection turns out to
  // matter in practice (e.g. forked sessions re-emitting the same turn),
  // add a prompt-role-switch:processed marker keyed on the user-message
  // entry id in a follow-up.
});
```

**Open question to resolve during implementation:** does `ExtensionContext` (or `BeforeAgentStartEvent`) expose `agentDir` and the resolved `promptPaths`? Check `dist/core/extensions/types.d.ts` and `agent-session.js` for a populated field on `ctx` (e.g. `ctx.agentDir`, `ctx.promptPaths`, or via `event.systemPromptOptions`). If exposed, use it. If NOT exposed (likely), hardcode `homedir() + "/.pi/agent"` as the agent dir and only scan the two default prompt dirs (global + project) — drop the explicit-paths branch. Document the chosen source in a code comment.

**test:** `~/.pi/agent/extensions/__tests__/prompt-role-switch.test.ts`:
- `resolvePromptFile`:
  - (a) global only — returns global path when only global has the file.
  - (b) project only — returns project path when only project has it.
  - (c) global wins on collision (both dirs have the file → returns global path, mirroring Pi's first-match semantics).
  - (d) missing → `null`.
  - (e) explicit `promptPaths` dir resolves.
  - (f) explicit `promptPaths` file (by basename) resolves.
- Handler:
  - (a) prompt `/foo` with `role: ask` in its frontmatter → `writeRoleSwitchRequest` called with `targetRole: "ask"`, `reason: "prompt:foo"`.
  - (b) prompt with no `role:` frontmatter → no call.
  - (c) prompt name not found → no call.
  - (d) input not starting with `/` → no call.
  Mock `pi-roles/protocol`'s `writeRoleSwitchRequest` with a spy. Use a tmpdir fixture for prompt files.

**Verification:** `cd ~/.pi/agent && bun test extensions/__tests__/prompt-role-switch.test.ts` passes. `bun build --no-bundle extensions/prompt-role-switch.ts` succeeds.

**Acceptance:** `attested` — paste test + build output. Note in the commit/PR which `agentDir`/`promptPaths` source was used and whether it was exposed on `ctx`.

**Optional follow-up (not blocking):** If you decide to create the "general folder extension with `index.ts` that registers both `plan-auto-switch` and `prompt-role-switch`" (the user mentioned wanting this), do it as a separate task — keep the two standalone files working first.

---

## Task 7 — add `role: plan` frontmatter to `~/.pi/prompts/plan-fork-customization.md`

Read `~/.pi/prompts/plan-fork-customization.md`. Add a `role: plan` line to its existing YAML frontmatter (do NOT remove or change other fields). If it has no frontmatter, add one:
```yaml
---
role: plan
---
```

**test:** none (data file).

**Verification:** `cat ~/.pi/prompts/plan-fork-customization.md | head -10` shows the `role: plan` line in the frontmatter block.

**Acceptance:** `attested` — paste the head of the file.

---

## Task 8 — end-to-end verification against the actual Pi runtime

After Tasks 1–7 are complete and `pi-roles` v0.3.0 is installed in `~/.pi/agent/npm/node_modules/` (the user runs the install step), run a live repro:

1. Start Pi in the `~/.pi` cwd.
2. `/role plan` — switch to the plan role.
3. Have the LLM write a trivial plan and call `plan_submit`. Approve it in the browser.
4. Observe: the NEXT assistant turn should be in the `pi-agent` role automatically. Check:
   - `/role current` shows `pi-agent`.
   - The session log (latest `~/.pi/agent/sessions/*/*.jsonl`) shows, in order: `plannotator:plan-approved` → `pi-roles:switch-request` → `pi-roles:active-role { name: "pi-agent" }` → `pi-roles:switch-processed` → a `plan-auto-switch:processed` marker. The `pi-roles:active-role` must have `source: "user"` and NOT require a manual `/role pi-agent`.
5. Repeat for the prompt trigger: `/plan-fork-customization` (or whatever the prompt is named) — the session should auto-switch to `plan` role on the next turn. Check the session log shows `pi-roles:switch-request { targetRole: "plan", reason: "prompt:plan-fork-customization" }` → `pi-roles:active-role { name: "plan" }` → `pi-roles:switch-processed`.

**Acceptance:** `verified` — paste the relevant `grep -n` excerpt from the session log for both repros, showing the entry sequence.

If the switch doesn't happen, debug using the diagnose skill: the most likely failure is `pi-roles/protocol` not resolving at runtime (check `~/.pi/agent/npm/node_modules/pi-roles/dist/protocol.js` exists) OR the `ctx.agentDir`/promptPaths source being wrong for Task 6.

---

## Sequencing & dependencies

- Task 1 → Task 2 (build needs the file).
- Tasks 1+2 → Task 3 (consumer imports protocol).
- Task 3 → Task 4 (bump after code is done).
- Tasks 1+2 are sufficient for Tasks 5+6 to compile against `pi-roles/protocol` (they need v0.3.0 installed in the agent's node_modules; the user does the install after Task 4 publishes OR by running `bun install` against the local `pi-integrations/pi-roles` path — see "User-side install step" below).
- Task 7 is independent; can run anytime.
- Task 8 depends on all others + the install step.

**User-side install step (not a task — done by the user between Task 4 and Task 8):**
- Either: `cd ~/.pi/agent && bun install pi-roles@0.3.0` (if published to npm)
- Or: update `~/.pi/agent/settings.json` `packages` to point `pi-roles` at the local path `/home/abdwhb/projects/pi-integrations/pi-roles` (so it builds from source before publishing), then restart Pi so the package manager re-resolves and installs.

## Parallelism

Tasks 5 and 6 are independent (different files, both depend only on Tasks 1+2). They can be dispatched in parallel after Task 2 lands. Task 7 is independent of everything and can run anytime. Tasks 1–4 are sequential (each builds on the prior) and should NOT be parallelized.

## Risk register

- **R1 (medium):** `pi-roles/protocol` subpath doesn't resolve from another extension's module context under Pi's loader. Mitigation: Task 5's `bun build --no-bundle` catches compile-time resolution; Task 8's live repro catches runtime. Fallback: inline the `appendEntry` call with the literal string `"pi-roles:switch-request"` — the typed helper is a nicety, not a correctness requirement.
- **R2 (low):** `ctx.agentDir` / `promptPaths` not exposed on `ExtensionContext`. Mitigation: Task 6's open-question block already specifies the fallback (hardcode `~/.pi/agent`, scan only the two default dirs).
- **R3 (low):** `before_agent_start` ordering — trigger (rank 3) writes the request BEFORE pi-roles (rank 4) runs same turn. Verified in design via `runner.js:~L774` (sequential, same array) + `package-manager.js resourcePrecedenceRank`. No action unless Task 8 shows a one-turn delay (would mean `getEntries()` snapshots earlier — re-check `session-manager.js`).
- **R4 (low):** Fork-session re-emission duplicating a switch-request. Mitigation: the `pi-roles:switch-processed` marker is preserved across forks (entries are inherited), so a re-emitted request whose original was already processed is skipped. If a fresh fork writes a *new* request, that's correct behavior (the forked branch wants the switch too).