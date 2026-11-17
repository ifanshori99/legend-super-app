// Mock mode handlers of the charge screen (VITE_API_MOCK=true). One demo
// charge answers to any id: POS-0048, Meja A12, Nasi ayam -> Nasi sapi, Rp10.000.
//
//   ?demo=selisih-lunas         the charge is already paid
//   ?demo=selisih-belum-pasti   the first collect is recorded but the answer
//                               never arrives (504); the status check shows
//                               it paid, a retry with the same key replays
//   ?mock=error | empty | slow  the shared scenarios (transport)
//
// Mirrors apps/api/src/services/order-recovery-charge-pos.ts: cash only, the
// amount must reach the charge, a replay with the same key answers the same, a
// different key on a paid charge is a 409.
import { ApiError } from "@/lib/api/errors";
import { registerMock } from "@/lib/mock/registry";
import { collectIssueChargeAtPos, getIssueCharge } from "./charge-endpoints";

type Stored = {
  status: "open" | "paid";
  paidKey: string | null;
  /** The first collect answers 504 once, after recording. */
  dropAnswer: boolean;
};

const store = new Map<string, Stored>();

function demoSeed(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("demo");
}

function stored(chargeId: string): Stored {
  let entry = store.get(chargeId);
  if (!entry) {
    const seed = demoSeed();
    entry = {
      status: seed === "selisih-lunas" ? "paid" : "open",
      paidKey: null,
      dropAnswer: seed === "selisih-belum-pasti",
    };
    store.set(chargeId, entry);
  }
  return entry;
}

const AT = "2026-11-12T07:32:00.000Z";

function chargeWire(chargeId: string, entry: Stored) {
  return {
    id: chargeId,
    orderId: "01JBQ9C0000000000000000048",
    status: entry.status,
    differenceIdr: 10_000,
    amountIdr: 10_000,
    paidAt: entry.status === "paid" ? AT : null,
  };
}

registerMock(getIssueCharge, ({ params }) => ({
  data: {
    ...chargeWire(params.chargeId, stored(params.chargeId)),
    orderNumber: "POS-0048",
    tableLabel: "Meja A12",
    original: { name: "Nasi ayam", quantity: 1, lineTotalIdr: 35_000 },
    replacement: { name: "Nasi sapi", quantity: 1, lineTotalIdr: 45_000 },
  },
}));

registerMock(collectIssueChargeAtPos, ({ params, body }) => {
  const entry = stored(params.chargeId);
  // legend-gt98h: QRIS and EDC are real API paths; this mock models cash only.
  if (body.method !== "cash")
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Metode ini belum didukung di mode contoh.",
    );
  if (entry.status === "paid") {
    if (entry.paidKey === body.idempotencyKey)
      return {
        data: {
          charge: chargeWire(params.chargeId, entry),
          changeIdr: body.receivedIdr - 10_000,
        },
      };
    throw new ApiError(409, "CONFLICT", "Tagihan selisih ini sudah lunas.");
  }
  if (body.receivedIdr < 10_000)
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Uang diterima kurang dari tagihan selisih.",
    );
  entry.status = "paid";
  entry.paidKey = body.idempotencyKey;
  if (entry.dropAnswer) {
    entry.dropAnswer = false;
    throw new ApiError(
      504,
      "GATEWAY_TIMEOUT",
      "Server tidak menjawab tepat waktu.",
    );
  }
  return {
    data: {
      charge: chargeWire(params.chargeId, entry),
      changeIdr: body.receivedIdr - 10_000,
    },
  };
});
