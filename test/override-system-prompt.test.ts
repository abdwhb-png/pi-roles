import { describe, it, expect, vi } from "vitest";
import { composeSystemPrompt } from "../src/index.ts";
import type { PiRolesSettings, ResolvedRole } from "../src/schemas.ts";

function makeRole(overrides: Partial<ResolvedRole> = {}): ResolvedRole {
  return {
    body: "Role Body",
    name: "test",
    description: "test role",
    extendsChain: [],
    source: "project",
    path: "/roles/test.md",
    tools: { kind: "inherit" },
    ...overrides,
  };
}

function compose(settings: PiRolesSettings, originalPrompt = "Original Prompt") {
  const state = { activeRole: makeRole(), settings };
  const pi = { getAllTools: vi.fn(), getSessionName: vi.fn() };
  return composeSystemPrompt(state, pi as any, originalPrompt)?.systemPrompt;
}

describe("composeSystemPrompt", () => {
  it("returns undefined with no active role", () => {
    const state = { activeRole: null, settings: {} };
    const pi = { getAllTools: vi.fn(), getSessionName: vi.fn() };

    const result = composeSystemPrompt(state, pi as any);

    expect(result).toBeUndefined();
  });

  it("uses strict additive mode by default", () => {
    const systemPrompt = compose({});

    expect(systemPrompt).toContain("Original Prompt");
    expect(systemPrompt).toContain("# pi-roles Instruction Priority");
    expect(systemPrompt).toContain("# Active Role: test");
    expect(systemPrompt).toContain("Role Body");
    expect(systemPrompt).toContain("# pi-roles Final Reminder");
    expect(systemPrompt?.indexOf("Original Prompt")).toBeLessThan(systemPrompt?.indexOf("# Active Role: test") ?? 0);
  });

  it("states that core invariants win over the role", () => {
    const systemPrompt = compose({});

    expect(systemPrompt).toContain("core invariants win");
  });

  it("keeps enableSystemPromptAppend true logically additive", () => {
    const systemPrompt = compose({ enableSystemPromptAppend: true });

    expect(systemPrompt).toContain("Original Prompt");
    expect(systemPrompt).toContain("# Active Role: test");
    expect(systemPrompt).toContain("Role Body");
  });

  it("keeps enableSystemPromptAppend false logically replacement", () => {
    const systemPrompt = compose({ enableSystemPromptAppend: false });

    expect(systemPrompt).toBe("Role Body");
  });

  it("lets systemPromptMode override legacy enableSystemPromptAppend", () => {
    const systemPrompt = compose({
      enableSystemPromptAppend: false,
      systemPromptMode: "strict-additive",
    });

    expect(systemPrompt).toContain("Original Prompt");
    expect(systemPrompt).toContain("# Active Role: test");
  });

  it("supports role-last mode", () => {
    const systemPrompt = compose({ systemPromptMode: "role-last" });

    expect(systemPrompt).toContain("Original Prompt");
    expect(systemPrompt).toContain("# pi-roles Instruction Priority");
    expect(systemPrompt).toContain("# Active Role: test");
    expect(systemPrompt).toContain("# pi-roles Final Reminder");
    expect(systemPrompt?.indexOf("# Active Role: test")).toBeLessThan(systemPrompt?.indexOf("# pi-roles Final Reminder") ?? 0);
  });

  it("supports legacy replacement mode", () => {
    const systemPrompt = compose({ systemPromptMode: "legacy-replace" });

    expect(systemPrompt).toBe("Role Body");
  });
});
