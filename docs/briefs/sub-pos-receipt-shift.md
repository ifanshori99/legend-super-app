# Sub-brief: receipt tests after merging pos-shift (merge train m1)

Worktree `.worktrees/prep-pos-receipt`, branch `prep/pos-receipt`. Do NOT regenerate migrations, do NOT touch `apps/api/drizzle/`. Never read `.env*`, never pkill. Don't commit.

Failure: 39 tests fail with `SHIFT_NOT_OPEN` (log: /private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app/08f54ec9-05a9-40d0-adde-05da14953610/scratchpad/prep-test.log).
Cause: `lockCashierShiftForCash` (`apps/api/src/services/pos-cash-guard.ts:79`) — a cash tender needs a verified device (device token, tenant source "device") AND the paying cashier's open shift on that device.

Decision (lead): this rule is final (pos-shift, m1). Do NOT change service code. Cash sales over HTTP therefore always carry a device, so their receipt takes the DEVICE sequence (first device of an outlet gets prefix `P1` from `ensureSequence` in the cloud) — no longer `C`. The cloud sequence `C` stays for sales without a device and is covered only by service-level tests (`allocateReceipt` with `deviceId: null`); keep those as they are. Gap: no HTTP test runs a device-less (non-cash) sale through the order port to `C`; follow-up bead.

How to set up (copy patterns, don't import across test files):

- Device token + Host: `apps/api/src/test/pos-receipt-kfix.test.ts` (~lines 180-220: `signDeviceToken`, `DEVICE_TOKEN_HEADER`, `Host`), and `apps/api/src/test/pos-shift.test.ts` (`deviceHeader` ~161, request helper ~171-179, `openShift` ~355).
- Open the shift for the SAME user that pays the tender, on the same device and outlet, before the cash tender. One device + one open shift per outlet is enough; a helper that lazily opens it per outlet is fine.
- Keep each test's intent. Update number/prefix assertions `C-...` → the device prefix (`P1-...`) only for HTTP cash sales; update sequence assertions (prefix, device_id = the device id instead of the outlet id) accordingly. Do not weaken assertions.
  Run: `LEGEND_TEST_FILES="src/test/<your file>" heavy pnpm test` from worktree root (heavy queues itself; don't wait on other processes).

## A — `apps/api/src/test/pos-receipt.test.ts` only

37 failures (all HTTP cash sales via `paidOrder` ~line 262 and the tenders at ~2864, ~2931). Make `paidOrder`/`api` send the device token and open the cashier's shift first.

## B — `apps/api/src/test/pos-receipt-kfix.test.ts` only

2 failures, F1 HTTP tests:

- "a sale finished over HTTP without a device token" → now a cash tender without a device is refused with `SHIFT_NOT_OPEN`, and no receipt number/sequence is consumed (gapless). Rewrite to assert that.
- "a sale finished over HTTP with a valid device token" → open the cashier's shift on that device first; then the receipt stores the device id and takes prefix `P1`.

## Merge resolution note (lead)

`pos-order.routes.ts` takes m1's shared `deviceIdOf` (`routes/device-id.ts`, also used by pos-shift and device-pin routes) instead of pos-receipt's local `verifiedDeviceId`. Both verify the signed token and the tenant; the local one also demanded `tenant.source === "device"`, so a token sent with the tenant Host gave a null device on orders but not on shifts, and pos-shift's cash tests failed with `SHIFT_NOT_OPEN`. One helper keeps order and shift on the same device.
