// O4 review K P2 3 (bead legend-wasr7.8, Keputusan CTO 27 Nov): the cashier
// tablet reads the status of GET /api/health cross-origin, so a dead API
// behind the proxy (502) counts as offline. Only WEB_URL plus TRUSTED_ORIGINS
// may read it; the answer carries no secret and needs no cookie.
//
// Assumption: a plain GET needs no preflight; reading the status needs
// Access-Control-Allow-Origin equal to the caller's origin.
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { WEB_ORIGIN } from "./helpers.ts";

const app = createApp();

describe("GET /api/health cross-origin read", () => {
  it("the trusted web origin may read the answer, without a cookie", async () => {
    const response = await request(app)
      .get("/api/health")
      .set("Origin", WEB_ORIGIN);
    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(Object.keys(response.body).sort()).toEqual(["scanner", "status"]);
  });

  it("an untrusted origin may not read it", async () => {
    const response = await request(app)
      .get("/api/health")
      .set("Origin", "https://evil.example");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
