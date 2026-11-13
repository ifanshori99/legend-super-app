// legend-z83k: pinned device/Codex wire contract, fixture-only transport.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { env } from "../config/env.ts";
import {
  ChatgptCodexError,
  createChatgptCodexProvider,
  getChatgptCodexModelCapabilities,
  pollChatgptDevice,
  refreshChatgptToken,
  revokeChatgptToken,
  setChatGptCodexFetchForTests,
  startChatgptDevice,
  type ChatgptTokenBundle,
} from "../lib/ai/chatgpt-codex.ts";
import type { AiCompletionRequest } from "../lib/ai/types.ts";
import { getModelCapabilities } from "../lib/ai/model-capabilities.ts";

const originalFetch = globalThis.fetch;
const unmockedFetches: string[] = [];
const denyRealFetch = (async () => {
  unmockedFetches.push("Unexpected unmocked external request");
  throw new Error("External network is forbidden in device-code tests");
}) as typeof fetch;

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE = "device-secret-adapter-fixture";
const CODE = "authorization-code-adapter-fixture";
const VERIFIER = "verifier-adapter-fixture";
const ACCESS = "access-token-adapter-fixture";
const REFRESH = "refresh-token-adapter-fixture";
const jwt = () =>
  [
    Buffer.from('{"alg":"RS256"}').toString("base64url"),
    Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-fixture" },
      }),
    ).toString("base64url"),
    "fixture-signature",
  ].join(".");
const credentials = (): ChatgptTokenBundle => ({
  accessToken: ACCESS,
  refreshToken: REFRESH,
  accountId: "acct-fixture",
  expiresAt: new Date(Date.now() + 3_600_000),
});
const request: AiCompletionRequest = {
  system: "Kamu asisten Legend.",
  messages: [{ role: "user", content: [{ type: "text", text: "Penjualan?" }] }],
  tools: [
    {
      name: "sales",
      description: "Penjualan",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ],
  maxTokens: 512,
  reasoningEffort: "high",
};
const enabledBefore = (env as unknown as { AI_CHATGPT_ENABLED: boolean })
  .AI_CHATGPT_ENABLED;
const setEnabled = (enabled: boolean) =>
  Object.assign(env, { AI_CHATGPT_ENABLED: enabled });
const makeProvider = () =>
  createChatgptCodexProvider({
    model: "gpt-5-codex",
    getCredentials: async () => credentials(),
    stillConnected: async () => true,
  });
const event = (type: string, payload: Record<string, unknown>) =>
  `event: ${type}\r\ndata: ${JSON.stringify({ type, ...payload })}\r\n\r\n`;
const messageItem = {
  type: "message",
  id: "msg_fixture",
  role: "assistant",
  status: "completed",
  content: [
    { type: "output_text", text: "Jumlah ✓ Rp10.000", annotations: [] },
  ],
};
const toolItem = {
  type: "function_call",
  id: "fc_fixture",
  call_id: "call_fixture",
  name: "sales",
  arguments: '{"period":"today"}',
  status: "completed",
};
const reasoningItem = {
  type: "reasoning",
  id: "reason_fixture",
  encrypted_content: "encrypted-reasoning-fixture",
  summary: [],
};
function streamResponse(
  items: Record<string, unknown>[] = [messageItem],
  terminal = true,
  fragmented = false,
): Response {
  const text =
    items
      .map((item, output_index) =>
        event("response.output_item.done", { item, output_index }),
      )
      .join("") +
    (terminal
      ? event("response.completed", {
          response: {
            id: "resp_fixture",
            status: "completed",
            model: "gpt-5-codex",
            output: items,
            usage: {
              input_tokens: 20,
              output_tokens: 12,
              output_tokens_details: { reasoning_tokens: 5 },
            },
          },
        })
      : "data: [DONE]\r\n\r\n");
  const bytes = new TextEncoder().encode(text);
  if (!fragmented)
    return new Response(text, {
      headers: { "content-type": "text/event-stream" },
    });
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7)
          controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
const sentBody = (call: unknown[]) =>
  JSON.parse((call as [unknown, RequestInit])[1].body as string) as Record<
    string,
    unknown
  >;

beforeAll(() => {
  globalThis.fetch = denyRealFetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  expect(unmockedFetches).toEqual([]);
});

beforeEach(() => {
  setEnabled(true);
});
afterEach(() => {
  setEnabled(enabledBefore);
  setChatGptCodexFetchForTests(null);
  vi.restoreAllMocks();
});

describe("legend-z83k B1 device grant wire contract", () => {
  it("legend-z83k B1 requests the Codex public client and returns a fixed verification URL with bounded polling", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        device_auth_id: DEVICE,
        user_code: "ABCD-EFGH",
        interval: "5",
      }),
    );
    setChatGptCodexFetchForTests(fetch as typeof globalThis.fetch);
    const begun = await startChatgptDevice();
    expect(begun).toMatchObject({
      deviceAuthId: DEVICE,
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
      intervalSeconds: 5,
    });
    expect(begun.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(begun.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 15 * 60_000,
    );
    const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
    );
    expect(call[1].method).toBe("POST");
    expect(sentBody(call)).toEqual({ client_id: CLIENT_ID });
    expect(["manual", "error"]).toContain(call[1].redirect);
  });
  it.each([403, 404])(
    "legend-z83k B1 treats device polling HTTP%s as pending rather than token authorization failure",
    async (status) => {
      setChatGptCodexFetchForTests(
        (async () => new Response(null, { status })) as typeof fetch,
      );
      expect(
        await pollChatgptDevice({
          deviceAuthId: DEVICE,
          userCode: "ABCD-EFGH",
        }),
      ).toEqual({ status: "pending" });
    },
  );
  it("legend-z83k B1 exchanges a granted code as a form with its PKCE verifier and device callback", async () => {
    const token = jwt();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          authorization_code: CODE,
          code_challenge: "challenge",
          code_verifier: VERIFIER,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: token,
          id_token: token,
          refresh_token: REFRESH,
          expires_in: 3600,
        }),
      );
    setChatGptCodexFetchForTests(fetch as typeof globalThis.fetch);
    const polled = await pollChatgptDevice({
      deviceAuthId: DEVICE,
      userCode: "ABCD-EFGH",
    });
    expect(polled.status).toBe("authorized");
    if (polled.status !== "authorized")
      throw new Error("Expected authorized fixture");
    expect(polled.tokens).toMatchObject({
      accessToken: token,
      refreshToken: REFRESH,
      accountId: "acct-fixture",
    });
    const first = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const second = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(first[0]).toBe(
      "https://auth.openai.com/api/accounts/deviceauth/token",
    );
    expect(sentBody(first)).toEqual({
      device_auth_id: DEVICE,
      user_code: "ABCD-EFGH",
    });
    expect(second[0]).toBe("https://auth.openai.com/oauth/token");
    expect(new Headers(second[1].headers).get("content-type")).toContain(
      "application/x-www-form-urlencoded",
    );
    expect(
      Object.fromEntries(new URLSearchParams(String(second[1].body))),
    ).toEqual({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: CODE,
      redirect_uri: "https://auth.openai.com/deviceauth/callback",
      code_verifier: VERIFIER,
    });
  });
  it("legend-z83k B2 refreshes as JSON and preserves optional nonrotating refresh/account fields", async () => {
    const token = jwt();
    const fetch = vi.fn(async () =>
      Response.json({ access_token: token, expires_in: 3600 }),
    );
    setChatGptCodexFetchForTests(fetch as typeof globalThis.fetch);
    const refreshed = await refreshChatgptToken(credentials());
    expect(refreshed.accessToken).toBe(token);
    expect(refreshed.refreshToken).toBe(REFRESH);
    expect(refreshed.accountId).toBe("acct-fixture");
    const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://auth.openai.com/oauth/token");
    expect(new Headers(call[1].headers).get("content-type")).toContain(
      "application/json",
    );
    expect(sentBody(call)).toEqual({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: REFRESH,
    });
  });
  it("legend-z83k B2 revokes with the refresh token and fixed client ID", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    setChatGptCodexFetchForTests(fetch as typeof globalThis.fetch);
    await revokeChatgptToken(REFRESH);
    const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://auth.openai.com/oauth/revoke");
    expect(sentBody(call)).toEqual({
      token: REFRESH,
      token_type_hint: "refresh_token",
      client_id: CLIENT_ID,
    });
  });
});

describe("legend-z83k B3 bounded Responses SSE adapter", () => {
  it.each(["gpt-5-codex", "gpt-5.1-codex", "gpt-5.3-codex"])(
    "legend-z83k B3 keeps plan-only profile %s out of generic Chat Completions discovery",
    (model) => {
      expect(getModelCapabilities(model)).toMatchObject({
        contextWindow: 4096,
        maxOutputTokens: 1024,
        supportsTools: false,
        supportsReasoning: false,
        reasoningEfforts: [],
        source: "default",
      });
      expect(getChatgptCodexModelCapabilities(model)).toMatchObject({
        contextWindow: 272_000,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsReasoning: true,
      });
    },
  );

  it.each([
    "gpt-5-codex",
    "gpt-5.1-codex",
    "gpt-5.3-codex",
    "gpt-6.1-sol",
    "gpt-6.1-terra",
  ])(
    "legend-z83k B3 applies the verified Codex profile to exact model %s",
    (model) => {
      expect(getChatgptCodexModelCapabilities(model)).toMatchObject({
        contextWindow: 272_000,
        maxOutputTokens: 8192,
        supportsTools: true,
        supportsReasoning: true,
        reasoningEfforts: ["low", "medium", "high"],
      });
    },
  );

  it("legend-z83k B3 maps fragmented UTF-8/CRLF text, tool calls and opaque reasoning without double-counting usage", async () => {
    const fetch = vi.fn(async () =>
      streamResponse([messageItem, toolItem, reasoningItem], true, true),
    );
    setChatGptCodexFetchForTests(fetch as typeof globalThis.fetch);
    const result = await makeProvider().complete(request);
    expect(result.content).toContainEqual({
      type: "text",
      text: "Jumlah ✓ Rp10.000",
    });
    expect(
      result.content.filter((block) => block.type === "text"),
    ).toHaveLength(1);
    expect(result.content).toContainEqual({
      type: "tool_use",
      id: "call_fixture",
      name: "sales",
      input: { period: "today" },
    });
    expect(result.content).toContainEqual({
      type: "opaque",
      provider: "chatgpt-codex",
      data: reasoningItem,
    });
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 12 });
    expect(result.stopReason).toBe("tool_use");
    const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(new Headers(call[1].headers).get("authorization")).toBe(
      `Bearer ${ACCESS}`,
    );
    expect(new Headers(call[1].headers).get("ChatGPT-Account-ID")).toBe(
      "acct-fixture",
    );
    const sent = sentBody(call);
    expect(sent).toMatchObject({
      model: "gpt-5-codex",
      store: false,
      stream: true,
      reasoning: { effort: "high" },
    });
    expect(sent).not.toHaveProperty("max_output_tokens");
    expect(sent).not.toHaveProperty("max_tokens");
  });
  it("legend-z83k B3 replays only its own opaque reasoning and maps function results into input", async () => {
    const fetch = vi.fn(async () => streamResponse());
    setChatGptCodexFetchForTests(fetch as typeof globalThis.fetch);
    await makeProvider().complete({
      ...request,
      messages: [
        ...request.messages,
        {
          role: "assistant",
          content: [
            { type: "opaque", provider: "chatgpt-codex", data: reasoningItem },
            {
              type: "opaque",
              provider: "anthropic",
              data: { type: "thinking", thinking: "foreign-provider-data" },
            },
            {
              type: "tool_use",
              id: "call_fixture",
              name: "sales",
              input: { period: "today" },
            },
            { type: "text", text: "Potongan sesudah tool." },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "call_fixture",
              content: '{"total":10000}',
            },
          ],
        },
      ],
    });
    const sent = sentBody(fetch.mock.calls[0]!);
    const serialized = JSON.stringify(sent);
    expect(serialized).toContain("encrypted-reasoning-fixture");
    expect(serialized).not.toContain("foreign-provider-data");
    const input = sent.input as Record<string, unknown>[];
    const reasoningIndex = input.findIndex((item) => item.type === "reasoning");
    const callIndex = input.findIndex((item) => item.type === "function_call");
    const textIndex = input.findIndex(
      (item) =>
        item.role === "assistant" &&
        JSON.stringify(item).includes("Potongan sesudah tool."),
    );
    expect([reasoningIndex, callIndex, textIndex]).toEqual([
      reasoningIndex,
      reasoningIndex + 1,
      reasoningIndex + 2,
    ]);
    expect(sent.input).toContainEqual({
      type: "function_call_output",
      call_id: "call_fixture",
      output: '{"total":10000}',
    });
  });
  it("legend-z83k B3 omits reasoning controls when request policy did not select reasoning", async () => {
    const fetch = vi.fn(async () => streamResponse());
    setChatGptCodexFetchForTests(fetch as typeof globalThis.fetch);
    const { reasoningEffort: _effort, ...plain } = request;
    void _effort;
    await makeProvider().complete({ ...plain, tools: [] });
    const body = sentBody(fetch.mock.calls[0]!);
    for (const field of [
      "reasoning",
      "tools",
      "tool_choice",
      "parallel_tool_calls",
      "include",
    ])
      expect(body).not.toHaveProperty(field);
  });
  it("legend-z83k B3 rejects a truncated stream even if it contains text and a DONE marker", async () => {
    setChatGptCodexFetchForTests((async () =>
      streamResponse([messageItem], false)) as typeof fetch);
    await expect(makeProvider().complete(request)).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
  it("legend-z83k B3 rejects failed and malformed terminal responses", async () => {
    for (const text of [
      event("response.failed", {
        response: { status: "failed", error: { message: ACCESS } },
      }),
      "data: {not-json}\n\n",
      event("response.completed", {
        response: { status: "completed", output: [messageItem] },
      }),
    ]) {
      setChatGptCodexFetchForTests(
        (async () =>
          new Response(text, {
            headers: { "content-type": "text/event-stream" },
          })) as typeof fetch,
      );
      const error = await makeProvider()
        .complete(request)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChatgptCodexError);
      expect((error as Error).message).not.toContain(ACCESS);
    }
  });
  it("legend-z83k B3 classifies explicit auth failures but keeps quota, network and provider failures unavailable without retry", async () => {
    for (const [status, kind] of [
      [401, "auth"],
      [403, "unavailable"],
      [429, "unavailable"],
      [503, "unavailable"],
    ] as const) {
      const fetch = vi.fn(async () =>
        Response.json(
          { error: { message: `${ACCESS} ${REFRESH}` } },
          { status },
        ),
      );
      setChatGptCodexFetchForTests(fetch as typeof globalThis.fetch);
      const error = await makeProvider()
        .complete(request)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChatgptCodexError);
      expect((error as ChatgptCodexError).kind).toBe(kind);
      expect((error as Error).message).not.toContain(ACCESS);
      expect((error as Error).message).not.toContain(REFRESH);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it("legend-z83k B3 global kill and missing credentials stop all inference before external I/O", async () => {
    const fetch = vi.fn();
    setChatGptCodexFetchForTests(fetch as typeof globalThis.fetch);
    setEnabled(false);
    await expect(makeProvider().complete(request)).rejects.toMatchObject({
      kind: "disabled",
    });
    expect(fetch).not.toHaveBeenCalled();
    setEnabled(true);
    await expect(
      createChatgptCodexProvider({
        model: "gpt-5-codex",
        getCredentials: async () => null,
        stillConnected: async () => true,
      }).complete(request),
    ).rejects.toMatchObject({ kind: "auth" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
