import { afterEach, describe, expect, it } from "vitest";
import {
  authorizeRoleTransition,
  evaluateRoleTransitionPolicies,
  registerRoleTransitionPolicy,
} from "../src/transition-policy.ts";

const input = {
  from: null,
  to: {
    name: "pi-agent",
    description: "Agent",
    tools: { kind: "inherit" as const },
    body: "",
    source: "project" as const,
    path: "/roles/pi-agent.md",
    extendsChain: [],
  },
  transition: { kind: "manual" as const },
  sessionEntries: [],
};

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()!();
});

describe("role transition policies", () => {
  it("allows transitions when no policy is registered", async () => {
    await expect(evaluateRoleTransitionPolicies(input)).resolves.toEqual({ allow: true });
  });

  it("returns the first policy denial", async () => {
    disposers.push(
      registerRoleTransitionPolicy(() => ({
        allow: false,
        reason: "Plan approval is required.",
      })),
    );

    await expect(evaluateRoleTransitionPolicies(input)).resolves.toEqual({
      allow: false,
      reason: "Plan approval is required.",
    });
  });

  it("stops applying a policy after its disposer runs", async () => {
    const dispose = registerRoleTransitionPolicy(() => ({
      allow: false,
      reason: "Blocked.",
    }));
    dispose();

    await expect(evaluateRoleTransitionPolicies(input)).resolves.toEqual({ allow: true });
  });

  it("replaces a named policy when an extension reloads", async () => {
    disposers.push(
      registerRoleTransitionPolicy(
        () => ({ allow: false, reason: "Stale policy." }),
        "plan-submission-guard",
      ),
    );
    disposers.push(
      registerRoleTransitionPolicy(
        () => ({ allow: false, reason: "Current policy." }),
        "plan-submission-guard",
      ),
    );

    await expect(evaluateRoleTransitionPolicies(input)).resolves.toEqual({
      allow: false,
      reason: "Current policy.",
    });
  });

  it("bypasses policies during startup and restoration", async () => {
    disposers.push(
      registerRoleTransitionPolicy(() => ({
        allow: false,
        reason: "Must not run.",
      })),
    );

    await expect(
      authorizeRoleTransition({ ...input, transition: { kind: "startup" } }),
    ).resolves.toEqual({ allow: true });
    await expect(
      authorizeRoleTransition({ ...input, transition: { kind: "restore" } }),
    ).resolves.toEqual({ allow: true });
  });

  it("enforces policies for manual and request transitions", async () => {
    disposers.push(
      registerRoleTransitionPolicy(() => ({
        allow: false,
        reason: "Approval missing.",
      })),
    );

    await expect(authorizeRoleTransition(input)).resolves.toEqual({
      allow: false,
      reason: "Approval missing.",
    });
    await expect(
      authorizeRoleTransition({ ...input, transition: { kind: "request" } }),
    ).resolves.toEqual({
      allow: false,
      reason: "Approval missing.",
    });
  });
});
