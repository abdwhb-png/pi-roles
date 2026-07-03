#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "fs";
const file = "/home/abdwhb/projects/pi-integrations/pi-roles/src/index.ts";
let text = readFileSync(file, "utf-8");

text = text.replace(
  "      return composeSystemPrompt(state, pi);",
  "      return composeSystemPrompt(state, pi, event.systemPrompt, ctx);"
);

text = text.replace(
  "    return composeSystemPrompt(state, pi);",
  "    return composeSystemPrompt(state, pi, event.systemPrompt, ctx);"
);

text = text.replace(
  `export function composeSystemPrompt(
  state: Pick<RuntimeState, "activeRole" | "settings">,
  pi: Pick<ExtensionAPI, "getAllTools" | "getSessionName">,
): { systemPrompt: string } | undefined {
  if (!state.activeRole) return undefined;
  const body = state.activeRole.body;
  const mode = effectiveIntercomMode(state.activeRole, state.settings.intercomMode);
  const addendum =
    mode !== "off" && isIntercomAvailable(pi as ExtensionAPI)
      ? intercomPromptAddendum(mode, pi.getSessionName())
      : "";
  const parts = [body, addendum].filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  return { systemPrompt: parts.join("\\n\\n") };
}`,
  `export function composeSystemPrompt(
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
  return { systemPrompt: filteredParts.join("\\n\\n") };
}`
);

writeFileSync(file, text);
