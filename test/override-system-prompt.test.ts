import { describe, it, expect, vi } from "vitest";
import { composeSystemPrompt } from "../src/index.ts";
import type { ResolvedRole } from "../src/schemas.ts";

describe("composeSystemPrompt override", () => {
  it("should return undefined if no active role", () => {
    const state = { activeRole: null, settings: {} };
    const pi = { getAllTools: vi.fn(), getSessionName: vi.fn() };
    const result = composeSystemPrompt(state as any, pi as any);
    expect(result).toBeUndefined();
  });

  it("should append original prompt when enableSystemPromptAppend is true", () => {
    const role = { 
        body: "Role Body", 
        name: "test", 
        description: "test", 
        extendsChain: [], 
        source: "project",
        path: "",
        frontmatter: { name: "test", description: "test" }
    };
    const state = { activeRole: role, settings: { enableSystemPromptAppend: true } };
    const pi = { getAllTools: vi.fn(), getSessionName: vi.fn() };
    const result = composeSystemPrompt(state as any, pi as any, "Original Prompt");
    expect(result?.systemPrompt).toBe("Original Prompt\n\nRole Body");
  });
  
  it("should ignore original prompt when enableSystemPromptAppend is false", () => {
    const role = { 
        body: "Role Body", 
        name: "test", 
        description: "test", 
        extendsChain: [], 
        source: "project",
        path: "",
        frontmatter: { name: "test", description: "test" }
    };
    const state = { activeRole: role, settings: { enableSystemPromptAppend: false } };
    const pi = { getAllTools: vi.fn(), getSessionName: vi.fn() };
    const result = composeSystemPrompt(state as any, pi as any, "Original Prompt");
    expect(result?.systemPrompt).toBe("Role Body");
  });

  it("should append original prompt by default when setting is missing", () => {
    const role = { 
        body: "Role Body", 
        name: "test", 
        description: "test", 
        extendsChain: [], 
        source: "project",
        path: "",
        frontmatter: { name: "test", description: "test" }
    };
    const state = { activeRole: role, settings: {} };
    const pi = { getAllTools: vi.fn(), getSessionName: vi.fn() };
    const result = composeSystemPrompt(state as any, pi as any, "Original Prompt");
    expect(result?.systemPrompt).toBe("Original Prompt\n\nRole Body");
  });
});
