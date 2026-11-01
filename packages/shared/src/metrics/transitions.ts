// State machines for the metric layer, written as explicit typed transitions
// so API, web and edge code cannot invent a path (PRD §3 DASH-01/SH-02).
// An invalid transition is a CONFLICT (409), same as every other domain.

import { CoreError } from "../core/index.ts";
import type { MetricDefinitionStatus, MetricFinality } from "./schemas.ts";

/**
 * Registry lifecycle: a draft definition is reviewed, activated, and later
 * deprecated. Deprecated definitions keep answering historical reports but are
 * never offered for new charts; reactivation requires a new version.
 */
export const metricDefinitionTransitions = {
  draft: ["active"],
  active: ["deprecated"],
  deprecated: [],
} as const satisfies Record<
  MetricDefinitionStatus,
  readonly MetricDefinitionStatus[]
>;

/** A value is computed as an estimate and can only move forward to final. */
export const metricFinalityTransitions = {
  estimate: ["final"],
  final: [],
} as const satisfies Record<MetricFinality, readonly MetricFinality[]>;

function allows<State extends string>(
  transitions: Readonly<Record<State, readonly State[]>>,
  from: State,
  to: State,
): boolean {
  return (transitions[from] as readonly State[]).includes(to);
}

export function canTransitionMetricDefinitionStatus(
  from: MetricDefinitionStatus,
  to: MetricDefinitionStatus,
): boolean {
  return allows(metricDefinitionTransitions, from, to);
}

/** Returns the next status; throws CoreError CONFLICT for an invalid move. */
export function transitionMetricDefinitionStatus(
  from: MetricDefinitionStatus,
  to: MetricDefinitionStatus,
): MetricDefinitionStatus {
  if (!canTransitionMetricDefinitionStatus(from, to))
    throw new CoreError(
      "CONFLICT",
      `Metric definition cannot move from ${from} to ${to}.`,
    );
  return to;
}

export function canTransitionMetricFinality(
  from: MetricFinality,
  to: MetricFinality,
): boolean {
  return allows(metricFinalityTransitions, from, to);
}

/**
 * Returns the next finality; throws CoreError CONFLICT when a final value
 * would be reopened. Corrections are new values, not a status rollback.
 */
export function transitionMetricFinality(
  from: MetricFinality,
  to: MetricFinality,
): MetricFinality {
  if (!canTransitionMetricFinality(from, to))
    throw new CoreError(
      "CONFLICT",
      `Metric value cannot move from ${from} to ${to}.`,
    );
  return to;
}
