// POS kasir: maps the server's `order.tender_voided` reason to the cashier
// message (bead legend-56mo2). Includes `edc_request_open`: QRIS refunded
// because a card EDC sale is still open, so the guest pays again.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TENDER_VOID_REASONS,
  tenderVoidMessageKey,
} from "../apps/web/src/features/ws04-pos-kasir/tender-void-reason.ts";
import { posKasirGatewayMessages } from "../packages/shared/src/i18n/messages/pos-kasir-gateway.ts";

const group = posKasirGatewayMessages.tenderVoided;
const textOf = (key) => group[key.split(".").at(-1)];

test("every known reason maps to its own non-empty Indonesian message", () => {
  const seen = new Set();
  for (const reason of TENDER_VOID_REASONS) {
    const key = tenderVoidMessageKey(reason);
    assert.equal(key, `posKasirGateway.tenderVoided.${reason}`);
    const text = textOf(key);
    assert.ok(text && text.length > 0, reason);
    seen.add(text);
  }
  assert.equal(seen.size, TENDER_VOID_REASONS.length);
});

test("edc_request_open says QRIS is returned and the guest pays again", () => {
  const text = textOf(tenderVoidMessageKey("edc_request_open"));
  assert.match(text, /EDC/);
  assert.match(text, /dikembalikan/);
  assert.match(text, /membayar ulang/);
});

test("unknown or missing reason gets the generic message", () => {
  for (const reason of ["something_new", "", null, undefined]) {
    const key = tenderVoidMessageKey(reason);
    assert.equal(key, "posKasirGateway.tenderVoided.unknown");
    assert.ok(textOf(key));
  }
});
