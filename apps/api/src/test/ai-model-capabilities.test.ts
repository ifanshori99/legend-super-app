// legend-39d.8: capability discovery is entirely fixture driven; no real DNS/API.
import { describe, expect, it, vi } from "vitest";
import { detectModelCapabilities } from "../lib/ai/model-capabilities.ts";

const KEY = "sk-fixture-do-not-leak";
const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
const options = {
  baseUrl: "https://models.example.com/v1",
  apiKey: KEY,
  model: "tenant-model",
  resolve,
};

describe("model capability source precedence", () => {
  it.each(["context_length", "max_model_len", "context_window"])(
    "uses the selected /models record's %s before the known table",
    async (contextField) => {
      const fetch = vi.fn(async () =>
        Response.json({
          data: [
            { id: "other", [contextField]: 999_999 },
            {
              id: "gpt-4o",
              [contextField]: 32_768,
              max_output_tokens: 4096,
              supported_parameters: ["tools", "reasoning_effort"],
            },
          ],
        }),
      );
      const detected = await detectModelCapabilities({
        ...options,
        model: "gpt-4o",
        fetch: fetch as typeof globalThis.fetch,
      });
      expect(detected).toMatchObject({
        contextWindow: 32_768,
        maxOutputTokens: 4096,
        supportsTools: true,
        supportsReasoning: true,
        source: "metadata",
      });
      const [url, init] = fetch.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe("https://models.example.com/v1/models");
      expect(init.method ?? "GET").toBe("GET");
      expect(new Headers(init.headers).get("authorization")).toBe(
        `Bearer ${KEY}`,
      );
      expect(["manual", "error"]).toContain(init.redirect);
    },
  );

  it("reads OpenRouter's top_provider output limit", async () => {
    const detected = await detectModelCapabilities({
      ...options,
      fetch: (async () =>
        Response.json({
          data: [
            {
              id: options.model,
              context_length: 65_536,
              top_provider: { max_completion_tokens: 8192 },
              supported_parameters: ["tools", "reasoning"],
            },
          ],
        })) as typeof fetch,
    });
    expect(detected).toMatchObject({
      contextWindow: 65_536,
      maxOutputTokens: 8192,
      supportsTools: true,
      supportsReasoning: true,
      source: "metadata",
    });
  });

  it("falls back to known model limits when standard OpenAI metadata has no capabilities", async () => {
    const detected = await detectModelCapabilities({
      ...options,
      model: "gpt-4o",
      fetch: (async () =>
        Response.json({
          data: [{ id: "gpt-4o", object: "model", owned_by: "openai" }],
        })) as typeof fetch,
    });
    expect(detected).toMatchObject({
      contextWindow: 128_000,
      supportsTools: true,
      supportsReasoning: false,
      source: "known",
    });
  });

  it.each(["unlisted-new-model", "gpt-4o-lookalike-unknown"])(
    "uses small fail-closed defaults for unknown %s when discovery fails",
    async (model) => {
      const detected = await detectModelCapabilities({
        ...options,
        model,
        fetch: (async () => {
          throw new Error(`Do not expose ${KEY}`);
        }) as typeof fetch,
      });
      expect(detected).toMatchObject({
        contextWindow: 4096,
        maxOutputTokens: 1024,
        supportsTools: false,
        supportsReasoning: false,
        reasoningEfforts: [],
        source: "default",
      });
      expect(JSON.stringify(detected)).not.toContain(KEY);
    },
  );

  it("ignores invalid limits instead of trusting provider-controlled metadata", async () => {
    const detected = await detectModelCapabilities({
      ...options,
      fetch: (async () =>
        Response.json({
          data: [
            {
              id: options.model,
              context_window: -1,
              max_output_tokens: "not-a-number",
            },
          ],
        })) as typeof fetch,
    });
    expect(detected.contextWindow).toBe(4096);
    expect(detected.maxOutputTokens).toBe(1024);
  });

  it("allows explicit administrator overrides over discovery", async () => {
    const detected = await detectModelCapabilities({
      ...options,
      fetch: (async () =>
        Response.json({
          data: [
            {
              id: options.model,
              context_length: 32_768,
              max_output_tokens: 4096,
            },
          ],
        })) as typeof fetch,
      overrides: {
        contextWindow: 16_384,
        maxOutputTokens: 2048,
        supportsTools: true,
        supportsReasoning: false,
      },
    });
    expect(detected).toMatchObject({
      contextWindow: 16_384,
      maxOutputTokens: 2048,
      supportsTools: true,
      supportsReasoning: false,
      reasoningEfforts: [],
    });
  });

  it("does not call private metadata endpoints", async () => {
    const fetch = vi.fn();
    const detected = await detectModelCapabilities({
      ...options,
      baseUrl: "https://127.0.0.1/v1",
      fetch: fetch as typeof globalThis.fetch,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(detected.source).toBe("default");
  });
});

describe("legend-39d.8 metadata ceilings", () => {
  it("legend-39d.8 A1 honors the smaller endpoint output ceiling and advertised reasoning efforts", async () => {
    const detected = await detectModelCapabilities({
      ...options,
      fetch: (async () =>
        Response.json({
          data: [
            {
              id: options.model,
              context_length: 65_536,
              max_output_tokens: 8192,
              top_provider: {
                context_length: 32_768,
                max_completion_tokens: 4096,
              },
              supported_parameters: ["tools", "reasoning_effort"],
              reasoning_efforts: ["low", "medium"],
            },
          ],
        })) as typeof fetch,
    });
    expect(detected).toMatchObject({
      contextWindow: 32_768,
      maxOutputTokens: 4096,
      supportsReasoning: true,
      reasoningEfforts: ["low", "medium"],
    });
  });
});

describe("legend-39d.8 unknown model identity", () => {
  it.each(["constructor", "toString", "__proto__"])(
    "legend-39d.8 A1 treats prototype name %s as an unknown model",
    async (model) => {
      const detected = await detectModelCapabilities({
        ...options,
        model,
        fetch: (async () => Response.json({ data: [] })) as typeof fetch,
      });
      expect(detected).toEqual({
        contextWindow: 4096,
        maxOutputTokens: 1024,
        supportsTools: false,
        supportsReasoning: false,
        reasoningEfforts: [],
        source: "default",
      });
    },
  );
});
