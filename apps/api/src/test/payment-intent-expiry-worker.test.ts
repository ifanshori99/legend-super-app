// Payment intent expiry sweep wiring (bead legend-jf4i; PRD §3.13 Siklus
// Pembayaran). `expireDueIntents` existed but no worker tick called it, so a
// pending code only expired when a guest request touched it. Its behavior is
// covered in payment-api.test.ts; this file checks that worker-main.ts calls it
// in the per-tenant relay tick, fail closed like the other sweeps.
//
// Run just this file (from the repo root):
//   LEGEND_TEST_FILES="src/test/payment-intent-expiry-worker.test.ts" pnpm test

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("payment intent expiry sweep", () => {
  const source = readFileSync(
    new URL("../worker-main.ts", import.meta.url),
    "utf8",
  );

  it("worker-main.ts imports expireDueIntents from the payment service", () => {
    expect(source).toMatch(
      /import \{[^}]*\bexpireDueIntents\b[^}]*\} from "\.\/services\/payment\.service\.ts"/,
    );
  });

  it("worker-main.ts runs it per tenant inside the relay tick, fail closed", () => {
    expect(source).toMatch(
      /try \{\s*await expireDueIntents\(context, new Date\(\), 200, \{\s*leaveGatewayReconciling: true,\s*\}\);\s*\} catch \{\s*console\.error\("Payment intent expiry sweep failed"\);\s*\}/,
    );
  });

  it("runs after the gateway poll so a polled intent settles before it expires", () => {
    const poll = source.indexOf("await runPaymentGatewayPollJob(");
    const expire = source.indexOf("await expireDueIntents(");
    expect(poll).toBeGreaterThan(-1);
    expect(expire).toBeGreaterThan(poll);
  });
});
