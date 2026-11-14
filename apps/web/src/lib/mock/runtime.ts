import {
  CoreError,
  coreErrorHttpStatus,
  type CoreErrorCode,
} from "@starter/shared/core";
import { zodIssuesToDetails } from "@starter/shared/api";
import { AccountingError } from "@starter/shared/accounting";
import type { z } from "zod";
import type { CallHeaders } from "../api/endpoint-core.ts";
import { ApiError, NETWORK_ERROR_MESSAGE } from "../api/errors.ts";
import {
  getLatencyMs,
  getScenario,
  resetControl,
  takeFailure,
} from "./control.ts";
import { findMock } from "./registry.ts";
import { resetMockStores } from "./store.ts";

export type MockRequest = {
  method: string;
  /** Pathname only, e.g. "/api/example/outlets". */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  headers?: CallHeaders;
};

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function validate(schema: z.ZodType, value: unknown, where: string) {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      `Input ${where} tidak valid.`,
      zodIssuesToDetails(result.error),
    );
  return result.data;
}

// Recognize domain errors centrally so every registered handler, including
// async handlers, has the same client-visible refusal as the real API.
// Only explicit domain classes may expose their code and safe message.
const domainErrorMappers: ReadonlyArray<
  (error: unknown) => ApiError | undefined
> = [
  (error) =>
    error instanceof AccountingError
      ? new ApiError(error.status, error.code, error.message)
      : undefined,
];

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof CoreError)
    return new ApiError(error.status, error.code, error.message);
  for (const mapDomainError of domainErrorMappers) {
    const mapped = mapDomainError(error);
    if (mapped) return mapped;
  }
  console.error("[mock] handler threw", error);
  return new ApiError(
    coreErrorHttpStatus.INTERNAL_ERROR,
    "INTERNAL_ERROR" satisfies CoreErrorCode,
    "Terjadi kesalahan pada mock handler.",
  );
}

/**
 * Serves one request from the registered mocks, behaving like the real API:
 * scenario/fault injection, latency, input validation with the endpoint's
 * schemas (strict: a submitted tenantId is rejected), response validation, and
 * a JSON round trip so handlers can neither leak store references nor return
 * values JSON cannot carry.
 */
export async function dispatchMock(request: MockRequest): Promise<unknown> {
  const { signal } = request;
  const scenario = getScenario();
  await delay(getLatencyMs(), signal);

  if (scenario === "offline")
    throw new ApiError(0, "NETWORK_ERROR", NETWORK_ERROR_MESSAGE);
  if (scenario === "error")
    throw new ApiError(
      500,
      "INTERNAL_ERROR",
      "Terjadi kesalahan pada server. Coba lagi sebentar lagi.",
    );

  const found = findMock(request.method, request.path);
  if (!found)
    throw new ApiError(
      404,
      "NOT_FOUND",
      `Mock belum terdaftar untuk ${request.method} ${request.path}. Tambahkan registerMock di features/<fitur>/mock.ts.`,
    );
  const { endpoint, handler } = found.entry;

  const forced = takeFailure(endpoint.id);
  if (forced)
    throw new ApiError(
      forced.status,
      forced.code,
      forced.message ?? "Permintaan gagal (disimulasikan).",
    );

  const params = endpoint.params
    ? validate(endpoint.params, found.params, "path")
    : undefined;
  const query = endpoint.query
    ? validate(endpoint.query, request.query ?? {}, "query")
    : undefined;
  const body = endpoint.body
    ? validate(endpoint.body, request.body, "body")
    : undefined;

  let output: unknown;
  try {
    output = await handler({
      endpoint,
      params,
      query,
      body,
      scenario,
      signal,
      headers: request.headers,
    });
  } catch (error) {
    throw toApiError(error);
  }
  await delay(0, signal);

  if (!endpoint.response) return undefined;
  const result = (endpoint.response as z.ZodType).safeParse(output);
  if (!result.success)
    throw new ApiError(
      500,
      "MOCK_RESPONSE_INVALID",
      `Mock ${endpoint.id} tidak sesuai kontrak response.`,
      zodIssuesToDetails(result.error),
    );
  return JSON.parse(JSON.stringify(result.data));
}

/** Back to a clean slate: normal scenario, no queued faults, seeded stores. */
export function resetMocks() {
  resetControl();
  resetMockStores();
}
