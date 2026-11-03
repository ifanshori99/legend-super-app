import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { tlsAskRateLimit } from "./tls-ask";

describe("tlsAskRateLimit", () => {
  it("legend-7bd caps certificate asks per window and resets afterwards", async () => {
    let clock = 0;
    const app = express();
    app.get(
      "/ask",
      tlsAskRateLimit({ limit: 2, windowMs: 1000, now: () => clock }),
      (_req, res) => {
        res.status(200).end();
      },
    );
    expect((await request(app).get("/ask")).status).toBe(200);
    expect((await request(app).get("/ask")).status).toBe(200);
    expect((await request(app).get("/ask")).status).toBe(429);
    clock = 1000;
    expect((await request(app).get("/ask")).status).toBe(200);
  });
});
