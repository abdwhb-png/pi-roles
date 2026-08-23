import type { ResolvedRole } from "./schemas.ts";

export type RoleTransitionKind = "manual" | "request" | "startup" | "restore";

export interface RoleTransition {
  kind: RoleTransitionKind;
  reason?: string;
  sourceEntryId?: string;
}

export interface RoleTransitionPolicyInput {
  from: ResolvedRole | null;
  to: ResolvedRole;
  transition: RoleTransition;
  sessionEntries: readonly unknown[];
}

export type RoleTransitionDecision =
  | { allow: true }
  | { allow: false; reason: string };

export type RoleTransitionPolicy = (
  input: RoleTransitionPolicyInput,
) => RoleTransitionDecision | Promise<RoleTransitionDecision>;

interface RoleTransitionPolicyRegistry {
  policies: Map<string, RoleTransitionPolicy>;
  nextAnonymousKey: number;
}

const REGISTRY_KEY = Symbol.for("pi-roles.transition-policies.v1");

function getRegistry(): RoleTransitionPolicyRegistry {
  const current = (globalThis as Record<PropertyKey, unknown>)[REGISTRY_KEY];
  if (current && typeof current === "object" && "policies" in current) {
    return current as RoleTransitionPolicyRegistry;
  }

  const registry: RoleTransitionPolicyRegistry = {
    policies: new Map(),
    nextAnonymousKey: 0,
  };
  (globalThis as Record<PropertyKey, unknown>)[REGISTRY_KEY] = registry;
  return registry;
}

export function registerRoleTransitionPolicy(
  policy: RoleTransitionPolicy,
  key?: string,
): () => void {
  const registry = getRegistry();
  const registrationKey = key ?? `anonymous:${++registry.nextAnonymousKey}`;
  registry.policies.set(registrationKey, policy);
  return () => {
    if (registry.policies.get(registrationKey) === policy) {
      registry.policies.delete(registrationKey);
    }
  };
}

export async function evaluateRoleTransitionPolicies(
  input: RoleTransitionPolicyInput,
): Promise<RoleTransitionDecision> {
  for (const policy of [...getRegistry().policies.values()]) {
    const decision = await policy(input);
    if (!decision.allow) return decision;
  }
  return { allow: true };
}

export async function authorizeRoleTransition(
  input: RoleTransitionPolicyInput,
): Promise<RoleTransitionDecision> {
  if (input.transition.kind === "startup" || input.transition.kind === "restore") {
    return { allow: true };
  }
  return evaluateRoleTransitionPolicies(input);
}
