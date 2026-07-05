/**
 * Role widget — renders the active role name as a widget above the editor.
 *
 * Uses pi's native `ctx.ui.setWidget` API. No external dependencies.
 * Controlled by the `showWidget` setting (default: true).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET_ID = "pi-roles.active-role";

/** Minimal shape accepted by the widget renderer. */
interface RoleName { name: string }

/**
 * Compose the widget text for rendering. Returns undefined when no role
 * is active (widget is cleared).
 */
export function renderRoleWidget(role: RoleName | null): string | undefined {
  if (!role) return undefined;
  return `🎭 Role: ${role.name}`;
}

/**
 * Refresh the role widget for the given context.
 *
 * When `showWidget` is false or no role is active, the widget is cleared.
 */
export function refreshRoleWidget(
  ctx: ExtensionContext,
  role: RoleName | null,
  showWidget: boolean,
): void {
  if (!ctx.hasUI) return;

  if (!showWidget || !role) {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    return;
  }

  const text = renderRoleWidget(role);
  ctx.ui.setWidget(WIDGET_ID, text ? [text] : undefined);
}

/**
 * Remove the widget (called on session shutdown).
 */
export function removeRoleWidget(ctx: ExtensionContext): void {
  if (ctx.hasUI) {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }
}
