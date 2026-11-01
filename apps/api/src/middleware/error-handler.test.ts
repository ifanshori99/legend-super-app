import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { CoreError, apiErrorBodySchema } from "@starter/shared/core";
import { DeliveryError } from "@starter/shared/delivery";
import { PosError } from "@starter/shared/pos";
import { requestContext } from "../lib/request-context.ts";
import { errorHandler } from "./error-handler.ts";

function appThrowing(error: unknown) {
  const app = express();
  app.use(requestContext);
  app.get("/", () => {
    throw error;
  });
  app.use(errorHandler);
  return app;
}

describe("D-CORE-4 error envelope", () => {
  it("maps CoreError using its contract status and request ID", async () => {
    const response = await request(
      appThrowing(new CoreError("OUTLET_OUT_OF_SCOPE", "Tidak diizinkan.")),
    )
      .get("/")
      .set("X-Request-Id", "request-123");
    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: {
        code: "OUTLET_OUT_OF_SCOPE",
        message: "Tidak diizinkan.",
        requestId: "request-123",
      },
    });
    expect(apiErrorBodySchema.safeParse(response.body).success).toBe(true);
  });
  it("maps a declared domain error to its contract status", async () => {
    const response = await request(
      appThrowing(new DeliveryError("DELIVERY_ORDER_NOT_FOUND")),
    ).get("/");
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("DELIVERY_ORDER_NOT_FOUND");
    expect(response.body.error.requestId).toBe(
      response.headers["x-request-id"],
    );
  });
  it("maps PosError to its contract status", async () => {
    const response = await request(
      appThrowing(new PosError("BUSINESS_DAY_ALREADY_CLOSED")),
    ).get("/");
    expect(response.status).toBe(
      new PosError("BUSINESS_DAY_ALREADY_CLOSED").status,
    );
    expect(response.body.error.code).toBe("BUSINESS_DAY_ALREADY_CLOSED");
  });
  it("does not expose an arbitrary error with forged status and code", async () => {
    const error = Object.assign(new Error("secret"), {
      status: 400,
      code: "FAKE",
    });
    const response = await request(appThrowing(error)).get("/");
    expect(response.status).toBe(500);
    expect(response.body.error).toMatchObject({
      code: "INTERNAL_ERROR",
      requestId: response.headers["x-request-id"],
    });
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });
});
