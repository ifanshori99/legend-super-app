# Sub-brief: payslip PIN UI + remainingAttempts (legend-ilzrj)

Worktree: `.worktrees/payslip-pin-ui` (branch `ws/payslip-pin-ui`). Run everything from this worktree. Base: `ws/hris-pii-pin` (payslip PIN BE: lockout, HR reset, OTP port).
Mockups (approved): `design/mockups/payslip-pin/` — README + `<layar>-mobile.png` / `<layar>-desktop.png`. Read only the PNGs of your screen.
UI rules: `~/.agents/team/ui-standard.md`. Copy in Bahasa Indonesia.

## Founder decisions

- Employee creates own PIN (6 digits). HR only resets (never sees/sets PIN).
- Forgot PIN text: "Hubungi HR atau atasan di outlet" — no phone number.
- WhatsApp OTP reset flow is built; adapter by other thread. API 503 => clear "belum tersedia" state. 429 => "kode dibatasi" state (retry later).
- Payslip amounts hidden until correct PIN.

## Slice BE (implementer BE)

- 403 `PAYSLIP_PIN_INVALID` response body adds `remainingAttempts: number` (attempts left before lock).
- 423 (locked) response body adds `lockedUntil: string` (ISO datetime).
- Contract/schema in `packages/shared` (zod + types). Fail-first API test first, then implementation.

## Slice Web

- Screens: buat-pin, pin-tersimpan, buka-slip, pin-salah (remainingAttempts), terkunci (lockedUntil), lupa-pin, ubah-pin, kode WhatsApp (request/verify incl. 429/503), daftar slip kosong/memuat/error; HR: tombol reset PIN + dialog konfirmasi + alasan 3–500 char.
- All data through the existing typed API client layer; components don't know data is mock.
- Each screen: loading, empty, error, success; 390 and 1280.
- Pure logic (state machine / error mapping) in a separate module with unit tests (fail-first).

## Rules

- Do not run `pnpm check`. Heavy commands (tsc, build, playwright) via `heavy`. Targeted tests: `LEGEND_TEST_FILES="<file>" pnpm test` or package vitest on single file.
- Do not touch files owned by another slice (see ownership list below, filled by ui-engineer).

## Contract decision (BE ↔ web)

- REVISED (details is an array of {field,message}; keep it): new optional siblings of `code`/`message` in the error envelope.
- 403 `PAYSLIP_PIN_INVALID` → `error.remainingAttempts: number`.
- 423 `PAYSLIP_PIN_LOCKED` → `error.lockedUntil: ISO string`.
- BE implementer adds both optional fields to `apiErrorBodySchema` (`packages/shared/src/core/errors.ts`) and `ApiErrorBody` (`packages/shared/src/types/api.ts`).
- F1 adds optional `remainingAttempts` / `lockedUntil` to web `ApiError` (`apps/web/src/lib/api/errors.ts`) and wherever web builds ApiError from the body (endpoint-core/client, mock runtime), backwards compatible.
- Same codes from PUT `/me/payslip-pin` (wrong currentPin) and OTP verify. Constants: 5 attempts, 15-min lock, OTP 6 digits/5 min TTL, 3 OTP requests/hour (429 `RATE_LIMITED`), 503 `SERVICE_UNAVAILABLE` when WhatsApp not ready, 409 `PAYSLIP_PIN_NOT_SET`.
- Web reads `ApiError.remainingAttempts` / `ApiError.lockedUntil` (`apps/web/src/lib/api/errors.ts`). Endpoints in `@starter/shared/hris/payroll` (`packages/shared/src/hris/payroll/endpoints.ts`), call via `callEndpoint` (`apps/web/src/lib/api/endpoint.ts`).

## Pure logic module: `apps/web/src/features/ws10-payslip/pin-state.ts`

No React, no framework imports, no TS-only runtime syntax (loaded by node type stripping in `tests/`). Exports:

- `PAYSLIP_PIN_LENGTH = 6`, `PAYSLIP_PIN_MAX_ATTEMPTS = 5`.
- `sanitizePinInput(raw: string): string` — keep digits only, max 6.
- `isCompletePin(pin: string): boolean` — exactly 6 digits.
- `validateNewPin(pin, confirm): { ok: true } | { ok: false; reason: "incomplete" | "mismatch" | "weak" }` — weak = all same digit (111111) or straight sequence ascending/descending (123456, 654321). Order: incomplete, weak, mismatch.
- `classifyPinError(err: unknown): PinErrorState` where `PinErrorState =`
  `{ kind: "invalid"; remainingAttempts: number | null }` (403 PAYSLIP_PIN_INVALID; null if field missing/invalid)
  `| { kind: "locked"; lockedUntil: string | null }` (423)
  `| { kind: "not_set" }` (409 PAYSLIP_PIN_NOT_SET)
  `| { kind: "rate_limited" }` (429)
  `| { kind: "unavailable" }` (503)
  `| { kind: "not_found" }` (404)
  `| { kind: "network" }` (non-ApiError / status 0)
  `| { kind: "unknown" }`.
  Works on any object with `status`, `code`, `remainingAttempts`, `lockedUntil` (duck-typed, so tests can pass plain ApiError).
- `minutesUntil(lockedUntil: string | null, now: Date): number | null` — ceil minutes, min 0; null on null/invalid.
- `pinStatusView(status: { status: "not_set" | "active" | "locked"; lockedUntil: string | null }, now: Date): "create" | "enter" | "locked"` — locked with lockedUntil in the past → "enter".
  Old `PAYSLIP_PIN_MAX_ATTEMPTS = 3` / `pinErrorKind` in `state.ts` must be replaced by this module (update imports).

## File ownership (no overlap)

- F1 implementer: `features/ws10-payslip/pin-state.ts`, `pin-api.ts`, `pin-queries.ts`, `pin-hooks.ts`, `mock.ts`, `state.ts`, `api.ts`, `hooks.ts`, `queries.ts` (feature `ws10-payslip`), plus HR reset api/hook in `features/ws10-employee-master/pin-reset-api.ts` + `pin-reset-hooks.ts` and its mock in that feature's mock file.
- F2 implementer: `packages/shared/src/i18n/messages/ws10-payslip-pin.ts` (+ one import line in `id.ts`), `features/ws10-payslip/components/pin-code-input.tsx`, `features/ws10-payslip/components/pin-layout.tsx`.
- test-writer: `tests/payslip-pin-ui.test.mjs`.
- Wave 2 (screens) gets ownership after wave 1.

- OTP verify: a wrong/expired/used code answers 403 `PAYSLIP_PIN_INVALID` (same code, no separate OTP code) → `kind: "invalid"`; the OTP screen words it as wrong code. No `otp_invalid` kind.

## Wave 2: screens (one implementer each; read only your mockup PNGs, mobile + desktop)

Common: use F1 hooks (`features/ws10-payslip/pin-hooks.ts`), `pin-state.ts`, F2 `pin-code-input.tsx` + `pin-layout.tsx`, copy keys `payslipPin.*` (add missing keys ONLY in a new file `packages/shared/src/i18n/messages/ws10-payslip-pin-<slice>.ts` + one import line in `id.ts`; report it). Each screen: loading skeleton, error w/ retry, success; 390 + 1280. Do NOT edit `routeTree.gen.ts` (ui-engineer regenerates). Never show amounts before PIN ok. Don't commit.

- S1 setup: `components/pin-setup.tsx` (mockups `buat-pin`, `pin-tersimpan`). Props: `onDone()`. Create = enter + repeat, validateNewPin errors near field.
- S2 gate: `components/payslip-detail.tsx` (mockups `buka-slip`, `pin-salah`, `terkunci`). Read PIN status first: not_set → `<PinSetup>` then gate; locked → terkunci (minutes left, "Lupa PIN?" link); invalid → error near input "PIN salah. Sisa N percobaan" (null → no number). Links: Lupa PIN → `/karyawan/slip-gaji/lupa-pin`.
- S3 forgot: `components/pin-forgot.tsx` + route `routes/_karyawan/karyawan.slip-gaji.lupa-pin.tsx` (mockups `lupa-pin`, `kode-dibatasi`). Text "Hubungi HR atau atasan di outlet" (no number). WhatsApp: button "Kirim kode WhatsApp" → 503 "belum tersedia" state (clear, not an error toast); 429 kode-dibatasi; success → enter code + new PIN + repeat → verify → pin-tersimpan.
- S4 change: `components/pin-change.tsx` + route `routes/_karyawan/karyawan.slip-gaji.ubah-pin.tsx` (mockup `ubah-pin`). Current PIN, new, repeat. Wrong current → invalid w/ remaining; locked → terkunci copy.
- S5 list: `components/payslip-history.tsx` (mockups `kosong`, `memuat`, `error`) + entry link "Ubah PIN slip gaji" to `/karyawan/slip-gaji/ubah-pin` (only when status active).
- S6 HR: `features/ws10-employee-master/components/payslip-pin-reset-dialog.tsx` + mount button in `employee-profile-page.tsx` (mockup `hr-reset`). Visible only with `payroll.run`; confirm dialog, reason 3–500 chars with counter, success toast "PIN direset; karyawan membuat PIN baru". HR never sees/sets PIN.
  Route guards: copy `selfServiceGuard(["self.payslip.view"])` + head pattern from `routes/_karyawan/karyawan.slip-gaji.$payslipId.tsx`.

## Mock facts (from F1)

- Mock mode `VITE_API_MOCK=true`. Demo PIN `123456` (`DEMO_PAYSLIP_PIN`), 5 attempts → 423 with lockedUntil.
- OTP request/verify default 503. `?mock=otp-ok` → request ok, code `482916` (`DEMO_PAYSLIP_OTP`). `?mock=otp-rate-limited` → 429. Shared scenarios `?mock=empty|error|offline`.

## Wave 3

- E2E (test-writer): `e2e/payslip-pin.mock.spec.ts`, pattern of `e2e/legend-10n.mock.spec.ts`, run `heavy pnpm test:e2e:mock e2e/payslip-pin.mock.spec.ts` once at the end. Flows: open slip wrong PIN shows remaining → right PIN shows amounts (hidden before); lock after 5; forgot PIN 503 state; otp-ok flow; HR reset dialog with reason validation.
- UI check (implementer): `scripts/ui-check.mjs` — Playwright + `@axe-core/playwright` (check installed; if not, report, don't add deps without saying), for each screen URL+state at 390x844 and 1280x800: axe tags wcag2a wcag2aa wcag21aa wcag22aa, fail on serious/critical; save screenshot to `design/screenshots/payslip-pin/<screen>-<390|1280>.png`. Base URL from env `UI_CHECK_URL`. Screens list in a const at top (URLs: `/karyawan/slip-gaji`, `/karyawan/slip-gaji/<id>`, `/karyawan/slip-gaji/lupa-pin`, `/karyawan/slip-gaji/ubah-pin`, `/kelola/karyawan/<id>`; states driven by `?mock=` and scripted PIN entry).

## Fix round 1 (review + ui-auditor). Each owner fixes only own files; prettier clean; no tsc.

Decisions: PIN fields stay `type=password` but `autoComplete="off"` everywhere + `name` attr; OTP field unmasked (`mask={false}`: type text, inputMode numeric, autoComplete one-time-code). Submit buttons stay enabled; validate on submit (pin-setup pattern). After a failed submit, refocus the first errored input. `autoFocus` only when `matchMedia("(pointer: fine)")`. Every mutation that held a PIN/code calls `.reset()` once its success screen is shown (or in onSuccess). Lupa PIN keeps "tap then 503 notice" (founder: show belum tersedia when API 503) but the button must be retryable (not disabled forever). Wrong PIN clears the field (security) — deliberate vs mockup.

- F2: pin-code-input — fluid boxes (wrapper `flex w-full max-w-[19rem]`, boxes `min-w-0 flex-1 max-w-11`, drop min-w-11; fits 320px); `mask?: boolean` (default true); pass through `name`. pin-layout — remove unused `variant="hr"`; delete unused keys (hr*, hrReset.submitting, hrReset.side, kodeWa.invalid, lupaPin.whatsappNotice, list.changePinHint if in your file); `memuat.side` → "Memuat daftar slip gaji Anda."
- S2 payslip-detail: move lock view to new `components/pin-locked.tsx` exporting `PinLocked({ lockedUntil: string | null; onUnlocked?: () => void })` (danger notice w/ left rule, minutes ticking every 30s, Lupa PIN link, "Kembali ke daftar slip" button); period card above PIN from cached `useMyPayslips` data (find by id; omit card if not found); `notFound` derived per payslipId (not sticky); enabled submit; refocus; autofocus gate; name.
- S4 pin-change: use `PinLocked` from components/pin-locked.tsx (S2 creates it) for any lock; reset mutation after success; enabled submit; refocus; autocomplete off; name.
- S3 pin-forgot: reset mutations after done; 503 notice keeps button retryable; resend 503 → same belum-tersedia notice; 429 during code step shows notice INSIDE code step (code field stays usable), disable resend after 3 sends this session; OTP input `mask={false}`; refocus; enabled submit; autocomplete off on PIN fields; codeInvalid copy append " Kirim kode baru jika perlu."; name.
- S1 pin-setup: reset mutation once tersimpan shown (keep card visible via local state); autofocus gate; name.
- S5 payslip-history: loading skeleton in the loaded list's shape (back link, header, info card, 3 card skeletons) — no layout jump; drop hardcoded "Dibayar" badge; row link aria-label "Lihat slip {period}"; empty/error buttons size lg.
- S6 reset dialog: new idempotency key when reason changes or after a failure; block close (Batal disabled + onOpenChange ignored) while pending; focus textarea on validation error; counter linked via aria-describedby and no negative margin hack if avoidable.
- F1: pin-hooks header comment accurate (gcTime 0 evicts after unmount only; screens call reset()); mock OTP: 5th wrong code burns the challenge and answers 423 with lockedUntil = challenge expiry WITHOUT locking the PIN (match API).
