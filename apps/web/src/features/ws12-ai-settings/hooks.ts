// Cached Pengaturan AI data and mutations. Components never call apiFetch
// directly. Budget and kill switch: `useGovernance`, `useBudget` and
// `useUpdateGovernance` from features/ws12-ai-admin/hooks.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/errors";
import {
  patchProvider,
  pollChatgpt,
  revokeChatgpt,
  saveProvider,
  startChatgpt,
  testProvider,
} from "./api";
import {
  getAiProviderConfig,
  getChatgptLogin,
  type AiModelCapabilityOverrides,
  type UpsertAiProviderConfigInput,
} from "@starter/shared/ai";
import { chatgptQuery, providerQuery } from "./queries";

/** Viewers without manage rights re-read a pending login this often. */
const VIEWER_REFETCH_MS = 15_000;

export function useProvider() {
  return useQuery(providerQuery());
}

/**
 * ChatGPT login status. The owner's panel polls the device code itself while a
 * code is pending. With `refetchWhilePending`, a viewer who cannot manage the
 * connection (and so cannot poll) re-reads the status every 15 seconds instead,
 * until it leaves `pending` or the API refuses access. Hidden tabs pause.
 */
export function useChatgptLogin(refetchWhilePending = false) {
  return useQuery({
    ...chatgptQuery(),
    // The page gate reads the status before the cards mount. Without this, a
    // failed status is fetched again when the cards mount and can turn into a
    // stale "connected" reading; the cards keep the error until retried.
    retryOnMount: false,
    refetchInterval: (query) => {
      if (!refetchWhilePending) return false;
      const status = query.state.data?.data;
      if (status?.state !== "pending" || status.viewerCanManage) return false;
      const error = query.state.error;
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403)
      )
        return false;
      return VIEWER_REFETCH_MS;
    },
  });
}

/**
 * Platform kill switch (founder W16 Q7): when the platform turns AI off for the
 * tenant, every tenant AI setting is locked. Reads `platformLocked` from the
 * provider view. Fails closed: locked while it is loading or failed to load.
 * The API enforces it regardless.
 */
export function useAiPlatformLock(): { locked: boolean; isPending: boolean } {
  const provider = useProvider();
  return {
    locked: !provider.data || provider.data.data.platformLocked === true,
    isPending: provider.isPending,
  };
}

/** `gcTime: 0` and a `reset()` after success keep the API key out of the mutation cache. */
export function useSaveProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: UpsertAiProviderConfigInput) => saveProvider(body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [getAiProviderConfig.id] }),
  });
}

/**
 * Changes capability overrides only (PATCH). Send only the fields that changed;
 * `null` resets every override. The answer replaces the cached provider view.
 */
export function usePatchProviderCapabilities() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (capabilityOverrides: AiModelCapabilityOverrides | null) =>
      patchProvider(capabilityOverrides),
    onSuccess: (view) =>
      queryClient.setQueryData([getAiProviderConfig.id], view),
  });
}

/** Runs the connection test, then refreshes the provider (capabilities, last test). */
export function useTestProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => testProvider(),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: [getAiProviderConfig.id] }),
  });
}

export function useStartChatgpt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => startChatgpt(),
    onSuccess: (view) => queryClient.setQueryData([getChatgptLogin.id], view),
  });
}

/** One poll round: the answer replaces the cached status. */
export function usePollChatgpt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => pollChatgpt(),
    onSuccess: (view) => queryClient.setQueryData([getChatgptLogin.id], view),
  });
}

/** Cancels a pending code or revokes the connection. */
export function useRevokeChatgpt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => revokeChatgpt(),
    onSuccess: (view) => queryClient.setQueryData([getChatgptLogin.id], view),
  });
}
