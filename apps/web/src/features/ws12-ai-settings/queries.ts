// Query keys and options for Pengaturan AI. Every key starts with the endpoint
// id, so invalidating `[endpoint.id]` refreshes every variant.
import { getAiProviderConfig, getChatgptLogin } from "@starter/shared/ai";
import { fetchChatgpt, fetchProvider } from "./api";

const RETRY = { retry: 1, retryDelay: 600 } as const;

export const providerQuery = () => ({
  queryKey: [getAiProviderConfig.id] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => fetchProvider(signal),
  ...RETRY,
});

export const chatgptQuery = () => ({
  queryKey: [getChatgptLogin.id] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => fetchChatgpt(signal),
  ...RETRY,
});
