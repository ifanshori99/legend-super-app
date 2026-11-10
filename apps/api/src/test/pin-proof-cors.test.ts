// (i) CORS preflight for the outlet screen (bead legend-u7g9w). The kiosk sends
// X-Device-Token and X-Pin-Proof cross-origin, so the preflight must allow both
// headers for the trusted web origin on the three routes of the flow, and must
// not allow any origin outside the trusted list.
//
// Assumption: the preflight answer lists allowed headers in
// Access-Control-Allow-Headers (case-insensitive, comma separated).
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { WEB_ORIGIN } from "./helpers.ts";

const app = createApp();
const routes = [
  "/api/staff-pins/verify",
  "/api/storage/uploads",
  "/api/hris/attendance/outlet-clock",
];

const allowedHeaders = (value: unknown) =>
  String(value ?? "")
    .toLowerCase()
    .split(",")
    .map((item) => item.trim());

describe("(i) CORS preflight allows X-Device-Token and X-Pin-Proof", () => {
  it.each(routes)(
    "(i) OPTIONS %s from the trusted origin allows both headers",
    async (route) => {
      const response = await request(app)
        .options(route)
        .set("Origin", WEB_ORIGIN)
        .set("Access-Control-Request-Method", "POST")
        .set("Access-Control-Request-Headers", "x-device-token,x-pin-proof");
      expect(response.status).toBeLessThan(300);
      expect(response.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
      const headers = allowedHeaders(
        response.headers["access-control-allow-headers"],
      );
      expect(headers).toContain("x-device-token");
      expect(headers).toContain("x-pin-proof");
    },
  );

  it("(i) an untrusted origin is not allowed, whatever the headers", async () => {
    const response = await request(app)
      .options("/api/hris/attendance/outlet-clock")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "x-device-token,x-pin-proof");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
