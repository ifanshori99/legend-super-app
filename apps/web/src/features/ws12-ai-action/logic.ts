// Pure logic for the AI action request screens. No React, router or framework
// imports: tests load this file directly with native Node type stripping.
import type { ActionRequestStatus } from "@starter/shared/ai";

export type ActionStatusTone =
  "waiting" | "info" | "success" | "danger" | "muted";

const STATUS_TONE: Record<ActionRequestStatus, ActionStatusTone> = {
  pending: "waiting",
  approved: "info",
  executed: "success",
  rejected: "danger",
  failed: "danger",
  expired: "muted",
};

/** Tone and catalog key of one action request status (always shown with an icon and text). */
export function actionStatusView(status: ActionRequestStatus): {
  tone: ActionStatusTone;
  labelKey: string;
} {
  return { tone: STATUS_TONE[status], labelKey: `aiAction.status.${status}` };
}

const CHANGE_SEPARATOR = " → ";

/**
 * A summary value written as "before → after" is a change; anything else is a
 * plain value. Lets the draft view show a diff without reading the raw payload.
 */
export function splitChange(
  value: string,
): { before: string; after: string } | null {
  const index = value.indexOf(CHANGE_SEPARATOR);
  if (index <= 0) return null;
  const before = value.slice(0, index).trim();
  const after = value.slice(index + CHANGE_SEPARATOR.length).trim();
  if (before === "" || after === "") return null;
  return { before, after };
}
