// AiError reaches the client with its own status and code (bead legend-9tlg).
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { AI_ERROR_CODES, AiError, aiErrorHttpStatus } from "@starter/shared/ai";
import { errorHandler } from "../middleware/error-handler.ts";

function appThrowing(error: unknown) {
  const app = express();
  app.get("/boom", () => {
    throw error;
  });
  app.use(errorHandler);
  return app;
}

describe("error handler: AiError", () => {
  it("returns the AiError status and code", async () => {
    const res = await request(
      appThrowing(new AiError("AI_QUOTA_EXCEEDED")),
    ).get("/boom");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("AI_QUOTA_EXCEEDED");
  });

  it("maps every AI error code to its documented status", async () => {
    for (const code of AI_ERROR_CODES) {
      const res = await request(appThrowing(new AiError(code))).get("/boom");
      expect(res.status).toBe(aiErrorHttpStatus[code]);
      expect(res.body.error.code).toBe(code);
    }
  });

  it("keeps hiding unrecognized errors", async () => {
    const res = await request(appThrowing(new Error("secret detail"))).get(
      "/boom",
    );
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("secret detail");
  });
});
