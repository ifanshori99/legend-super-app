import { Writable } from "node:stream";
import express from "express";
import { pinoHttp } from "pino-http";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { db } from "../db";
import { createLogger } from "../lib/logger";
import { errorHandler } from "../middleware/error-handler";
import { agent } from "./helpers";

// legend-8gsj: database row values (card numbers included) must never reach a
// log line, while the error's identifying fields stay for debugging.

const PAN = "4111111111111111";
const CONSTRAINT = "log_redact_amount_positive";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n").filter(Boolean))
        lines.push(JSON.parse(line));
      done();
    },
  });
  return {
    lines,
    logger: createLogger({ level: "debug", destination: stream }),
  };
}

// A real PostgreSQL CHECK violation. The bound parameter holds a card number,
// so drizzle's message ("params: ...") and pg's detail ("Failing row contains
// (...)") both carry it.
async function realDatabaseError(): Promise<Error> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(
          `create temp table log_redact_probe (holder text, amount int, constraint ${CONSTRAINT} check (amount > 0)) on commit drop`,
        ),
      );
      await tx.execute(
        sql`insert into log_redact_probe (holder, amount) values (${PAN}, ${0})`,
      );
    });
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the insert to violate the check constraint");
}

function expectNoRowValues(output: string) {
  expect(output).not.toContain(PAN);
  expect(output).not.toContain("params:");
  expect(output).not.toContain("Failing row");
  expect(output).not.toContain("Key (");
}

function errOf(line: Record<string, unknown> | undefined) {
  return line?.err as Record<string, unknown> | undefined;
}

describe("Log redaction of database errors and card fields", () => {
  it("sanity: the probe error really carries the card number before scrubbing", async () => {
    const error = await realDatabaseError();
    const everything = `${error.message}\n${error.stack ?? ""}\n${JSON.stringify(
      (error as { cause?: unknown }).cause,
      Object.getOwnPropertyNames((error as { cause?: object }).cause ?? {}),
    )}`;
    expect(everything).toContain(PAN);
  });

  it("an unexpected database error through the HTTP 500 path is logged without row values", async () => {
    const dbError = await realDatabaseError();
    const { lines, logger } = capture();
    const app = express();
    app.use(
      pinoHttp({
        logger,
        genReqId: () => "trace-db-500",
        customLogLevel: (_req, res, err) =>
          err || res.statusCode >= 500 ? "error" : "info",
      }),
    );
    app.get("/boom", (_req, _res, next) => next(dbError));
    app.use(errorHandler);

    const response = await agent(app).get("/boom");

    // 6. The client still gets the generic 500 body.
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_ERROR");
    expect(response.body.error.message).toBe(
      "Something went wrong. Try again.",
    );
    expectNoRowValues(JSON.stringify(response.body));

    const errors = lines.filter((line) => line.level === 50);
    expect(errors).toHaveLength(1);
    expectNoRowValues(JSON.stringify(lines));

    const serialized = JSON.stringify(errors[0]);
    expect(serialized).toContain("23514"); // SQLSTATE check_violation
    expect(serialized).toContain(CONSTRAINT);
    expect(serialized).toContain("log_redact_probe");
  });

  it("req.log and res.log of the real app drop row values from a database error but keep code and constraint", async () => {
    const dbError = await realDatabaseError();
    const { lines, logger } = capture();
    const app = createApp({ logger });

    // Test-only handler placed right after the pino-http layer (Express 5
    // keeps layers in app.router.stack) so req.log / res.log exist without
    // touching app.ts or the routes.
    const router = app.router as unknown as {
      stack: { name?: string; handle: { name?: string } }[];
      get: (path: string, handler: express.RequestHandler) => void;
    };
    router.get("/__log-probe", (req, res) => {
      req.log.error({ err: dbError }, "req.log probe");
      res.log.error({ err: dbError }, "res.log probe");
      res.json({ ok: true });
    });
    const probeLayer = router.stack.pop() as (typeof router.stack)[number];
    // app.ts registers pinoHttp directly after requestContext (pino-http's
    // own layer is an anonymous "result" function), so anchor on the named one.
    const contextIndex = router.stack.findIndex(
      (layer) => layer.handle.name === "requestContext",
    );
    expect(contextIndex, "requestContext layer in app.router.stack").toBeGreaterThan(
      -1,
    );
    router.stack.splice(contextIndex + 2, 0, probeLayer);

    const response = await agent(app).get("/__log-probe");
    expect(response.status).toBe(200);

    const probeLines = lines.filter((line) =>
      String(line.msg).endsWith(" probe"),
    );
    expect(probeLines.map((line) => line.msg).sort()).toEqual([
      "req.log probe",
      "res.log probe",
    ]);
    expectNoRowValues(JSON.stringify(lines));
    for (const line of probeLines) {
      const serialized = JSON.stringify(line);
      expect(serialized).toContain("23514");
      expect(serialized).toContain(CONSTRAINT);
      expect(serialized).toContain("log_redact_probe");
    }
  });

  it("logger.error({ err }) with a database error keeps code and constraint but drops row values", async () => {
    const dbError = await realDatabaseError();
    const { lines, logger } = capture();

    logger.error({ err: dbError }, "query failed");

    expect(lines).toHaveLength(1);
    expect(lines[0].msg).toBe("query failed");
    expectNoRowValues(JSON.stringify(lines[0]));

    // The pg error is the cause of drizzle's error, or the error itself.
    const serialized = JSON.stringify(lines[0]);
    expect(serialized).toContain("23514");
    expect(serialized).toContain(CONSTRAINT);
    expect(errOf(lines[0])?.stack).toEqual(expect.stringContaining("at "));
  });

  it("scrubs a database error wrapped as the cause of another error and keeps the outer message", async () => {
    const dbError = await realDatabaseError();
    const { lines, logger } = capture();

    logger.error(
      { err: new Error("outer failure", { cause: dbError }) },
      "wrapped",
    );

    expect(lines).toHaveLength(1);
    expectNoRowValues(JSON.stringify(lines[0]));
    // pino's err serializer appends the cause chain's messages to the outer
    // one ("outer failure: <cause message>"), so assert the prefix; the scrubbed
    // cause text is covered by expectNoRowValues above.
    expect(String(errOf(lines[0])?.message)).toMatch(/^outer failure/);
    const serialized = JSON.stringify(lines[0]);
    expect(serialized).toContain("23514");
    expect(serialized).toContain(CONSTRAINT);
  });

  it("scrubs a database error inside an AggregateError's errors and keeps a plain member's message", async () => {
    const dbError = await realDatabaseError();
    const { lines, logger } = capture();

    logger.error(
      {
        err: new AggregateError(
          [dbError, new Error("plain member failure")],
          "batch",
        ),
      },
      "aggregate",
    );

    expect(lines).toHaveLength(1);
    expectNoRowValues(JSON.stringify(lines[0]));
    const serialized = JSON.stringify(lines[0]);
    expect(String(errOf(lines[0])?.message)).toMatch(/^batch/);
    // The plain member is not a database error, so its message is untouched.
    expect(serialized).toContain("plain member failure");
    // The database member keeps its identifying fields.
    expect(serialized).toContain("23514");
    expect(serialized).toContain(CONSTRAINT);
  });

  it("keeps the message of a non-database cause on an AggregateError", () => {
    const { lines, logger } = capture();

    logger.error(
      {
        err: new AggregateError([new Error("member one")], "batch", {
          cause: new Error("upstream cache unavailable"),
        }),
      },
      "aggregate with cause",
    );

    expect(lines).toHaveLength(1);
    const serialized = JSON.stringify(lines[0]);
    expect(serialized).toContain("upstream cache unavailable");
    expect(serialized).toContain("member one");
    expectNoRowValues(serialized);
  });

  it("leaves a non-database error unchanged, message and stack included", () => {
    const { lines, logger } = capture();
    const error = new Error("plain failure: cache miss for key abc");

    logger.error({ err: error }, "not a database error");

    const err = errOf(lines[0]);
    expect(err?.message).toBe("plain failure: cache miss for key abc");
    expect(err?.type).toBe("Error");
    expect(String(err?.stack)).toContain("plain failure: cache miss for key abc");
    expect(String(err?.stack)).toContain("at ");
  });

  it("redacts card fields at the top level and one level down", () => {
    const { lines, logger } = capture();

    logger.info(
      {
        pan: PAN,
        cvv: "123",
        terminal: {
          cardNumber: PAN,
          card_number: PAN,
          track1: "B4111111111111111^DOE/J^2512",
          track2: "4111111111111111=2512",
          trackData: "raw-track",
          cvc: "456",
          cvv2: "789",
          pinBlock: "0412AC",
          pin_block: "0412AC",
        },
        track: "raw-track",
        track_data: "raw-track",
      },
      "terminal answer",
    );

    expect(lines).toHaveLength(1);
    const line = lines[0] as Record<string, unknown>;
    const terminal = line.terminal as Record<string, unknown>;
    expect(line.pan).toBe("[redacted]");
    expect(line.cvv).toBe("[redacted]");
    expect(line.track).toBe("[redacted]");
    expect(line.track_data).toBe("[redacted]");
    for (const field of [
      "cardNumber",
      "card_number",
      "track1",
      "track2",
      "trackData",
      "cvc",
      "cvv2",
      "pinBlock",
      "pin_block",
    ])
      expect(terminal[field], field).toBe("[redacted]");
    expect(JSON.stringify(line)).not.toContain(PAN);
    expect(line.msg).toBe("terminal answer");
  });
});
