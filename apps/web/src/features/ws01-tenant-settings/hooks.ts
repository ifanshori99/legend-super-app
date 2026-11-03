// Hooks are the only way components touch tenant settings data. They own cache
// keys and invalidation. Integration credentials never enter a variable or a
// cache entry: see ./secret-buffer.ts and ./integrations-save.ts (PAY-06).
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { ConfigSection } from "@starter/shared/platform";
import { orgEndpoints } from "@starter/shared/platform";
import { ApiError } from "@/lib/api/errors";
import { endpointQueryKey } from "@/lib/api/endpoint";
import * as api from "./api";
import {
  runSaveIntegration,
  mergeSavedIntegration,
  type IntegrationList,
  type SaveIntegrationVariables,
} from "./integrations-save";
import {
  brandsQuery,
  integrationsQuery,
  outletsQuery,
  textOverridesQuery,
  themesQuery,
} from "./queries";
import type { UpsertIntegrationInput } from "@starter/shared/platform";
import { evaluateTheme, type ThemeDraft } from "./theme-lib";
import type { TermChange } from "./terms-lib";

export const useIntegrations = () => useQuery(integrationsQuery());
export const useBrands = () => useQuery(brandsQuery());
export const useOutlets = () => useQuery(outletsQuery());
export const useTextOverrides = (enabled = true) =>
  useQuery({ ...textOverridesQuery(), enabled });

export function useThemes(brandId: string | undefined) {
  return useQuery({
    ...themesQuery(brandId ?? ""),
    enabled: brandId !== undefined,
  });
}

const integrationsKey = () => endpointQueryKey(orgEndpoints.listIntegrations);

/**
 * Saves an integration. `gcTime: 0` drops the finished mutation from the
 * mutation cache at once; its variables hold the request body without
 * credentials plus an empty-looking buffer, never a secret value.
 */
export function useSaveIntegration() {
  const client = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (variables: SaveIntegrationVariables<UpsertIntegrationInput>) =>
      runSaveIntegration(
        client,
        integrationsKey(),
        api.upsertIntegrationCall,
        variables,
      ),
  });
}

export function useSetIntegrationStatus() {
  const client = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: async (variables: {
      integrationId: string;
      status: "active" | "disabled";
    }) =>
      (
        await api.setIntegrationStatusCall(
          variables.integrationId,
          variables.status,
        )
      ).data,
    onSuccess: (saved) => {
      client.setQueryData<IntegrationList>(integrationsKey(), (current) =>
        mergeSavedIntegration(current, saved),
      );
    },
  });
}

function invalidateThemes(client: QueryClient) {
  return client.invalidateQueries({
    queryKey: [orgEndpoints.listThemes.id],
  });
}

/**
 * Theme save = pre-flight check, draft, activate (TEN-10). The server checks
 * again on activation; a contrast failure never leaves an orphan draft because
 * the pre-flight runs first.
 */
export function useSaveTheme(brandId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (draft: ThemeDraft) => {
      if (!brandId) throw new ApiError(404, "NOT_FOUND", "Brand tidak ada.");
      if (!evaluateTheme(draft).ok)
        throw new ApiError(
          422,
          "THEME_CONTRAST_FAILED",
          "Kontras tema di bawah WCAG 2.2 AA.",
        );
      const check = await api.checkThemeCall({ tokens: draft.tokens });
      if (!check.data.ok)
        throw new ApiError(
          422,
          "THEME_CONTRAST_FAILED",
          "Kontras tema di bawah WCAG 2.2 AA.",
        );
      const created = await api.createThemeDraftCall({
        brandId,
        tokens: draft.tokens,
        logoMediaId: draft.logoMediaId,
        fontFamily: draft.fontFamily,
        corners: draft.corners,
      });
      return (await api.activateThemeCall(created.data.id)).data;
    },
    onSuccess: () => invalidateThemes(client),
  });
}

export const useUploadLogo = () =>
  useMutation({
    gcTime: 0,
    mutationFn: async (body: Parameters<typeof api.uploadLogoCall>[0]) =>
      (await api.uploadLogoCall(body)).data,
  });

/** Export is a POST that only reads: a mutation keeps it off the query cache. */
export const useExportConfig = () =>
  useMutation({
    gcTime: 0,
    mutationFn: async (sections?: ConfigSection[]) =>
      (await api.exportConfigCall(sections ? { sections } : {})).data,
  });

export function useImportConfig() {
  return useMutation({
    gcTime: 0,
    mutationFn: async (input: { bundle: unknown; sections: ConfigSection[] }) =>
      (await api.importConfigCall(input)).data,
  });
}

export function useApplyTermChanges(locale: "id" | "en") {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (changes: readonly TermChange[]) => {
      for (const change of changes) {
        if (change.action === "set")
          await api.upsertTextOverrideCall({
            locale,
            key: change.key,
            value: change.value,
          });
        else await api.deleteTextOverrideCall(change.overrideId);
      }
    },
    onSettled: () =>
      client.invalidateQueries({ queryKey: textOverridesQuery().queryKey }),
  });
}
