// Bridge between a checklist task action and the mock runtime.
//
// Completing, blocking, unblocking or waiving a task has no endpoint yet
// (PRD §3 D26 describes the checklist, but no `POST .../checklist-tasks/:id`
// route exists in @starter/shared/hris; follow-up bead). Until it lands the
// buttons are a local preview: ./mock.ts registers a writer against the mock
// runtime's store, so a click persists in mock mode and a refetch shows it.
//
// A real session has no writer, so `runLocalTaskAction` returns null and the
// mutation fails closed instead of pretending a task was saved. This module
// carries no fixture and no React, so a production build bundles only the two
// tiny functions below.
import type { ChecklistAction, ChecklistTask } from "@starter/shared/hris";

export type LocalTaskActionInput = {
  taskId: string;
  action: ChecklistAction;
};

/** Applies the contract's transition to the local store; null when unknown. */
export type LocalTaskActionWriter = (
  input: LocalTaskActionInput,
) => ChecklistTask | null;

let writer: LocalTaskActionWriter | null = null;

export function registerLocalTaskAction(next: LocalTaskActionWriter): void {
  writer = next;
}

export function runLocalTaskAction(
  input: LocalTaskActionInput,
): ChecklistTask | null {
  return writer === null ? null : writer(input);
}
