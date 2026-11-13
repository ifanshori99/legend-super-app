// One typed caller per Pengaturan AI endpoint (docs/frontend.md "Add a
// feature's UI"). Components use the hooks in ./hooks.ts. The mock in
// ./mock.ts serves the same contracts when VITE_API_MOCK=true. Budget and the
// platform kill switch reuse the AI & MCP admin governance callers
// (features/ws12-ai-admin).
import { callEndpoint } from "@/lib/api/endpoint";
import {
  getAiProviderConfig,
  getChatgptLogin,
  pollChatgptLogin,
  revokeChatgptLogin,
  startChatgptLogin,
  testAiProviderConfig,
  upsertAiProviderConfig,
  type UpsertAiProviderConfigInput,
} from "./contract";

export const fetchProvider = (signal?: AbortSignal) =>
  callEndpoint(getAiProviderConfig, undefined, { signal });

export const saveProvider = (body: UpsertAiProviderConfigInput) =>
  callEndpoint(upsertAiProviderConfig, { body });

export const testProvider = () =>
  callEndpoint(testAiProviderConfig, { body: {} });

export const fetchChatgpt = (signal?: AbortSignal) =>
  callEndpoint(getChatgptLogin, undefined, { signal });

export const startChatgpt = () =>
  callEndpoint(startChatgptLogin, { body: { riskAccepted: true } });

export const pollChatgpt = () => callEndpoint(pollChatgptLogin, { body: {} });

export const revokeChatgpt = () => callEndpoint(revokeChatgptLogin);
