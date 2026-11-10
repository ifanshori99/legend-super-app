// WhatsApp inbound proof parser and constants (legend-lgfru, design
// docs/design/whatsapp-inbound-verification.md D-WA2, §6.2).
// Loaded with plain Node ESM (type stripping, no resolve hook).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as identity from "../packages/shared/src/identity/index.ts";

describe("legend-lgfru whatsAppProofFromMessage", () => {
  test("D-WA2: MASUK <keyword> <code> is a sign-in proof", () => {
    assert.deepEqual(
      identity.whatsAppProofFromMessage("MASUK LEGEND K7Q4-M2XD"),
      {
        purpose: "sign_in",
        code: "K7Q4M2XD",
      },
    );
    assert.deepEqual(
      identity.whatsAppProofFromMessage("masuk cafe legend K7Q4 M2XD"),
      { purpose: "sign_in", code: "K7Q4M2XD" },
    );
  });

  test("D-WA2: RESET PIN <code> is a payslip PIN reset proof", () => {
    for (const text of [
      "RESET PIN K7Q4-M2XD",
      "reset pin k7q4m2xd",
      "  Reset  Pin  K7Q4 M2XD ",
    ])
      assert.deepEqual(identity.whatsAppProofFromMessage(text), {
        purpose: "payslip_pin_reset",
        code: "K7Q4M2XD",
      });
  });

  test("D-WA2: anything else is not a proof", () => {
    for (const text of [
      "halo K7Q4-M2XD",
      "RESET K7Q4-M2XD",
      "PIN RESET K7Q4-M2XD",
      "RESET PIN",
      "RESET PIN LEGEND K7Q4-M2XD",
      "RESET PIN K7Q4-M2XU",
      "MASUK LEGEND",
      "",
    ])
      assert.equal(identity.whatsAppProofFromMessage(text), null, text);
  });

  test("D-WA2: the reset message and its wa.me link", () => {
    assert.equal(
      identity.whatsAppProofMessage("K7Q4M2XD"),
      "RESET PIN K7Q4-M2XD",
    );
    assert.equal(
      identity.whatsAppProofDeepLink({
        numberDigits: "628111000071",
        code: "K7Q4M2XD",
      }),
      "https://wa.me/628111000071?text=RESET%20PIN%20K7Q4-M2XD",
    );
    // The legacy parser still only reads MASUK.
    assert.equal(identity.loginCodeFromMessage("RESET PIN K7Q4-M2XD"), null);
  });

  test("§6.2: proof constants", () => {
    assert.equal(
      identity.WA_PROOF_TTL_MINUTES,
      identity.LOGIN_CODE_TTL_MINUTES,
    );
    assert.equal(identity.PAYSLIP_PIN_PROOF_GRANT_MINUTES, 10);
    assert.equal(identity.PAYSLIP_PIN_PROOF_PER_USER_PER_HOUR, 5);
    // Founder decision 2026-11-11: three days (was seven in the design).
    assert.equal(identity.WA_PROOF_IDENTITY_MIN_AGE_DAYS, 3);
  });
});
