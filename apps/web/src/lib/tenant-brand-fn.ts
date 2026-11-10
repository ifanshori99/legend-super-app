import { createServerFn } from "@tanstack/react-start";
import type { MessageOverrides } from "@starter/shared/i18n";
import {
  brandContextSchema,
  type BrandContext,
} from "@starter/shared/platform";
import { apiFetch } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { overridesForLocale } from "@/lib/tenant-text-overrides";

/**
 * `brand`: the host resolved to a brand. `none`: no tenant brand on this host
 * (4xx, or mock mode): the Base Theme applies. `error`: a transient failure
 * (network, 429, 5xx): the caller keeps what it had instead of flipping theme.
 * `overrides`: the tenant's public `terms.*` words for the UI language; empty
 * for `none` and `error`, so a failed read renders the default catalog.
 */
export type TenantBrandResult =
  | { kind: "brand"; brand: BrandContext; overrides: MessageOverrides }
  | { kind: "none"; overrides: MessageOverrides }
  | { kind: "error"; overrides: MessageOverrides };

/**
 * Brand of the host the visitor used (`GET /api/tenant/context`, public on a
 * tenant host, TEN-02 / D44). Runs on the server so SSR paints the tenant
 * theme with no flash. The answer is parsed with the shared strict schema
 * before any of it reaches inline CSS. The same answer carries the tenant's
 * text overrides, so the root makes one upstream call per render.
 */
export const getTenantBrandFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<TenantBrandResult> => {
    if (API_MOCK) return { kind: "none", overrides: {} };
    try {
      const response = await apiFetch<{ data: unknown }>("/api/tenant/context");
      const parsed = brandContextSchema.safeParse(response.data);
      return parsed.success
        ? {
            kind: "brand",
            brand: parsed.data,
            overrides: overridesForLocale(parsed.data.textOverrides ?? null),
          }
        : { kind: "error", overrides: {} };
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      // 429 and 5xx (and network, status 0) are transient; other 4xx mean
      // this host has no tenant brand.
      return status === 429 || status >= 500 || status === 0
        ? { kind: "error", overrides: {} }
        : { kind: "none", overrides: {} };
    }
  },
);
