// Query keys and options for Tanya AI chat. `endpointQueryOptions` keys by
// endpoint id + input, so invalidating `[endpoint.id]` refreshes every page.
import {
  getAiConversation,
  getAiUsageSummary,
  listAiConversations,
} from "@starter/shared/ai";
import { endpointQueryKey, endpointQueryOptions } from "@/lib/api/endpoint";

// The chat shows its own error state instead of retrying silently; the
// "Coba lagi" button is the retry.
const RETRY = { retry: 1, retryDelay: 600 } as const;

export const HISTORY_LIMIT = 50;

export const conversationsQuery = () => ({
  ...endpointQueryOptions(listAiConversations, {
    query: { limit: HISTORY_LIMIT },
  }),
  ...RETRY,
});

export const conversationKey = (conversationId: string) =>
  endpointQueryKey(getAiConversation, { params: { conversationId } });

export const conversationQuery = (conversationId: string) => ({
  ...endpointQueryOptions(getAiConversation, { params: { conversationId } }),
  ...RETRY,
});

export const usageQuery = () => ({
  ...endpointQueryOptions(getAiUsageSummary),
  ...RETRY,
});
