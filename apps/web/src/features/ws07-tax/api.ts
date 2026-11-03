// One typed caller per tax endpoint the recap screen uses (docs/frontend.md
// "Typed endpoints and mock mode"). Responses are unwrapped from their `{ data }`
// envelope so components and query options never see it. Components never call
// these directly: they use the hooks in ./hooks.ts, which own cache keys and
// invalidation.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { createUlid } from "@starter/shared/core";
import {
  exportTaxReport as exportTaxReportEndpoint,
  finalizeTaxReport as finalizeTaxReportEndpoint,
  generateTaxReport as generateTaxReportEndpoint,
  listTaxReports as listTaxReportsEndpoint,
} from "@starter/shared/accounting";
import { callEndpoint } from "@/lib/api/endpoint";

type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

/** Every report of the legal entity; the screen groups them by period. */
export async function fetchTaxReports(
  legalEntityId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    listTaxReportsEndpoint,
    {
      query: { legalEntityId } as Query<typeof listTaxReportsEndpoint>,
    },
    { signal },
  );
  return response.data;
}

/**
 * Generates the period's recap as a draft. The contract input carries no
 * idempotency key (generateTaxReport is the one write without one); the server
 * treats an existing draft for the same type+period as the same recap.
 */
export async function generateTaxReport(
  body: Body<typeof generateTaxReportEndpoint>,
) {
  const response = await callEndpoint(generateTaxReportEndpoint, { body });
  return response.data;
}

/** draft → final; the API refuses when the fiscal period is still open. */
export async function finalizeTaxReport(taxReportId: string) {
  const response = await callEndpoint(finalizeTaxReportEndpoint, {
    params: { taxReportId } as Params<typeof finalizeTaxReportEndpoint>,
    body: { idempotencyKey: createUlid() },
  });
  return response.data;
}

/** final (or exported) → exported; returns the export artifact metadata. */
export async function exportTaxReport(taxReportId: string) {
  const response = await callEndpoint(exportTaxReportEndpoint, {
    params: { taxReportId } as Params<typeof exportTaxReportEndpoint>,
    body: { idempotencyKey: createUlid() },
  });
  return response.data;
}
