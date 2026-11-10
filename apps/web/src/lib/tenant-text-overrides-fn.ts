import { createServerFn } from "@tanstack/react-start";
import type { MessageOverrides } from "@starter/shared/i18n";
import { publicTextOverridesSchema } from "@starter/shared/text";
import { apiFetch } from "@/lib/api/client";
import { API_MOCK } from "@/lib/api/mock-flag";
import { overridesForLocale } from "@/lib/tenant-text-overrides";

/**
 * Term overrides of the host the visitor used (`GET /api/tenant/text-overrides`,
 * public, `terms.*` only). Runs on the server so SSR renders the tenant's own
 * words with no flash. Any failure (network, 429, 5xx, unknown host, an answer
 * that does not parse) renders the default catalog: it never breaks the page.
 */
export const getTenantTextOverridesFn = createServerFn({
  method: "GET",
}).handler(async (): Promise<MessageOverrides> => {
  if (API_MOCK) return {};
  try {
    const response = await apiFetch<{ data: unknown }>(
      "/api/tenant/text-overrides",
    );
    const parsed = publicTextOverridesSchema.safeParse(response.data);
    return parsed.success ? overridesForLocale(parsed.data) : {};
  } catch {
    return {};
  }
});
