/**
 * pi-roles extension entry point.
 *
 * Wires together discovery (roles.ts), application (apply.ts), and settings
 * (settings.ts) into the three Pi integration points the role lifecycle
 * actually needs:
 *
 *   - `session_start` — restore from persisted state on reload/resume,
 *     otherwise resolve a role name from the precedence chain (pendingReset
 *     > --role > PI_ROLE > settings.defaultRole > built-in role-assistant)
 *     and apply it.
 *   - `before_agent_start` — re-inject the active role's body as the system
 *     prompt every turn (Pi rebuilds the prompt per turn; this is the
 *     stable hook).
 *   - `/role` command — list, current, reload, switch (with optional
 *     --reset to clear history first).
 *
 * The module-scoped state below is the source of truth for "what role is
 * live in this extension instance". Pi reloads spin up a fresh module, at
 * which point we restore from the most recent `pi-roles:active-role` entry
 * in the session log.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { applyRole, effectiveIntercomMode, resetSession, type RoleNotificationDetails } from "./apply.ts";
import { intercomPromptAddendum, isIntercomAvailable } from "./intercom.ts";
import { discoverRoles, resolveRole, RoleResolutionError } from "./roles.ts";
import {
  ACTIVE_ROLE_ENTRY_TYPE,
  BUILTIN_ROLE_DEFAULT_NAME,
  ROLE_NOTIFICATION_MESSAGE_TYPE,
  type ActiveRoleState,
  type PiRolesSettings,
  type RawRole,
  type ResolvedRole,
} from "./schemas.ts";
import { loadSettings } from "./settings.ts";
import { debugLog } from "./debug.ts";
import { formatSwitchRoleResult, validateRoleName } from "./switch-role.ts";
import { findUnprocessedSwitchRequest, ROLE_SWITCH_PROCESSED_TYPE } from "./protocol.ts";

const FLAG_NAME = "role";
const ENV_VAR = "PI_ROLE";
const SUBCOMMANDS = ["list", "current", "reload"] as const;

interface RuntimeState {
  /** Live role applied to this session, or null before first apply. */
  activeRole: ResolvedRole | null;
  /** Set by `/role <name> --reset` so the next session_start (reason="new") applies it. */
  pendingRoleAfterReset: string | null;
  /** Cached discovery result; refreshed on session_start, every `/role` invocation, and `/role reload`. */
  roles: RawRole[];
  /** Shadowed roles found at lower-precedence scopes; shown in `/role list`. */
  shadowed: { name: string; source: string; path: string }[];
  /** Cached settings for the current cwd; refreshed on session_start. */
  settings: PiRolesSettings;
}

export default function (pi: ExtensionAPI): void {
  const state: RuntimeState = {
    activeRole: null,
    pendingRoleAfterReset: null,
    roles: [],
    shadowed: [],
    settings: {},
  };

  /** Re-read settings + re-discover roles from disk. Centralized so every */
  /** entry point that needs fresh state ({@link session_start}, every `/role` */
  /** invocation, `/role reload`) goes through one path. */
  const refreshFromDisk = (cwd: string): void => {
    state.settings = loadSettings(cwd);
    const discovery = discoverRoles(cwd, state.settings.roleScope ?? "both");
    state.roles = discovery.roles;
    state.shadowed = discovery.shadowed;
  };

  // --------------------------------------------------------------------- flag
  pi.registerFlag(FLAG_NAME, {
    type: "string",
    description: "Launch as the named pi-roles role (e.g. --role architect).",
  });

  // ----------------------------------------------------------------- renderer
  // Render "Switched to role X" notifications as a single dim line. Without
  // this, the custom message type would surface as raw JSON in the TUI.
  pi.registerMessageRenderer<RoleNotificationDetails>(ROLE_NOTIFICATION_MESSAGE_TYPE, () => {
    // Returning `undefined` lets Pi fall back to the default custom-message
    // renderer, which prints `content`. That's exactly what we want — the
    // content string ("Switched to role X") is already user-facing. The
    // renderer is registered so `display: true` doesn't get treated as a
    // raw-JSON dump if a future Pi version starts requiring an explicit
    // renderer for custom types.
    return undefined;
  });

  // --------------------------------------------------------------- session_start
  pi.on("session_start", async (event, ctx) => {
    refreshFromDisk(ctx.cwd);

    const restored = findRestoredState(ctx);
    debugLog("index", `session_start reason=${event.reason}`, restored ? { name: restored.name } : undefined);

    // Restore precedence:
    let targetName: string | undefined;
    let silent = false;

    if (state.pendingRoleAfterReset) {
      targetName = state.pendingRoleAfterReset;
      state.pendingRoleAfterReset = null;
    } else if ((event.reason === "reload" || event.reason === "resume") && restored) {
      targetName = restored.name;
      silent = true;
    } else {
      targetName = pickInitialRoleName(pi, state.settings, state.roles);
      silent = event.reason === "startup";
    }

    await applyResolved(pi, ctx, state, targetName, { silent });
  });

  // ----------------------------------------------------------- before_agent_start
  //
  // We intentionally ignore `event.systemPrompt` (Pi's default coding-assistant
  // framing plus anything earlier extensions in the chain produced). The
  // founding goal of pi-roles is to make the role body authoritative — a
  // non-coding role (marketing, research, ops) must not inherit the default
  // "expert coding assistant" voice or it stops behaving like its description.
  //
  // Pi's docstring on BeforeAgentStartEventResult.systemPrompt says exactly
  // "Replace the system prompt for this turn"; that is what we do.
  // Subsequent extensions in the chain see our value as their
  // event.systemPrompt and may compose if they choose.
  //
  // already-running, no-model) internally.
  pi.on("before_agent_start", async (event, ctx) => {
    debugLog("index", "before_agent_start fired", {
      hasActiveRole: !!state.activeRole,
      promptLen: event?.prompt?.length ?? 0,
    });

    const switchReq = findUnprocessedSwitchRequest(ctx.sessionManager.getEntries());
    if (switchReq) {
      debugLog("index", "consumed switch-request", { targetRole: switchReq.data.targetRole, reason: switchReq.data.reason });
      await applyResolved(pi, ctx, state, switchReq.data.targetRole, {
        silent: false,
      });
      pi.appendEntry(ROLE_SWITCH_PROCESSED_TYPE, {
        sourceEntryId: switchReq.entry.id,
        timestamp: Date.now(),
      });
      return composeSystemPrompt(state, pi, event.systemPrompt, ctx);
    }

    return composeSystemPrompt(state, pi, event.systemPrompt, ctx);
  });

  // ---------------------------------------------------------------- /role
  pi.registerCommand("role", {
    description: "Switch session role. /role list | current | reload | <name> [--reset]",
    getArgumentCompletions: (prefix) => roleCompletions(prefix, state.roles),
    handler: async (args, ctx) => {
      // README guarantees "/role <name> always re-reads from disk". Refresh
      // before any subcommand so /list shows new files and /<name> picks up
      // edits without an explicit /role reload.
      refreshFromDisk(ctx.cwd);

      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0];

      if (!sub || sub === "list") {
        return handleList(ctx, state);
      }
      if (sub === "current") {
        return handleCurrent(ctx, state);
      }
      if (sub === "reload") {
        return handleReload(pi, ctx, state);
      }

      const wantsReset = tokens.includes("--reset");
      const name = sub;

      if (wantsReset) {
        // Set the pending pointer FIRST: ctx.newSession() invalidates
        // session-bound captured state and synchronously fires session_start
        // before returning, so we can't apply the role after newSession()
        // resolves and expect mid-session ordering to hold.
        state.pendingRoleAfterReset = name;
        const result = await resetSession(ctx);
        if (result.cancelled) {
          state.pendingRoleAfterReset = null;
          ctx.ui.notify(`Role switch to "${name}" cancelled.`, "info");
        }
        return;
      }

      await applyResolved(pi, ctx, state, name, { silent: false });
    },
  });

  // ---------------------------------------------------------------- switch_role tool
  // LLM-callable counterpart to `/role <name>`. Resolves and applies the
  // named role through the same `applyResolved` path as the command, so
  // model/thinking/tools/session-name are mutated identically. Unlike the
  // command, the tool does NOT support `--reset` — conversation history is
  // preserved so the LLM retains context across the handoff (e.g. from
  // planning to implementation).
  pi.registerTool({
    name: "switch_role",
    label: "Switch Role",
    description:
      "Switch the active session role programmatically. The named role must exist " +
      "in ~/.pi/agent/roles/ or .pi/roles/. Applies the role's model, thinking level, " +
      "tool set, and system prompt — same as the /role command but callable by the LLM. " +
      "Conversation history is preserved (no reset). Use this to hand off between " +
      "specialized roles (e.g. plan → pi-agent after plan approval).",
    parameters: Type.Object({
      roleName: Type.String({
        description:
          "Name of the role to switch to. Must match a role file name (without .md). " +
          "Use /role list to discover available roles.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const roleName = (params as { roleName?: string })?.roleName?.trim() ?? "";

      // Validate against discovered roles (refresh first so newly added
      // role files are visible without an explicit /role reload).
      refreshFromDisk(ctx.cwd);
      const validationError = validateRoleName(roleName, state.roles);
      if (validationError) {
        return {
          content: [{ type: "text", text: `Error: ${validationError}` }],
          details: { switched: false },
        };
      }

      // Apply through the shared path. Silent=true because the tool result
      // text already communicates the switch; a TUI banner would be noise.
      await applyResolved(pi, ctx, state, roleName, {
        silent: true,
        
      });

      // applyResolved returns void on success; warnings are surfaced via
      // ctx.ui.notify inside it. We compose a result text from the role
      // name and any warnings we can observe via the active role pointer.
      const warnings: string[] = [];
      if (ctx.hasUI) {
        // Warnings were already notified by applyResolved; we don't
        // duplicate them here. The result text is a clean confirmation.
      }
      const text = formatSwitchRoleResult(roleName, warnings);
      return {
        content: [{ type: "text", text }],
        details: { switched: true, roleName },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Role-name resolution
// ---------------------------------------------------------------------------

/**
 * Build the replacement system prompt for the current active role.
 *
 * Returns `undefined` when there's no active role (Pi keeps its default for
 * that turn). Otherwise returns `{ systemPrompt }` with the role body — and,
 * when intercom is requested AND the intercom tool is registered, a small
 * mode-specific addendum appended to the body.
 *
 * Exported for unit tests; the handler in `before_agent_start` is a one-line
 * delegation.
 */
export function composeSystemPrompt(
  state: Pick<RuntimeState, "activeRole" | "settings">,
  pi: Pick<ExtensionAPI, "getAllTools" | "getSessionName">,
  originalPrompt?: string,
  ctx?: any
): { systemPrompt: string } | undefined {
  if (!state.activeRole) return undefined;
  const body = state.activeRole.body;
  const mode = effectiveIntercomMode(state.activeRole, state.settings.intercomMode);
  const addendum =
    mode !== "off" && isIntercomAvailable(pi as ExtensionAPI)
      ? intercomPromptAddendum(mode, pi.getSessionName())
      : "";
      
  const parts = [];
  
  if (state.settings.enableSystemPromptAppend !== false) {
    if (originalPrompt) {
      parts.push(originalPrompt);
    } else if (ctx && ctx.hasUI) {
      ctx.ui.notify("pi-roles: enableSystemPromptAppend is true but no original system prompt was found to append.", "warning");
    }
  }
  
  parts.push(body);
  
  if (addendum) {
    parts.push(addendum);
  }
  
  const filteredParts = parts.filter((p) => p.length > 0);
  if (filteredParts.length === 0) return undefined;
  return { systemPrompt: filteredParts.join("\n\n") };
}

/**
 * Pick the role to launch with on a fresh session_start (no pendingReset, no
 * persisted state to restore). Precedence per BUILD-STATUS.md:
 *
 *   --role flag > PI_ROLE env > settings.defaultRole > built-in role-assistant
 *
 * If a configured `defaultRole` doesn't exist, we fall through to the
 * built-in rather than failing — a missing role shouldn't lock the user out
 * of the session.
 */
export function pickInitialRoleName(
  pi: ExtensionAPI,
  settings: PiRolesSettings,
  roles: RawRole[],
): string {
  const flagValue = pi.getFlag(FLAG_NAME);
  if (typeof flagValue === "string" && flagValue.length > 0) return flagValue;

  const env = process.env[ENV_VAR];
  if (env && env.length > 0) return env;

  const configured = settings.defaultRole;
  if (configured && roles.some((r) => r.frontmatter.name === configured)) {
    return configured;
  }

  return BUILTIN_ROLE_DEFAULT_NAME;
}

/**
 * Find the most recent `pi-roles:active-role` entry on the active branch.
 * Returns undefined when none exists or when entries can't be enumerated
 * (e.g. session_start hasn't fully bound the session manager yet).
 */
function findRestoredState(
  ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
): ActiveRoleState | undefined {
  let entries;
  try {
    entries = ctx.sessionManager.getEntries();
  } catch {
    return undefined;
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.type === "custom" && e.customType === ACTIVE_ROLE_ENTRY_TYPE) {
      return (e.data ?? undefined) as ActiveRoleState | undefined;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Apply wrapper
// ---------------------------------------------------------------------------

/**
 * Resolve a role name + apply it + update in-memory state. Centralized so
 * session_start, /role <name>, and /role reload share identical error
 * handling and warning surfacing.
 */
async function applyResolved(
  pi: ExtensionAPI,
  ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
  state: RuntimeState,
  name: string,
  options: { silent: boolean; },
): Promise<void> {
  let resolved: ResolvedRole;
  try {
    resolved = resolveRole(name, state.roles);
  } catch (err) {
    const message = err instanceof RoleResolutionError ? err.message : String(err);
    debugLog("index", `applyResolved fallback: ${message}`);
    // Fall back to built-in assistant if the requested role is missing or
    // broken. Surface the underlying error so the user can fix the file.
    if (ctx.hasUI) {
      ctx.ui.notify(`pi-roles: ${message} Falling back to ${BUILTIN_ROLE_DEFAULT_NAME}.`, "warning");
    }
    const fallback = state.roles.find((r) => r.frontmatter.name === BUILTIN_ROLE_DEFAULT_NAME && r.source === "built-in");
    if (!fallback) {
      // Built-in is missing too — bail without changing session state.
      return;
    }
    resolved = resolveRole(BUILTIN_ROLE_DEFAULT_NAME, state.roles);
  }

  const result = await applyRole(
    resolved,
    {
      pi,
      ctx,
      warnOnMissingMcp: state.settings.warnOnMissingMcp ?? true,
      intercomMode: state.settings.intercomMode,
    },
    options,
  );

  state.activeRole = resolved;

  debugLog("index", `applied role=${resolved.name}`, { warnings: result.warnings });

  if (ctx.hasUI && result.warnings.length > 0 && !options.silent) {
    // The notification message already mentions the warning count; surface
    // the actual text via ui.notify so the user sees what to fix without
    // expanding the message.
    for (const w of result.warnings) ctx.ui.notify(`pi-roles: ${w}`, "warning");
  }
}

// ---------------------------------------------------------------------------
// /role subcommands
// ---------------------------------------------------------------------------

async function handleList(
  ctx: ExtensionCommandContext,
  state: RuntimeState,
): Promise<void> {
  if (state.roles.length === 0) {
    ctx.ui.notify(
      "pi-roles: no roles found. Create one in .pi/roles/ or ~/.pi/agent/roles/.",
      "info",
    );
    return;
  }
  const lines = state.roles
    .slice()
    .sort((a, b) => a.frontmatter.name.localeCompare(b.frontmatter.name))
    .map((r) => {
      const marker = state.activeRole?.name === r.frontmatter.name ? "* " : "  ";
      return `${marker}${r.frontmatter.name} [${r.source}] — ${r.frontmatter.description}`;
    });
  const shadowed = state.shadowed.map(
    (s) => `  ${s.name} [${s.source}] (shadowed) — ${s.path}`,
  );
  const all =
    shadowed.length > 0
      ? ["Available roles:", ...lines, "", "Shadowed (lower-priority duplicates):", ...shadowed]
      : ["Available roles:", ...lines];
  ctx.ui.notify(all.join("\n"), "info");
}

async function handleCurrent(
  ctx: ExtensionCommandContext,
  state: RuntimeState,
): Promise<void> {
  if (!state.activeRole) {
    ctx.ui.notify("pi-roles: no role active.", "info");
    return;
  }
  const r = state.activeRole;
  const chain = r.extendsChain.length > 1 ? ` (extends: ${r.extendsChain.slice(1).join(" → ")})` : "";
  ctx.ui.notify(`pi-roles: ${r.name}${chain} — ${r.description}\n${r.path}`, "info");
}

async function handleReload(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: RuntimeState,
): Promise<void> {
  // Disk re-read already happened in the command handler prelude; just
  // re-apply against the freshly discovered set.
  const previous = state.activeRole?.name ?? pickInitialRoleName(pi, state.settings, state.roles);
  await applyResolved(pi, ctx, state, previous, {
    silent: false,
    
  });
}

// ---------------------------------------------------------------------------
// Autocompletion
// ---------------------------------------------------------------------------

/**
 * Provide tab completions for `/role <here>`. Combines built-in subcommands
 * with discovered role names; case-insensitive prefix match.
 */
export function roleCompletions(prefix: string, roles: RawRole[]): AutocompleteItem[] | null {
  const needle = prefix.toLowerCase();
  const items: AutocompleteItem[] = [];

  for (const sub of SUBCOMMANDS) {
    if (sub.toLowerCase().startsWith(needle)) {
      items.push({ value: sub, label: sub, description: subcommandDescription(sub) });
    }
  }
  for (const r of roles) {
    if (r.frontmatter.name.toLowerCase().startsWith(needle)) {
      items.push({
        value: r.frontmatter.name,
        label: r.frontmatter.name,
        description: `${r.source} — ${r.frontmatter.description}`,
      });
    }
  }
  return items.length > 0 ? items : null;
}

function subcommandDescription(sub: (typeof SUBCOMMANDS)[number]): string {
  switch (sub) {
    case "list":
      return "Show all available roles.";
    case "current":
      return "Show the active role.";
    case "reload":
      return "Re-read the active role file from disk.";
  }
}
