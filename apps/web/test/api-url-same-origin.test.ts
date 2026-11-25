vi.mock("@/lib/api/client", () => ({ apiFetch: vi.fn() }));

// 1269 E8: one web build serves every edge host. VITE_API_URL=same-origin makes
// the browser call the origin that served the page; SSR calls API_INTERNAL_URL.
async function load() {
  vi.resetModules();
  return (await import("@/lib/env")).API_URL;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("API_URL", () => {
  it("keeps a fixed origin for a cloud build", async () => {
    vi.stubEnv("VITE_API_URL", "https://api.example.test/ignored/path");
    expect(await load()).toBe("https://api.example.test");
  });

  it("uses the page origin in the browser when same-origin", async () => {
    vi.stubEnv("VITE_API_URL", "same-origin");
    vi.stubGlobal("window", {
      location: { origin: "https://edge.outlet.example.test" },
    });
    expect(await load()).toBe("https://edge.outlet.example.test");
  });

  it("uses API_INTERNAL_URL during SSR when same-origin", async () => {
    vi.stubEnv("VITE_API_URL", "same-origin");
    vi.stubEnv("API_INTERNAL_URL", "http://127.0.0.1:4000");
    expect(await load()).toBe("http://127.0.0.1:4000");
  });

  it("fails closed during SSR when same-origin and no internal URL", async () => {
    vi.stubEnv("VITE_API_URL", "same-origin");
    vi.stubEnv("API_INTERNAL_URL", "");
    await expect(load()).rejects.toThrow();
  });
});

// Review E8 finding 1: a server-rendered link must never carry the loopback
// address the web server uses to reach the API.
describe("receiptPdfUrl", () => {
  async function loadUrl() {
    vi.resetModules();
    return (await import("@/features/ws04-receipt-public/api.ts"))
      .receiptPdfUrl;
  }

  it("is relative for a same-origin build, even during SSR", async () => {
    vi.stubEnv("VITE_API_URL", "same-origin");
    vi.stubEnv("API_INTERNAL_URL", "http://127.0.0.1:4000");
    const url = (await loadUrl())("tok en", "receipt");
    expect(url).toBe("/api/public/receipts/tok%20en/pdf?kind=receipt");
    expect(url).not.toContain("127.0.0.1");
  });

  it("keeps the API origin for a cloud build", async () => {
    vi.stubEnv("VITE_API_URL", "https://api.example.test");
    expect((await loadUrl())("t", "kuitansi")).toBe(
      "https://api.example.test/api/public/receipts/t/pdf?kind=kuitansi",
    );
  });
});
