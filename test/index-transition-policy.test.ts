import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedRole } from "../src/schemas.ts";
import { registerRoleTransitionPolicy } from "../src/transition-policy.ts";

const mocks = vi.hoisted(() => ({
  applyRole: vi.fn(),
  resetSession: vi.fn(async () => ({ cancelled: false })),
  roles: new Map<string, ResolvedRole>(),
}));

vi.mock("../src/apply.ts", () => ({
  applyRole: mocks.applyRole,
  effectiveIntercomMode: () => "off",
  resetSession: mocks.resetSession,
}));

vi.mock("../src/roles.ts", () => ({
  discoverRoles: () => ({ roles: [], shadowed: [] }),
  resolveRole: (name: string) => {
    const role = mocks.roles.get(name);
    if (!role) throw new Error(`missing role: ${name}`);
    return role;
  },
  RoleResolutionError: class RoleResolutionError extends Error {},
}));

vi.mock("../src/widget.ts", () => ({
  refreshRoleWidget: vi.fn(),
  removeRoleWidget: vi.fn(),
}));

vi.mock("../src/intercom.ts", () => ({
  effectiveIntercomMode: () => "off",
  intercomPromptAddendum: () => "",
  isIntercomAvailable: () => false,
}));

vi.mock("../src/settings.ts", () => ({ loadSettings: () => ({}) }));
vi.mock("../src/debug.ts", () => ({ debugLog: vi.fn() }));
vi.mock("../src/switch-role.ts", () => ({
  formatSwitchRoleResult: (name: string) => `Switched to ${name}`,
  validateRoleName: () => undefined,
}));

const { default: piRoles } = await import("../src/index.ts");

function role(name: string): ResolvedRole {
  return {
    name,
    description: name,
    tools: { kind: "inherit" },
    body: "",
    source: "project",
    path: `/roles/${name}.md`,
    extendsChain: [],
  };
}

function setup() {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const tools = new Map<string, { execute: (...args: any[]) => Promise<unknown> }>();
  const entries: Array<{ type: string; customType?: string; data?: unknown; id: string }> = [];
  let nextId = 1;
  const pi = {
    registerFlag: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: (event: string, handler: (event: any, ctx: any) => unknown) => handlers.set(event, handler),
    registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => commands.set(name, command),
    registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<unknown> }) => tools.set(tool.name, tool),
    appendEntry: (customType: string, data?: unknown) => entries.push({
      type: "custom",
      customType,
      data,
      id: `entry-${nextId++}`,
    }),
    getFlag: () => undefined,
    getAllTools: () => [],
    getSessionName: () => undefined,
    sendMessage: vi.fn(),
  } as any;
  const ctx = {
    cwd: "/workspace",
    hasUI: false,
    sessionManager: { getEntries: () => entries },
    ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
  } as any;

  piRoles(pi);
  return { handlers, commands, tools, entries, pi, ctx };
}

describe("pi-roles transition policy integration", () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    while (disposers.length > 0) disposers.pop()!();
    mocks.applyRole.mockReset();
    mocks.resetSession.mockReset();
    mocks.resetSession.mockResolvedValue({ cancelled: false });
    mocks.roles.clear();
  });

  it("leaves a denied switch request unprocessed and does not apply the target role", async () => {
    mocks.roles.set("pi-agent", role("pi-agent"));
    const { handlers, entries, ctx } = setup();
    entries.push({
      type: "custom",
      customType: "pi-roles:switch-request",
      data: { targetRole: "pi-agent", reason: "test", timestamp: Date.now() },
      id: "request-1",
    });
    disposers.push(registerRoleTransitionPolicy(() => ({ allow: false, reason: "Approval required." })));

    await handlers.get("before_agent_start")!({ systemPrompt: "base" }, ctx);

    expect(mocks.applyRole).not.toHaveBeenCalled();
    expect(entries.some((entry) => entry.customType === "pi-roles:switch-processed")).toBe(false);
  });

  it("blocks a direct /role transition before applying the target role", async () => {
    mocks.roles.set("pi-agent", role("pi-agent"));
    const { commands, ctx } = setup();
    disposers.push(registerRoleTransitionPolicy(() => ({ allow: false, reason: "Approval required." })));

    await commands.get("role")!.handler("pi-agent", ctx);

    expect(mocks.applyRole).not.toHaveBeenCalled();
  });

  it("blocks the switch_role tool before applying the target role", async () => {
    mocks.roles.set("pi-agent", role("pi-agent"));
    const { tools, ctx } = setup();
    disposers.push(registerRoleTransitionPolicy(() => ({ allow: false, reason: "Approval required." })));

    const result = await tools.get("switch_role")!.execute("call-1", { roleName: "pi-agent" }, undefined, undefined, ctx) as any;

    expect(result.details).toEqual({ switched: false, reason: "Approval required." });
    expect(mocks.applyRole).not.toHaveBeenCalled();
  });

  it("blocks /role --reset before it can discard the guarded session", async () => {
    mocks.roles.set("pi-agent", role("pi-agent"));
    const { commands, ctx } = setup();
    disposers.push(registerRoleTransitionPolicy(() => ({ allow: false, reason: "Approval required." })));

    await commands.get("role")!.handler("pi-agent --reset", ctx);

    expect(mocks.resetSession).not.toHaveBeenCalled();
    expect(mocks.applyRole).not.toHaveBeenCalled();
  });
});
