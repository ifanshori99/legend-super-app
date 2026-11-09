// AI provider adapters, URL guard, and factory (bead legend-zfi4). No network:
// the Anthropic client and fetch are doubles.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiError } from "@starter/shared/ai";
import {
  createAnthropicProvider,
  type AnthropicClientLike,
} from "../lib/ai/anthropic.ts";
import { createFakeProvider } from "../lib/ai/fake.ts";
import { createOpenAiCompatibleProvider } from "../lib/ai/openai-compatible.ts";
import {
  getAiProvider,
  setAiProviderForTests,
} from "../lib/ai/provider-factory.ts";
import { checkAiUrl, unsafeAiUrlReason } from "../lib/ai/url-guard.ts";
import type { AiCompletionRequest } from "../lib/ai/types.ts";

const request: AiCompletionRequest = {
  system: "Kamu asisten Legend.",
  messages: [{ role: "user", content: [{ type: "text", text: "Halo" }] }],
  tools: [
    {
      name: "get_sales_summary",
      description: "Ringkasan penjualan",
      inputSchema: {
        type: "object",
        properties: { outletId: { type: "string" } },
        additionalProperties: false,
      },
    },
    {
      name: "get_loose",
      description: "Skema longgar",
      inputSchema: {
        type: "object",
        properties: { n: { type: "integer", minimum: 1 } },
      },
    },
  ],
  maxTokens: 512,
};

function anthropicDouble(message: Record<string, unknown>) {
  const create = vi.fn(async () => message);
  const client = {
    beta: { messages: { create } },
  } as unknown as AnthropicClientLike;
  return { client, create };
}

const baseMessage = {
  model: "claude-opus-5-5",
  usage: {
    input_tokens: 10,
    output_tokens: 4,
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 3,
  },
};

describe("anthropic adapter", () => {
  const options = {
    apiKey: "k",
    model: "claude-opus-5-5",
    effort: "low" as const,
    timeoutMs: 5000,
  };

  it("sends effort, fallbacks, cache control, and no tool_choice or thinking", async () => {
    const { client, create } = anthropicDouble({
      ...baseMessage,
      content: [{ type: "text", text: "Hai" }],
      stop_reason: "end_turn",
    });
    await createAnthropicProvider({ ...options, client }).complete(request);
    const body = (
      create.mock.calls[0] as unknown as [Record<string, unknown>]
    )[0];
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.fallbacks).toBe("default");
    expect(body.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("thinking");
    expect(body.system).toEqual([
      {
        type: "text",
        text: request.system,
        cache_control: { type: "ephemeral" },
      },
    ]);
    const tools = body.tools as Record<string, unknown>[];
    expect(tools[0]).toMatchObject({ name: "get_sales_summary", strict: true });
    expect(tools[0]).not.toHaveProperty("cache_control");
    // Unsupported keyword (minimum): no strict. Last tool carries the cache mark.
    expect(tools[1]).not.toHaveProperty("strict");
    expect(tools[1]).toMatchObject({ cache_control: { type: "ephemeral" } });
    const messages = body.messages as { role: string }[];
    expect(messages.at(-1)?.role).toBe("user");
  });

  it("maps text, tool_use, opaque blocks, usage, and stop reasons", async () => {
    const thinking = { type: "thinking", thinking: "...", signature: "sig" };
    const { client } = anthropicDouble({
      ...baseMessage,
      content: [
        thinking,
        { type: "text", text: "Cek data" },
        {
          type: "tool_use",
          id: "tu_1",
          name: "get_sales_summary",
          input: { outletId: "o" },
        },
      ],
      stop_reason: "tool_use",
      model: "claude-fallback",
    });
    const result = await createAnthropicProvider({
      ...options,
      client,
    }).complete(request);
    expect(result.stopReason).toBe("tool_use");
    expect(result.model).toBe("claude-fallback");
    expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 4 });
    expect(result.content).toEqual([
      { type: "opaque", provider: "anthropic", data: thinking },
      { type: "text", text: "Cek data" },
      {
        type: "tool_use",
        id: "tu_1",
        name: "get_sales_summary",
        input: { outletId: "o" },
      },
    ]);
  });

  it("replays opaque blocks unchanged and maps tool results; drops foreign opaque", async () => {
    const thinking = { type: "thinking", thinking: "...", signature: "sig" };
    const { client, create } = anthropicDouble({
      ...baseMessage,
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    });
    await createAnthropicProvider({ ...options, client }).complete({
      ...request,
      messages: [
        ...request.messages,
        {
          role: "assistant",
          content: [
            { type: "opaque", provider: "anthropic", data: thinking },
            { type: "opaque", provider: "other", data: { x: 1 } },
            {
              type: "tool_use",
              id: "tu_1",
              name: "get_sales_summary",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "tu_1",
              content: '{"total":5}',
              isError: true,
            },
          ],
        },
      ],
    });
    const body = (
      create.mock.calls[0] as unknown as [
        { messages: { content: unknown[] }[] },
      ]
    )[0];
    expect(body.messages[1]?.content).toEqual([
      thinking,
      { type: "tool_use", id: "tu_1", name: "get_sales_summary", input: {} },
    ]);
    expect(body.messages[2]?.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: '{"total":5}',
        is_error: true,
      },
    ]);
  });

  it("maps refusal and max_tokens", async () => {
    for (const [reason, expected] of [
      ["refusal", "refusal"],
      ["max_tokens", "max_tokens"],
      ["pause_turn", "other"],
    ] as const) {
      const { client } = anthropicDouble({
        ...baseMessage,
        content: [],
        stop_reason: reason,
      });
      const result = await createAnthropicProvider({
        ...options,
        client,
      }).complete(request);
      expect(result.stopReason).toBe(expected);
    }
  });

  it("turns SDK failures into AI_PROVIDER_UNAVAILABLE without leaking detail", async () => {
    const client = {
      beta: {
        messages: {
          create: async () => {
            throw new Error("key sk-secret rejected");
          },
        },
      },
    } as unknown as AnthropicClientLike;
    const error = await createAnthropicProvider({ ...options, client })
      .complete(request)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("AI_PROVIDER_UNAVAILABLE");
    expect((error as AiError).message).not.toContain("sk-secret");
  });
});

function chatResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("openai-compatible adapter", () => {
  const base = {
    baseUrl: "https://llm.example.com/v1/",
    apiKey: "secret-key",
    model: "m1",
    timeoutMs: 5000,
    wait: async () => undefined,
  };

  it("posts to chat/completions with bearer key, refusing redirects", async () => {
    const fetchMock = vi.fn(async () =>
      chatResponse({
        model: "m1-x",
        choices: [{ finish_reason: "stop", message: { content: "Hai" } }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
      }),
    );
    const result = await createOpenAiCompatibleProvider({
      ...base,
      fetch: fetchMock as never,
    }).complete(request);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret-key",
    );
    expect(result).toMatchObject({
      content: [{ type: "text", text: "Hai" }],
      stopReason: "end_turn",
      usage: { inputTokens: 7, outputTokens: 2 },
      model: "m1-x",
    });
  });

  it("maps tool calls and tool results", async () => {
    const fetchMock = vi.fn(async () =>
      chatResponse({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: {
                    name: "get_sales_summary",
                    arguments: '{"outletId":"o"}',
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    const provider = createOpenAiCompatibleProvider({
      ...base,
      fetch: fetchMock as never,
    });
    const result = await provider.complete(request);
    expect(result.stopReason).toBe("tool_use");
    expect(result.content).toEqual([
      {
        type: "tool_use",
        id: "c1",
        name: "get_sales_summary",
        input: { outletId: "o" },
      },
    ]);
    await provider.complete({
      ...request,
      messages: [
        ...request.messages,
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "c1",
              name: "get_sales_summary",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "c1", content: '{"total":5}' },
          ],
        },
      ],
    });
    const sent = JSON.parse(
      (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(sent.messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: '{"total":5}',
    });
    expect(sent.tools[0].function.name).toBe("get_sales_summary");
  });

  it("maps content_filter to refusal", async () => {
    const fetchMock = vi.fn(async () =>
      chatResponse({
        choices: [
          { finish_reason: "content_filter", message: { content: null } },
        ],
      }),
    );
    const result = await createOpenAiCompatibleProvider({
      ...base,
      fetch: fetchMock as never,
    }).complete(request);
    expect(result.stopReason).toBe("refusal");
  });

  it("adapts max_tokens once, then retries 5xx once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        chatResponse(
          {
            error: {
              message: "max_tokens is not supported, use max_completion_tokens",
            },
          },
          400,
        ),
      )
      .mockResolvedValueOnce(chatResponse({}, 503))
      .mockResolvedValueOnce(
        chatResponse({
          choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        }),
      );
    await createOpenAiCompatibleProvider({
      ...base,
      fetch: fetchMock as never,
    }).complete(request);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const last = JSON.parse(
      (fetchMock.mock.calls[2] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(last.max_completion_tokens).toBe(512);
    expect(last).not.toHaveProperty("max_tokens");
  });

  it("fails closed: 401, network error, bad URL, and bad JSON all become AI_PROVIDER_UNAVAILABLE", async () => {
    const cases: Array<Parameters<typeof createOpenAiCompatibleProvider>[0]> = [
      { ...base, fetch: (async () => chatResponse({}, 401)) as never },
      {
        ...base,
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as never,
      },
      { ...base, fetch: (async () => chatResponse({ choices: [] })) as never },
      {
        ...base,
        fetch: (async () => chatResponse({})) as never,
        checkUrl: async () => "blocked",
      },
    ];
    for (const options of cases) {
      const error = await createOpenAiCompatibleProvider(options)
        .complete(request)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AiError);
      expect((error as AiError).code).toBe("AI_PROVIDER_UNAVAILABLE");
    }
  });
});

describe("url guard", () => {
  it("accepts http local hosts outside production", () => {
    expect(unsafeAiUrlReason("http://localhost:11434/v1", false)).toBeNull();
  });

  it("refuses credentials, odd schemes, and unparsable URLs", () => {
    expect(unsafeAiUrlReason("ftp://x.com", false)).not.toBeNull();
    expect(unsafeAiUrlReason("https://u:p@x.com", false)).not.toBeNull();
    expect(unsafeAiUrlReason("nope", false)).not.toBeNull();
  });

  it("in production refuses http, localhost, private and metadata addresses", () => {
    for (const url of [
      "http://api.example.com",
      "https://localhost",
      "https://127.0.0.1",
      "https://10.0.0.5",
      "https://169.254.169.254",
      "https://[::1]",
      "https://[::ffff:10.0.0.1]",
      "https://db.internal",
      "https://intranet",
    ])
      expect(unsafeAiUrlReason(url, true), url).not.toBeNull();
    expect(unsafeAiUrlReason("https://api.example.com/v1", true)).toBeNull();
  });

  it("in production refuses a name that resolves to a private address", async () => {
    const privateHost = async () => [{ address: "10.1.2.3", family: 4 }];
    const publicHost = async () => [{ address: "93.184.216.34", family: 4 }];
    expect(
      await checkAiUrl("https://api.example.com", true, privateHost),
    ).not.toBeNull();
    expect(
      await checkAiUrl("https://api.example.com", true, publicHost),
    ).toBeNull();
    expect(
      await checkAiUrl("http://localhost:1", false, privateHost),
    ).toBeNull();
  });
});

describe("fake provider and factory", () => {
  afterEach(() => setAiProviderForTests(undefined));

  it("scripts answers and records calls", async () => {
    const fake = createFakeProvider(() => ({
      content: [{ type: "text", text: "Skrip" }],
      stopReason: "end_turn",
    }));
    const result = await fake.complete(request);
    expect(result.content).toEqual([{ type: "text", text: "Skrip" }]);
    expect(result.model).toBe("fake-1");
    expect(fake.calls).toHaveLength(1);
  });

  it("returns null (AI off) with no key configured and honors the test override", () => {
    expect(getAiProvider()).toBeNull();
    const fake = createFakeProvider();
    setAiProviderForTests(fake);
    expect(getAiProvider()).toBe(fake);
    setAiProviderForTests(null);
    expect(getAiProvider()).toBeNull();
  });
});
