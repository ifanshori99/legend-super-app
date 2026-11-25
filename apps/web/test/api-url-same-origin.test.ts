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
