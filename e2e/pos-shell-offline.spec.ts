import { expect, test } from "@playwright/test";
import { signUp, WEB_URL } from "./helpers";

// O3 re-review P1 (bead legend-wasr7.7): the service worker keeps /pos-offline
// as the offline POS shell. It fetches it without cookies, so the route must
// answer 200 outside the `_ops` guard, carry no session, and allow the browser
// to keep it (private, never no-store).
test("the offline POS shell loads without a cookie, carries no session, and may be kept", async ({
  playwright,
  request,
}) => {
  const email = await signUp(request, "Offline Shell Probe");
  // With the cookie the document carries the session: the probe below sees it.
  const signedIn = await request.get("/pos-offline");
  expect(signedIn.status()).toBe(200);
  expect(await signedIn.text()).toContain(email);

  const anonymous = await playwright.request.newContext({ baseURL: WEB_URL });
  try {
    const shell = await anonymous.get("/pos-offline", { maxRedirects: 0 });
    expect(shell.status()).toBe(200);
    expect(shell.headers()["cache-control"]).toBe("private, no-cache");
    const html = await shell.text();
    expect(html).toContain("Kasir offline");
    expect(html).not.toContain(email);

    // The cashier screen itself sends a cookie-less fetch to sign-in: the
    // reason the worker keeps this route instead.
    const kasir = await anonymous.get("/pos/kasir", { maxRedirects: 0 });
    expect(kasir.status()).toBeGreaterThanOrEqual(300);
    expect(kasir.status()).toBeLessThan(400);

    const worker = await anonymous.get("/sw.js");
    expect(await worker.text()).toContain('SHELL_PATH = "/pos-offline"');
  } finally {
    await anonymous.dispose();
  }
});
