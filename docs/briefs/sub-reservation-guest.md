# Sub-brief: halaman tamu kelola reservasi (legend-g12il)

Worktree (semua path relatif ke sini): `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ui-reservation-guest`, cabang `ui/reservation-guest-page`. Jangan commit, jangan jalankan `bd`, jangan ubah `apps/api/**` atau `packages/shared/src/reservation/**` (server dan kontrak tetap). Jangan jalankan tsc/vitest/build/Playwright kecuali brief potonganmu menyebutnya (satu token heavy per thread).

## Mockup (disetujui founder)
`/Users/ifanshori99/Projects/legend super app/legend/.worktrees/design-reservation-guest/design/mockups/reservation-guest/` — `README.md` (16 state + keputusan desain), `<state>-desktop.png` dan `<state>-mobile.png`, `styles.css` (token), `states-*.js` (copy persis tiap state). Baca HANYA PNG state milik potonganmu. Copy diambil dari `states-*.js`.

## Kontrak server (sudah ada, jangan diubah)
- `packages/shared/src/reservation/self-service.ts`: endpoint `getGuestReservation` (GET `/api/public/reservation-link`), `cancelGuestReservation` (POST `/cancel`, body `{reason?}`), `requestGuestReschedule` (POST `/reschedule`, body `{requestedFor, partySize?, note?}`). DTO `GuestReservationView`, `GuestCancelResult {view, depositOutcome, alreadyCancelled}`, `GuestRescheduleResult {view, request}`. Respons dibungkus `{data}`.
- Token di header `X-Reservation-Link-Token` (konstanta `RESERVATION_LINK_TOKEN_HEADER`, 43 char base64url, `reservationLinkTokenSchema`). POST wajib `Idempotency-Key` (8–100 char).
- Link: `${WEB_URL}/reservasi/kelola#<token>` — token di fragment. Halaman tidak boleh menaruh token di path/query/log/teks UI.
- Error: 404 `RESERVATION_LINK_INVALID` (semua tautan salah/kedaluwarsa/dicabut, satu state sama); 429 `RATE_LIMITED` (`Retry-After` tidak terbaca JS cross-origin); 422 `RESERVATION_RESCHEDULE_INVALID` (status tidak bisa, waktu lewat, >180 hari); 409 `RESERVATION_RESCHEDULE_PENDING`; 409 `RESERVATION_TRANSITION_INVALID` (cancel tidak bisa); 409 `RESERVATION_RESCHEDULE_LATE` (saat ini hanya saat staf menyetujui; UI tetap memetakannya). Kode di `packages/shared/src/reservation/errors.ts`.
- Status reservasi: `pending_deposit|confirmed|seated|completed|cancelled|no_show`. `cancellation.preview` = `{resolution: nothing_paid|refund_full|refund_partial|no_refund, refundIdr, forfeitedIdr, policyVersion}` atau null.

## Aturan uang
UI TIDAK menghitung nominal. Semua angka DP dari API: `deposit.paidIdr`, `cancellation.preview.refundIdr/forfeitedIdr`, setelah batal `depositOutcome` atau `view.deposit.refundIdr/forfeitedIdr`. Tidak ada penjumlahan/pengurangan nominal di web.

## Celah kontrak (legend-z5ygw) — dibangun dengan mock, tandai di kode
1. Hasil keputusan: server hanya mengembalikan request `pending`. UI menangani `rescheduleRequest.status` `approved`/`declined` (skema sudah mengizinkan) — mock yang mengirimnya. Komentar `// legend-z5ygw:` di titik pakai.
2. Reschedule terlambat: founder W3 Q13 (14 Nov) — reschedule terlambat DITOLAK; tamu tetap datang di jadwal asli atau batal dengan DP hangus. UI menurunkan state `late` dari data server: `cancellation.preview?.forfeitedIdr > 0` atau `now >= reservedFor`; form reschedule tidak ditawarkan. Respons 409 `RESERVATION_RESCHEDULE_LATE` juga membawa ke state late.

## Pola web
- Fitur baru: `apps/web/src/features/ws08-reservation-guest/` (`api.ts` → `queries.ts` → `hooks.ts`, `lib.ts`, `mock.ts`, `components/`). Pola acuan: `features/ws04-receipt-public/` (halaman publik token + mock `?demo=`), `features/ws08-reservation-customer/` (booking tamu, `lib.ts` punya `formatInstant`, `formatClock`, `instantAt`, `businessDateOfInstant`, `utcOffsetAt` — pakai ulang, jangan duplikasi).
- Panggilan lewat `callEndpoint` (`lib/api/endpoint.ts`). Mock: `registerMock` (`lib/mock/registry.ts`), aktif dengan `VITE_API_MOCK=true`; skenario lewat `?demo=<state>` seperti receipt.
- Teks: tidak ada teks literal di JSX/props tampilan. Pakai `const t = useT()` dan kunci katalog. Namespace sudah terdaftar di `packages/shared/src/i18n/messages/id.ts`: `reservationGuest` (file `reservation-guest.ts`, milik potongan C0), `reservationGuestRequest` (`reservation-guest-request.ts`, C1), `reservationGuestCancel` (`reservation-guest-cancel.ts`, C2). Isi hanya file milikmu.
- Tampilan: permukaan krem/rust seperti QR (`data-surface="qr"` di `styles/tokens.css`), Plus Jakarta Sans sudah dimuat. Token, bukan warna hex. Komponen dari `components/ui` (shadcn). Body 16px mobile, aksi utama ≥ 48 px tinggi, fokus terlihat, status selalu berteks. Satu aksi utama per state. Kolom tunggal maks ~680px (lihat mockup desktop).

## Antarmuka bersama (patuhi nama persis)
`lib.ts` (potongan B):
- `readLinkToken(hash: string): string | null` — buang `#`, validasi `reservationLinkTokenSchema`.
- `type GuestScreen = "detail" | "pending" | "approved" | "rejected" | "late" | "cancelled" | "closed"`; `deriveGuestScreen(view: GuestReservationView, now: Date): GuestScreen`. Urutan: `cancelled` (status cancelled) → `closed` (status seated/completed/no_show) → request pending/approved/declined (`approved`/`rejected`) → `late` (preview.forfeitedIdr > 0 atau now >= reservedFor) → `detail`.
- `type GuestErrorKind = "invalid" | "rate_limited" | "network" | "late" | "pending_exists" | "invalid_input" | "transition" | "unknown"`; `guestErrorKind(error: unknown): GuestErrorKind` (dari `ApiError` status/code; status 0 / NETWORK_ERROR / 5xx = network).
- `type RescheduleProblem = "missing_date" | "missing_time" | "past" | "too_far"`; `validateReschedule(input: {date: string; time: string}, now: Date, timeZone: string): {ok: true; requestedFor: string} | {ok: false; problem: RescheduleProblem}` (maks 180 hari, harus > now; `requestedFor` ISO UTC).
- `rescheduleDateBounds(now: Date, timeZone: string): {min: string; max: string}` (YYYY-MM-DD untuk input date).
- `zoneLabel(timeZone: string): string` (Asia/Jakarta→WIB, Asia/Makassar→WITA, Asia/Jayapura→WIT, lainnya → nama zona).
- `GUEST_DEFAULT_TIME_ZONE = "Asia/Jakarta"`.

`hooks.ts` (potongan B):
- `useLinkToken(): string | null | undefined` — undefined saat SSR/belum mount, lalu baca `window.location.hash`; dengar `hashchange`.
- `useGuestReservation(token: string | null | undefined)` — TanStack `useQuery`, enabled hanya bila token string; `retry` false untuk 404/429.
- `useRequestGuestReschedule(token: string)` dan `useCancelGuestReservation(token: string)` — `useMutation`; Idempotency-Key `crypto.randomUUID()` dibuat per isi formulir dan dipakai ulang saat retry isi yang sama; sukses → `setQueryData` view baru.
- `useGuestTimeZone(outletId: string | undefined): string` — zona outlet dari data publik situs bila tersedia (lihat `publicSiteQuery`), selain itu `GUEST_DEFAULT_TIME_ZONE`.

Komponen bersama (potongan C0, `components/`): `GuestShell({brand, children})` (header titik rust + nama brand + "Kelola reservasi", footer dua catatan), `ReservationSummary({view, timeZone})` (kartu outlet + ubin tanggal + jumlah tamu + DP dibayar), `DepositBreakdown({paidIdr, forfeitedIdr, refundIdr, title?})`, `StatusPill({tone: "success"|"warning"|"neutral", children})`, `GuestNote({tone: "info"|"warning"|"success", title, children})`, `GuestActions({children})` (tumpukan tombol, primer 48px penuh). Halaman: `GuestManagePage` di `components/guest-manage-page.tsx` — mesin state: token → query → `deriveGuestScreen` + state lokal `"main" | "reschedule" | "cancel"`; render layar dari `components/screens/`.

Layar (props persis):
- C1: `screens/detail-screen.tsx` `DetailScreen({view, timeZone, onReschedule, onCancel})`; `screens/reschedule-screen.tsx` `RescheduleScreen({view, timeZone, token, onBack, onSubmitted, onLate})` (state reschedule, validation, submitting); `screens/request-status-screen.tsx` `RequestStatusScreen({view, timeZone, onViewDetail, onRescheduleAgain})` (pending/approved/rejected dari `view.rescheduleRequest.status`).
- C2: `screens/late-screen.tsx` `LateScreen({view, timeZone, onKeep, onCancel})`; `screens/cancel-screen.tsx` `CancelScreen({view, timeZone, token, onBack, onCancelled})` (cancel + cancel-late + submitting; konfirmasi menampilkan rincian DP dari `preview`); `screens/cancelled-screen.tsx` `CancelledScreen({view, timeZone})`; `screens/recovery-screens.tsx` `InvalidLinkScreen()`, `GuestLoadingScreen()`, `GuestLoadErrorScreen({onRetry})`, `GuestRateLimitedScreen({onRetry})`, `ClosedScreen({view, timeZone})`.

Route (C0): `apps/web/src/routes/_public/reservasi_.kelola.tsx` (path `/reservasi/kelola`, tidak bersarang di `reservasi.tsx`), head `noindex`, render `GuestManagePage`. Di `routes/_public.tsx` perlakukan `/reservasi/kelola` sebagai kolom polos seperti `/r/` (tanpa navigasi situs, tidak masuk `WEBSITE_PATHS`). Jangan edit `routeTree.gen.ts` dengan tangan; integrator meregenerasi.

## Potongan
- A transport: izinkan header `X-Reservation-Link-Token` di `apps/web/src/lib/api/endpoint-core.ts` (tipe `CallOptions.headers` + `headersSchema` memakai `reservationLinkTokenSchema`), `lib/api/client.ts` (allow-list penerus header), `lib/mock/registry.ts` + `lib/mock/transport.ts` (MockContext.headers ikut). Komentar allow-list diperbarui. Cari test yang ada untuk endpoint-core di `tests/` dan tambah kasus.
- B data: `features/ws08-reservation-guest/{lib,api,queries,hooks,mock}.ts`. Mock skenario `?demo=` = detail, pending, approved, rejected, late, cancelled, cancelled-late, closed, invalid, error, rate-limit (+ token literal "invalid"... token valid contoh 43 char di komentar). Mock cancel → view cancelled dengan outcome dari preview; reschedule → request pending; reschedule saat late → 409 LATE. Fixture Cafe Legend · Menteng, 18 Nov 2026 19.00 WIB, 4 tamu, DP 50.000, freeUntil 17 Nov 19.00 WIB, preview late refund 25.000/forfeit 25.000 (fixture saja).
- C0 shell+halaman+route: lihat di atas, PNG `detail-*`, `loading-*`.
- C1 layar permintaan: PNG `detail`, `reschedule`, `validation`, `submitting`, `pending`, `approved`, `rejected`. Jam: pakai availability publik bila mudah dipakai dari `features/ws08-reservation-customer` (`useAvailability`), selain itu input `type="time"` step 1800; jangan mengarang slot.
- C2 layar batal/pemulihan: PNG `late`, `cancel`, `cancel-late`, `cancelled`, `cancelled-late`, `invalid`, `loading`, `error`, `rate-limit`.
- T test (test-writer): `tests/reservation-guest-lib.test.mjs` (node:test, `registerWebAlias()` dari `tests/helpers/web-alias.mjs`) untuk semua fungsi `lib.ts` di atas, dan kasus header token di test endpoint-core. Gagal-dulu di base: jalankan `cd <worktree> && LEGEND_TEST_FILES="tests/<file>" heavy pnpm test` SEBELUM B/A selesai, catat merah dan sebabnya.
