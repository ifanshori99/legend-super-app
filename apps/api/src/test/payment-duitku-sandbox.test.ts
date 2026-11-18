// Optional release probes: never run in CI and never contact a live host.
// The two DUITKU_SANDBOX_* variables must hold sandbox credentials only.
// Creates unpaid sandbox inquiries; never pays, cancels, or refunds anything.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  duitkuBaseUrl,
  duitkuInquiry,
  duitkuMethodCategory,
  duitkuTransactionStatus,
  signGetPaymentMethod,
  signInquiry,
  signTransactionStatus,
} from "../services/payment-duitku-wire";

type ProbeEnv = Partial<Record<string, string | undefined>>;

// The explicit opt-in is part of the gate: credentials alone never enable it.
function probeEnabled(env: ProbeEnv): boolean {
  return (
    !env.CI &&
    env.DUITKU_SANDBOX_PROBE === "1" &&
    (env.DUITKU_SANDBOX_MERCHANT_CODE ?? "").length > 0 &&
    (env.DUITKU_SANDBOX_API_KEY ?? "").length > 0
  );
}

const merchantCode = process.env.DUITKU_SANDBOX_MERCHANT_CODE ?? "";
const apiKey = process.env.DUITKU_SANDBOX_API_KEY ?? "";
const enabled = probeEnabled(process.env);
const guidePath = new URL(
  "../../../../docs/qa/duitku-sandbox-gerbang.md",
  import.meta.url,
);
const credentials = { merchantCode, apiKey, environment: "sandbox" as const };
const amountIdr = 10_000;
const baseUrl = duitkuBaseUrl("sandbox");
const evidencePath = new URL(
  "../../../../docs/qa/evidence/duitku-sandbox/gerbang.redacted.json",
  import.meta.url,
);

type JsonRecord = Record<string, unknown>;
type Reply = { httpStatus: number; body: JsonRecord };
type Evidence = {
  recordedAt: string;
  host: string;
  results: Record<string, unknown>;
};

function hasSecret(value: unknown, key = apiKey): boolean {
  if (key.length === 0) return false;
  try {
    const serialized = JSON.stringify(value, (_field, item: unknown) =>
      item instanceof Error
        ? {
            ...item,
            name: item.name,
            message: item.message,
            stack: item.stack,
            cause: item.cause,
          }
        : item,
    );
    return serialized?.includes(key) ?? false;
  } catch {
    // Uninspectable values must never be passed through to a log sink.
    return true;
  }
}

describe("Duitku sandbox probe safety", () => {
  it("detects secrets in nested Error messages", () => {
    const secret = "duitku_sandbox_do_not_print_nested_error";
    expect(hasSecret({ err: new Error(secret) }, secret)).toBe(true);
  });

  const dummy = {
    DUITKU_SANDBOX_MERCHANT_CODE: "dummy-merchant",
    DUITKU_SANDBOX_API_KEY: "dummy-key",
  };

  it("runs only with the explicit opt-in, credentials, and no CI", () => {
    expect(probeEnabled({ ...dummy, DUITKU_SANDBOX_PROBE: "1" })).toBe(true);
    expect(probeEnabled(dummy)).toBe(false);
    expect(probeEnabled({ ...dummy, DUITKU_SANDBOX_PROBE: "true" })).toBe(
      false,
    );
    expect(
      probeEnabled({ ...dummy, DUITKU_SANDBOX_PROBE: "1", CI: "true" }),
    ).toBe(false);
    expect(
      probeEnabled({
        DUITKU_SANDBOX_PROBE: "1",
        DUITKU_SANDBOX_MERCHANT_CODE: "dummy-merchant",
      }),
    ).toBe(false);
  });

  it("documents a command that sets the opt-in so certification cannot be skipped", async () => {
    const guide = await readFile(guidePath, "utf8");
    const commands = guide
      .split("\n")
      .filter((line) => line.includes("payment-duitku-sandbox.test.ts"));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands)
      expect(command).toContain("DUITKU_SANDBOX_PROBE=1");
    // Operator must confirm the run was not skipped and the evidence is new.
    expect(guide).toContain("recordedAt");
    expect(guide).toMatch(/dilewati|skipped/i);
  });

  it("fails instead of skipping when the opt-in is set outside CI without credentials", () => {
    const optedIn = process.env.DUITKU_SANDBOX_PROBE === "1" && !process.env.CI;
    if (optedIn)
      expect(
        enabled,
        "DUITKU_SANDBOX_PROBE=1 set but sandbox credentials missing: certification would be skipped",
      ).toBe(true);
  });
});

function ensureNoSecret(value: unknown) {
  if (hasSecret(value)) throw new Error("Sandbox response or error leaked key");
}

function record(reply: Reply) {
  return {
    httpStatus: reply.httpStatus,
    fields: Object.keys(reply.body).sort(),
    statusCode:
      typeof reply.body.statusCode === "string" &&
      /^[0-9]{2}$/.test(reply.body.statusCode)
        ? reply.body.statusCode
        : null,
  };
}

async function request(path: string, body: JsonRecord): Promise<Reply> {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    const json: unknown = await response.json();
    ensureNoSecret(json);
    if (!json || typeof json !== "object" || Array.isArray(json))
      throw new Error("Sandbox response was not an object");
    return { httpStatus: response.status, body: json as JsonRecord };
  } catch (error) {
    ensureNoSecret(error instanceof Error ? error.message : String(error));
    throw new Error("Duitku sandbox request failed; inspect redacted evidence");
  }
}

function inquiry(paymentMethod: string, expiryPeriod: number) {
  const merchantOrderId = `legend-${randomUUID()}`;
  return {
    merchantOrderId,
    body: {
      merchantCode,
      paymentAmount: amountIdr,
      paymentMethod,
      merchantOrderId,
      productDetails: "Legend unpaid sandbox probe",
      email: "sandbox@example.invalid",
      customerVaName: "Legend Sandbox",
      callbackUrl: "https://example.invalid/legend-sandbox/callback",
      returnUrl: "https://example.invalid/legend-sandbox/return",
      expiryPeriod,
      signature: signInquiry(credentials, merchantOrderId, amountIdr),
    },
  };
}

function paymentUrlEvidence(reply: Reply) {
  let url: URL;
  try {
    url = new URL(String(reply.body.paymentUrl));
  } catch {
    return { host: null, allowed: false };
  }
  const host = url.hostname.toLowerCase();
  return {
    host,
    allowed:
      url.protocol === "https:" &&
      (host === "duitku.com" || host.endsWith(".duitku.com")),
  };
}

describe.skipIf(!enabled)(
  "Duitku sandbox release gates (optional, unpaid)",
  () => {
    it("[legend-7tqe8][legend-1yig6] records links, VC fields, expiry and unknown orders", async () => {
      const evidence: Evidence = {
        recordedAt: new Date().toISOString(),
        host: new URL(baseUrl).hostname,
        results: {},
      };
      // Catch accidental logging too, without replaying any provider text.
      let leakedLog = false;
      const spies = ["log", "info", "warn", "error", "debug"].map((method) =>
        vi.spyOn(console, method as "log").mockImplementation((...args) => {
          leakedLog ||= hasSecret(args);
        }),
      );
      try {
        expect(new URL(baseUrl).hostname).toBe("sandbox.duitku.com");
        const datetime = new Date(Date.now() + 7 * 3_600_000)
          .toISOString()
          .slice(0, 19)
          .replace("T", " ");
        const methods = await request("paymentmethod/getpaymentmethod", {
          merchantcode: merchantCode,
          amount: amountIdr,
          datetime,
          signature: signGetPaymentMethod(credentials, amountIdr, datetime),
        });
        evidence.results.methods = record(methods);
        const rows = Array.isArray(methods.body.paymentFee)
          ? methods.body.paymentFee
          : [];
        const codes = rows.flatMap((row: unknown) => {
          if (!row || typeof row !== "object") return [];
          const code = (row as JsonRecord).paymentMethod;
          return typeof code === "string" && /^[A-Z0-9]{1,8}$/.test(code)
            ? [code]
            : [];
        });
        const ewallet = codes.find(
          (code) => duitkuMethodCategory(code) === "ewallet",
        );
        const qris = codes.find(
          (code) => duitkuMethodCategory(code) === "qris",
        );
        evidence.results.availableMethodCodes = codes;
        expect
          .soft(Boolean(ewallet), "Sandbox must enable an e-wallet")
          .toBe(true);
        expect.soft(codes.includes("VC"), "Sandbox must enable VC").toBe(true);
        expect.soft(Boolean(qris), "Sandbox must enable QRIS").toBe(true);

        for (const code of [...(ewallet ? [ewallet] : []), "VC"]) {
          const input = inquiry(code, 1);
          const reply = await request("v2/inquiry", input.body);
          evidence.results[code] = record(reply);
          expect
            .soft(reply.body.statusCode === "00", "Inquiry must succeed")
            .toBe(true);
          const url = paymentUrlEvidence(reply);
          let parserAccepted = false;
          try {
            await duitkuInquiry({
              creds: credentials,
              merchantOrderId: input.merchantOrderId,
              amountIdr,
              paymentMethod: code,
              productDetails: input.body.productDetails,
              email: input.body.email,
              customerVaName: input.body.customerVaName,
              callbackUrl: input.body.callbackUrl,
              returnUrl: input.body.returnUrl,
              expiryPeriodMinutes: 1,
              fetch: async () =>
                Response.json(reply.body, { status: reply.httpStatus }),
            });
            parserAccepted = true;
          } catch (error) {
            ensureNoSecret(
              error instanceof Error ? error.message : String(error),
            );
          }
          evidence.results[code] = {
            ...record(reply),
            paymentUrl: url,
            parserAccepted,
            // Inspect the real VC response without persisting card or URL values.
            fieldTypes: Object.fromEntries(
              [
                "paymentUrl",
                "reference",
                "vaNumber",
                "qrString",
                "creditCardDetail",
              ].map((field) => [field, typeof reply.body[field]]),
            ),
          };
          expect
            .soft(url.allowed, "Payment link must match the adapter allowlist")
            .toBe(true);
          expect
            .soft(
              parserAccepted,
              "Inquiry fields must match the production parser",
            )
            .toBe(true);
        }

        let qrOrderId: string | null = null;
        if (qris) {
          const zero = inquiry(qris, 0);
          const zeroReply = await request("v2/inquiry", zero.body);
          evidence.results.expiryPeriodZero = record(zeroReply);
          // A zero may mean a provider default; retain the outcome rather than
          // assuming rejection. The real release contract is acceptance of one.
          const qr = inquiry(qris, 1);
          const qrReply = await request("v2/inquiry", qr.body);
          evidence.results.expiryPeriodOne = record(qrReply);
          expect
            .soft(
              qrReply.body.statusCode === "00",
              "One-minute QRIS must be accepted",
            )
            .toBe(true);
          if (qrReply.body.statusCode === "00") qrOrderId = qr.merchantOrderId;
        }

        const unknownOrderId = `missing-${randomUUID()}`;
        const unknown = await request("transactionStatus", {
          merchantCode,
          merchantOrderId: unknownOrderId,
          signature: signTransactionStatus(credentials, unknownOrderId),
        });
        evidence.results.unknownOrder = record(unknown);
        let unknownAdapterStatus = "unavailable";
        try {
          const parsed = await duitkuTransactionStatus({
            creds: credentials,
            merchantOrderId: unknownOrderId,
            fetch: async () =>
              Response.json(unknown.body, { status: unknown.httpStatus }),
          });
          unknownAdapterStatus = parsed.status;
        } catch (error) {
          ensureNoSecret(
            error instanceof Error ? error.message : String(error),
          );
        }
        evidence.results.unknownAdapterStatus = unknownAdapterStatus;
        expect
          .soft(
            unknownAdapterStatus === "paid",
            "Unknown order must never be paid",
          )
          .toBe(false);

        // One minute plus a 15-second provider grace period; the inquiry is
        // deliberately never paid. No refund endpoint exists in this probe.
        if (qrOrderId) {
          await new Promise((resolve) => setTimeout(resolve, 75_000));
          const expired = await request("transactionStatus", {
            merchantCode,
            merchantOrderId: qrOrderId,
            signature: signTransactionStatus(credentials, qrOrderId),
          });
          evidence.results.qrisAfterExpiry = record(expired);
          expect
            .soft(
              expired.body.statusCode === "02",
              "Expired unpaid QRIS must be failed/expired",
            )
            .toBe(true);
        }
      } catch (error) {
        ensureNoSecret(error instanceof Error ? error.message : String(error));
        throw new Error(
          "Duitku sandbox release gate failed; inspect redacted evidence",
        );
      } finally {
        spies.forEach((spy) => spy.mockRestore());
        ensureNoSecret(evidence);
        await mkdir(new URL(".", evidencePath), { recursive: true });
        await writeFile(
          evidencePath,
          `${JSON.stringify(evidence, null, 2)}\n`,
          {
            mode: 0o600,
          },
        );
        expect(leakedLog, "Sandbox log leaked key").toBe(false);
      }
    }, 240_000);
  },
);
