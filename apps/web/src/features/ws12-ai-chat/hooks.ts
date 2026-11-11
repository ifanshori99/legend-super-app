// Cached Tanya AI chat data and mutations. Components never call apiFetch
// directly; each mutation updates or invalidates what it changes.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiConversationDetail, AskAi } from "@starter/shared/ai";
import {
  getAiUsageSummary as getAiUsageSummaryEndpoint,
  listAiConversations as listAiConversationsEndpoint,
} from "@starter/shared/ai";
import { removeAllConversations, sendQuestion } from "./api";
import {
  conversationKey,
  conversationQuery,
  conversationsQuery,
  usageQuery,
} from "./queries";

type ConversationCache = { data: AiConversationDetail };

export function useConversations() {
  return useQuery(conversationsQuery());
}

/** A conversation with its messages; idle until one is selected. */
export function useConversation(conversationId: string | null) {
  return useQuery({
    ...conversationQuery(conversationId ?? ""),
    enabled: conversationId !== null,
  });
}

/** Quota and availability (AIG-01, AIG-02, AIG-05). */
export function useAiUsage() {
  return useQuery(usageQuery());
}

/**
 * Sends one question. On success the answer is written into the conversation's
 * cache (so it never flickers away before a refetch) and the history refreshes.
 */
export function useAskQuestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { body: AskAi; signal?: AbortSignal }) =>
      sendQuestion(
        input.body,
        input.signal ? { signal: input.signal } : undefined,
      ),
    onSuccess: ({ data }) => {
      const { conversation, userMessage, assistantMessage } = data;
      queryClient.setQueryData<ConversationCache>(
        conversationKey(conversation.id),
        (current) => ({
          data: {
            conversation,
            messages: [
              ...(current?.data.messages.filter(
                (m) => m.id !== userMessage.id && m.id !== assistantMessage.id,
              ) ?? []),
              userMessage,
              assistantMessage,
            ],
          },
        }),
      );
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: [listAiConversationsEndpoint.id],
        }),
        queryClient.invalidateQueries({
          queryKey: [getAiUsageSummaryEndpoint.id],
        }),
      ]);
    },
  });
}

/** "Hapus riwayat": every own conversation is deleted (soft delete, owner only). */
export function useDeleteAllConversations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: removeAllConversations,
    // Partial failure still removed some: refresh either way.
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: [listAiConversationsEndpoint.id],
      }),
  });
}
