// One typed caller per Tanya AI chat endpoint (docs/frontend.md "Add a
// feature's UI"). Components never call these directly: they use ./hooks.ts.
// The mock in ./mock.ts serves the same contracts when VITE_API_MOCK=true.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  askAi as askAiEndpoint,
  deleteAiConversation as deleteAiConversationEndpoint,
  getAiConversation as getAiConversationEndpoint,
  getAiUsageSummary as getAiUsageSummaryEndpoint,
  listAiConversations as listAiConversationsEndpoint,
} from "@starter/shared/ai";
import { callEndpoint, type CallOptions } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

export const sendQuestion = (
  body: Body<typeof askAiEndpoint>,
  options?: CallOptions,
) => callEndpoint(askAiEndpoint, { body }, options);

export const removeConversation = (conversationId: string) =>
  callEndpoint(deleteAiConversationEndpoint, { params: { conversationId } });

const DELETE_PAGE = 100;
const DELETE_PARALLEL = 5;

/**
 * "Hapus riwayat": the contract has no delete-all, so this lists every own
 * conversation (cursor pages) and deletes them one by one, a few at a time.
 * Resolves with how many were deleted; rejects with the first failure after
 * trying all of them, so a retry only has the leftovers to do.
 */
export async function removeAllConversations(): Promise<number> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await callEndpoint(listAiConversationsEndpoint, {
      query: { limit: DELETE_PAGE, ...(cursor ? { cursor } : {}) },
    });
    ids.push(...page.data.map((conversation) => conversation.id));
    cursor = page.meta.nextCursor ?? undefined;
  } while (cursor);

  let deleted = 0;
  let failure: unknown;
  for (let i = 0; i < ids.length; i += DELETE_PARALLEL) {
    const results = await Promise.allSettled(
      ids.slice(i, i + DELETE_PARALLEL).map((id) => removeConversation(id)),
    );
    for (const result of results) {
      if (result.status === "fulfilled") deleted += 1;
      else failure ??= result.reason;
    }
  }
  if (failure !== undefined) throw failure;
  return deleted;
}

export const fetchConversationDetail = (conversationId: string) =>
  callEndpoint(getAiConversationEndpoint, { params: { conversationId } });

export const fetchUsage = () => callEndpoint(getAiUsageSummaryEndpoint);
