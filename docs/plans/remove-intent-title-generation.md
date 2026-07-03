# Remove Intent / Title Generation

## Why

User dislikes `"Intent not defined - <role>"` in status bar. Intent (first-msg summary) never useful — inaccurate, user never sees it. Want just role name.

**Decision**: Remove entire intent/title generation. Status bar = role name only. Session name = role name only. Delete `src/title.ts`. Clean all refs.

---

## Source changes

| File | Change |
|---|---|
| `src/schemas.ts` | Delete `INTENT_PLACEHOLDER`. Remove `intent` from `ActiveRoleState`. Keep `titleModel` in settings (backwards compat, ignored). |
| `src/apply.ts` | `composeFooterStatus(roleName)` → `roleName`. `composeSessionName(roleName)` → `roleName`. Remove `preservedIntent` from `ApplyOptions`. Drop `INTENT_PLACEHOLDER` import. Simplify `applyRole` step 4/5/persist. |
| `src/title.ts` | **Delete** — `generateAndApplyTitle`, `extractTitle`, `TITLE_SYSTEM_PROMPT`, `resolveTitleModel`, `TitleStateRef`, `TitleArgs`. |
| `src/index.ts` | Remove `intent`, `titleInFlight`, `titleErrorShown` from `RuntimeState`. Remove `generateAndApplyTitle` import/call in `before_agent_start`. Remove `preservedIntent` in `session_start`/`applyResolved`. Drop `INTENT_PLACEHOLDER` import. |

## Test changes

| File | Change |
|---|---|
| `test/apply.test.ts` | Update `composeFooterStatus` — no intent param, returns role name. Update `composeSessionName` — same. Remove `preservedIntent` test. Update `applyRole` expectations. |
| `test/title.test.ts` | **Delete** (37 tests gone). |
| `test/index.test.ts` | Verify no intent refs (should be clean). |

## Doc changes

| File | Change |
|---|---|
| `README.md` | Remove `titleModel` setting. Remove session naming / title gen sections. Remove intent refs. Update examples. |
| `BUILD-STATUS.md` | Mark Phase 5 **removed**. Remove all intent/title-gen refs. Update session naming to `role-name`. Remove correction notes 15, 17. |
| `MAP.md` | Remove `src/title.ts` and `test/title.test.ts` entries. |
| `CHANGELOG.md` | Add removal entry. Update past entries (keep history). |
| `ARCHITECTURE.md` | Check + remove intent refs. |
| `openspec/specs/session-identity/spec.md` | Rewrite — session identity = role name only. No intent, no placeholder, no title gen. |

**Keep archived**: `openspec/changes/archive/2026-05-05-fix-session-identity-and-packaging/` — history.

---

## Order

1. Source: schemas.ts → apply.ts → index.ts → delete title.ts
2. Tests: apply.test.ts → delete title.test.ts → verify index.test.ts
3. Docs: openspec/spec → README → BUILD-STATUS → MAP → CHANGELOG → ARCHITECTURE
4. Verify: full test suite, typecheck, linter

---

## Verification

- `composeFooterStatus("architect")` → `"architect"`
- `composeSessionName("architect")` → `"architect"`
- No `INTENT_PLACEHOLDER` / `generateAndApplyTitle` refs in source
- `src/title.ts` + `test/title.test.ts` deleted
- 88 tests pass (125 - 37 title tests)
- Typecheck + linter pass
