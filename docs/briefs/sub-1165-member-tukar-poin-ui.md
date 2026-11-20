# Sub-brief 1165: member tukar poin, alur A (UI saja)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-b80d6906`, cabang `ws/1165-member-tukar-poin-ui`. Kartu `legend-0ne0z`.
Mockup (baca dari path absolut, satu layar per subagent): `/Users/ifanshori99/Projects/legend super app/legend/design/mockups/member-tukar-poin/` → `<state>-390.png`, `<state>-1280.png`, copy di `happy.js` (tagihan-aktif, pilih-poin, qr-aktif) dan `states.js` (lainnya). Alur B (kode tagihan, perbandingan) TIDAK dibangun.
Standar UI: `~/.agents/team/ui-standard.md`. Pola repo: `AGENTS.md`, contoh fitur `apps/web/src/features/ws08-member/` (api/queries/hooks/mock, `components/points-page.tsx`, `components/qr-token-dialog.tsx`, `qr-token.ts`).

Aturan semua slice:
- Jangan sentuh `apps/api/**`. Jangan tulis test backend. Jangan jalankan tsc/vitest/build/Playwright (token heavy dipegang agent induk). Prettier pada file sendiri boleh: `pnpm exec prettier --write <file>`.
- Tidak ada teks UI literal di JSX: semua lewat katalog `t("member.tukarPoin.<...>")` (lihat cara `points-page.tsx` memanggil `t`). Tiap slice menulis berkas katalog SENDIRI (di bawah). Hanya slice E yang mengedit `packages/shared/src/i18n/messages/id.ts`.
- Komponen presentasional (B, C, D) tidak memanggil hooks data; hanya page (E) yang memakai hooks dari A.
- Pakai token/komponen yang sudah ada di area customer (shadcn `components/ui`, kelas tema member yang dipakai `points-page.tsx`). Mockup = tata letak/hierarki; jangan salin CSS mockup mentah. Desktop dua kolom (konteks kiri, panel kanan), mobile satu kolom, konteks dulu.
- Uang: tampilkan `Rp185.000` (format id-ID tanpa spasi), poin `1.240 poin`. Jangan pernah tampilkan QR sebelum token dari server diterima.
- File tidak bertumpuk antar slice. Selesai: lapor daftar file + key katalog baru, 5 baris.

## Kontrak (slice A menulis; B–E coding terhadap bentuk ini)

`packages/shared/src/crm/member-points-redeem.ts` (baru), diekspor seperti endpoint member lain dan didaftarkan di daftar endpoint member `packages/shared/src/crm/endpoints.ts` (~baris 850). Semua aditif.

```ts
export const memberOpenBillSchema = z.strictObject({
  orderId: z.string(),
  outletName: z.string(),            // "Cafe Legend"
  outletArea: z.string().nullable(), // "Kemang"
  billNumber: z.string(),            // "LG-0248"
  tableLabel: z.string().nullable(), // "08"
  totalIdr: z.number().int().nonnegative(),
  paidIdr: z.number().int().nonnegative(),
  remainingIdr: z.number().int().nonnegative(),
  attachedVia: z.enum(["member_qr", "pwa_session"]),
  attachedAt: z.string(),            // ISO
  pointsRedeemed: z.strictObject({ points: z.number().int().positive(), discountIdr: z.number().int().nonnegative(), redeemedAt: z.string() }).nullable(),
});
// GET /api/member/open-bills -> { data: MemberOpenBill[] }   (endpoint: listMemberOpenBills)

export const memberPointsRefusalSchema = z.enum(["program_inactive", "membership_inactive", "bill_settled", "order_not_eligible", "outlet_offline"]);
export const memberPointsQuoteSchema = z.strictObject({
  orderId: z.string(),
  balancePoints: z.number().int().nonnegative(),
  pointValueIdr: z.number().int().positive(),
  minPoints: z.number().int().positive(),   // 1
  maxPoints: z.number().int().nonnegative(), // min(balance, floor(remainingIdr / pointValueIdr)), 0 bila tidak layak
  remainingIdr: z.number().int().nonnegative(),
  refusal: memberPointsRefusalSchema.nullable(),
  quotedAt: z.string(),
});
// GET /api/member/open-bills/:orderId/points-quote -> { data: MemberPointsQuote }   (getMemberPointsQuote)

// Mint QR penukaran: PAKAI endpoint yang sudah ada issueMemberQrToken, body { orderId, points } -> { data: { token, expiresAt } }.
// QR berisi string `token` (opaque, HMAC, sudah mengikat orderId+points; server pos-points.service.ts:219 menolak bila tidak cocok).

export const memberPointsRedeemStatusInputSchema = z.strictObject({ orderId: z.string().min(1).max(64), token: z.string().min(1).max(512) });
export const memberPointsRedeemStatusSchema = z.strictObject({
  orderId: z.string(),
  state: z.enum(["pending", "consumed", "expired", "invalid"]),
  points: z.number().int().positive().nullable(),
  discountIdr: z.number().int().nonnegative().nullable(),
  remainingIdr: z.number().int().nonnegative(),
  balancePoints: z.number().int().nonnegative(),
  checkedAt: z.string(),
});
// POST /api/member/points-redeem/status body {orderId, token} -> { data: MemberPointsRedeemStatus }   (getMemberPointsRedeemStatus)
// POST (bukan GET) supaya token tidak masuk URL/log.
```
Tipe: `MemberOpenBill`, `MemberPointsQuote`, `MemberPointsRefusal`, `MemberPointsRedeemStatus` (z.infer).

## Data web (slice A) — `apps/web/src/features/member-tukar-poin/`

- `api.ts`, `queries.ts` (keys `memberTukarPoinKeys`), `hooks.ts`: `useMemberOpenBills()`, `useMemberPointsQuote(orderId|null)`, `useMintRedeemQr()` (mutation, memanggil issueMemberQrToken dengan {orderId, points}), `useRedeemStatus({orderId, token}|null, {poll: boolean})` (refetch tiap 3 dtk saat poll), `useCheckRedeemStatus()` (mutation sekali periksa).
- `mock.ts` (registerMock, pola `ws08-member/mock.ts`, didaftarkan seperti modul mock lain). Data: member Sari Wulandari, saldo 1.240, Rp100/poin, tagihan `LG-0248`, Cafe Legend Kemang, meja 08, total 185.000, dibayar 0. Status normal: `pending` sampai expiresAt lalu `expired`. Tambah skenario di `apps/web/src/lib/mock/control.ts` `MOCK_SCENARIOS` (aditif, beri komentar legend-0ne0z): `points-consumed` (status `consumed` pada polling pertama; saldo & sisa tagihan ikut berubah), `points-redeemed` (tagihan sudah punya `pointsRedeemed` 500 poin / Rp50.000, sisa 135.000, saldo 740), `points-mint-fail` (open-bills & quote normal, mint gagal 503), `points-multi-bill` (2 tagihan: + `LG-0251` Cafe Legend Senopati meja 03, sisa 92.000). Skenario `empty` = tanpa tagihan; `slow`, `offline`, `error` ikut mekanisme yang ada.
- `view-model.ts` (murni, tanpa React): `formatIdr(n)`, `formatPoints(n)` (pakai formatter repo bila ada), `previewRedeem(quote, rawInput: string)` -> `{ points: number|null, valueIdr, remainingAfterIdr, balanceAfter, error: null | "empty" | "not_integer" | "below_min" | "over_balance" | "over_bill" | "not_eligible" }` (over_balance bila > balancePoints; over_bill bila <= balance tapi > maxPoints). Test unit `apps/web/test/member-tukar-poin-view-model.test.ts` (500 -> Rp50.000/Rp135.000/740; 740 -> saldo 500; 1500 -> over_balance; 0/""/"1,5" -> error; bill kecil -> over_bill). Jangan menjalankan test; induk yang menjalankan.

## Komponen (B, C, D) — `apps/web/src/features/member-tukar-poin/components/`

Slice B membuat `flow-parts.tsx` dengan API ini (C, D, E mengimpor; tulis terhadap API ini walau berkas belum ada):
```tsx
export function FlowGrid(p: { context: ReactNode; panel: ReactNode; busy?: boolean }): JSX.Element
export function Panel(p: { labelledBy?: string; children: ReactNode }): JSX.Element      // kartu paper
export function Eyebrow(p: { children: ReactNode }): JSX.Element
export function Note(p: { tone?: "info" | "warning" | "success"; children: ReactNode }): JSX.Element  // garis kiri, role="status" utk success/warning
export function SummaryBox(p: { children: ReactNode; label?: string }): JSX.Element  // kotak tint
export function SummaryRow(p: { label: ReactNode; value: ReactNode; strong?: boolean }): JSX.Element
export function BigAmount(p: { children: ReactNode; label?: string }): JSX.Element
```
dan `bill-card.tsx`: `BillCard({ bill: MemberOpenBill })` (outlet, area, "Tagihan #LG-0248 · Meja 08", pil "Terhubung", total/sudah dibayar/sisa).

- **B** `flow-parts.tsx`, `bill-card.tsx`, `open-bill-view.tsx`, katalog `packages/shared/src/i18n/messages/member-tukar-poin-bill.ts`:
  - `OpenBillView({ bills, selectedOrderId, quote?, balancePoints?, pointValueIdr?, memberName?, onSelect(orderId), onChoosePoints(), onShowMemberQr(), onRefresh(), refreshing })`: 0 tagihan = `tanpa-tagihan`; >1 tanpa pilihan = daftar pilih (BillCard + tombol "Pilih tagihan ini", jangan pilih otomatis); 1/terpilih = `tagihan-aktif` (quote.refusal != null: tombol nonaktif + alasan).
  - `PointsAfterView({ bill, balancePoints })` = `poin-setelah` (bill.pointsRedeemed != null).
- **C** `points-picker.tsx`, katalog `member-tukar-poin-picker.ts`: `PointsPicker({ bill, quote, initialPoints?, submitting, onSubmit(points:number), onBack() })` = `pilih-poin` + `poin-kurang` (error inline `aria-invalid`, `aria-describedby`, role=alert; rincian & label tombol "Buat QR untuk N poin" mengikuti input; tombol nonaktif saat error/submitting). Pakai `previewRedeem` dari `../view-model`.
- **D** `redeem-qr-panel.tsx`, katalog `member-tukar-poin-qr.ts`: `RedeemQrPanel({ bill, points, quote, view, token, expiresAt, status, onExpired(), onCheckStatus(), checking, onBack(), onDone() })`, `view: "active" | "expired" | "failed" | "consumed"`. active = `qr-aktif` (QR dari `components/ui/qr-code.tsx` berisi `token`, hitung mundur 02:00 pakai helper `features/ws08-member/qr-token.ts`, tick 1 dtk, panggil onExpired saat 0; teks waktu aria-live off, beri label sr); expired = `qr-kedaluwarsa` (QR tidak dirender); failed = `gagal`; consumed = `sudah-dipakai` (angka dari `status`). Mobile: disclosure "Rincian tagihan dan poin" seperti mockup qr-aktif-390. Hormati reduced motion.

## Page (E)

`apps/web/src/routes/_customer/member.tukar-poin.tsx` (pola `member.poin.tsx`: loader preload, head `t("member.page.tukarPoin")`), `components/tukar-poin-page.tsx`, katalog `member-tukar-poin-page.ts`, impor keempat katalog (`memberTukarPoinBillMessages`, `...PickerMessages`, `...QrMessages`, `...PageMessages`) di `messages/id.ts`. Tambah tautan "Tukar poin di kasir" di `ws08-member/components/points-page.tsx` ke `/member/tukar-poin`.
- Header: "‹ Kembali ke poin" (ke /member/poin), h1 "Tukar poin di kasir", subjudul.
- Mesin keadaan lokal: `bill` → `pick` → `qr`. Loading (`loading`), offline (`navigator.onLine` false atau ApiError jaringan → `offline`, QR disembunyikan), error baca → keadaan gagal baca dengan "Coba lagi". Mint gagal/timeout → `failed` (QR tidak tampil; "Periksa status penukaran" → cek status/refetch tagihan dan quote). Timer habis → `expired` → "Periksa status" → status consumed ⇒ consumed, else kembali ke `bill` dengan quote baru. Status poll `consumed` ⇒ `consumed`; "Kembali ke poin saya" → /member/poin. Tagihan dengan `pointsRedeemed` ⇒ `PointsAfterView` (tidak bisa tukar lagi di tagihan itu).
- "Tampilkan QR member" membuka `QrTokenDialog` (identitas, body kosong) yang sudah ada.
- Fokus pindah ke judul panel saat ganti langkah; transisi pakai pola view-transition repo bila ada, fallback statis.

## Screenshot (slice F) — `scripts/shot-1165.mjs`

Template: `scripts/shot-1082.mjs` (spawn dev server sendiri, PORT 3316, env sama: `VITE_API_MOCK=true` dst) dan cookie role `legend-mock-role` (cari nilai untuk member/customer di `apps/web/src/lib/areas/access.ts`). Konteks browser baru per keadaan (mock reset tiap load). Viewport 390x844 dan 1280x900, fullPage. Simpan `docs/review/img/member-tukar-poin-<state>-<390|1280>.png` untuk state: `tagihan-aktif` (normal), `pilih-poin` (klik "Pilih jumlah poin", isi 500), `pilih-poin-740` (isi 740: sisa saldo 500), `poin-kurang` (isi 1500), `qr-aktif` (buat QR 500; `page.clock.install()` sebelum goto supaya 02:00 beku), `qr-kedaluwarsa` (clock maju 121 dtk), `gagal` (`?mock=points-mint-fail`), `sudah-dipakai` (`?mock=points-consumed`, buat QR, tunggu status), `poin-setelah` (`?mock=points-redeemed`), `tanpa-tagihan` (`?mock=empty`), `qr-member` (tanpa-tagihan → "Tampilkan QR member"), `pilih-tagihan` (`?mock=points-multi-bill`), `loading` (`?mock=slow`, ambil sebelum data datang), `offline` (`?mock=offline` atau `context.setOffline(true)` setelah load). Pilih elemen lewat role/teks katalog (baca `packages/shared/src/i18n/messages/member-tukar-poin-*.ts` setelah ada). Laporkan console error/overflow horizontal per state ke stdout; exit non-zero bila ada state gagal. JANGAN menjalankan skrip (induk menjalankan lewat `heavy --browser`).

## Ronde perbaikan review (R1)

- **R1-page** `components/tukar-poin-page.tsx`:
  (a) Kembali dari QR aktif TIDAK boleh membuang token hidup: simpan token terakhir sebagai `outstanding` dan terus poll statusnya sampai expired/consumed/invalid; bila consumed → view consumed. Selama `outstanding` masih hidup, picker tidak boleh mint QR baru (tombol nonaktif + Note "QR sebelumnya masih berlaku sampai mm:ss" — tambah key di `member-tukar-poin-page.ts`, kirim lewat prop baru opsional `blockedReason?: ReactNode` ke PointsPicker; R1-panel menambah prop itu). Aturan uang: pilih yang membatasi.
  (b) Refetch quote setiap masuk langkah `pick`.
  (c) Status server `invalid` → view `failed`, bukan expired.
  (d) Gagal baca overview tidak memblokir alur; saldo dari quote dulu.
  (e) `PointsAfterView balancePoints`: pakai quote/status, jangan fallback 0/overview basi; tampilkan skeleton bila belum ada.
  (f) >1 tagihan: setelah memilih, ada tombol "Pilih tagihan lain" kembali ke daftar.
- **R1-vm** `view-model.ts` + test: cap = `min(quote.maxPoints, quote.balancePoints, floor(quote.remainingIdr / quote.pointValueIdr))`; `remainingAfterIdr` tidak pernah negatif; test maxPoints menggelembung dan quote basi.
- **R1-panel** `components/redeem-qr-panel.tsx`: breakpoint sembunyi/tampil konteks `lg:` → `md:` (cocok `FlowGrid` md); hilangkan teks ganda di SummaryBox consumed (label vs `<p>`). Plus `components/points-picker.tsx`: prop opsional `blockedReason?: ReactNode` → render Note warning di atas tombol dan nonaktifkan submit.
- **R1-mock** `features/member-tukar-poin/mock.ts` + `features/ws08-member/mock.ts`: saldo overview member ikut store penukaran (consumed/redeemed → 740 untuk 500 poin).

## Ronde R2 (review kedua) — `components/tukar-poin-page.tsx` + `components/redeem-qr-panel.tsx` (+ `hooks.ts` bila perlu)

1. (medium) Poll mendeteksi `consumed` → invalidasi `memberKeys.all` + kunci tukar-poin di titik transisi (bukan bergantung pada effect `useRedeemStatus` yang datanya hilang setelah `setOutstanding(null)`).
2. Mint sukses terlambat (setelah timeout 15 dtk): token tetap dicatat sebagai `outstanding` (memblokir mint baru, terus di-poll); view tetap `failed` sampai member memeriksa status; bila status `pending`, QR boleh ditampilkan lagi dengan sisa waktunya.
3. Selama `outstanding` dan langkah bukan `qr`: Note blockedReason punya tombol "Periksa status" yang memanggil pemeriksaan status token (bukan hanya di langkah qr).
4. `verify()` mendapat `expired` saat timer lokal belum habis → pindah ke view expired.
5. `redeem-qr-panel.tsx:124` clamp `Math.max(0, quote.remainingIdr - discountIdr)`.
Teks baru lewat katalog `member-tukar-poin-page.ts`. Jangan jalankan tsc/test; prettier + eslint file sendiri.

## Ronde R3 (ui-auditor). Prettier + eslint file sendiri, tanpa tsc/test.

- **R3-page** (`tukar-poin-page.tsx`, `status-view.tsx`, `member-tukar-poin-page.ts`):
  1. Fokus: `viewKey` ikut varian render (loading/offline/error/picker/qr/...) supaya fokus pindah ke judul tiap kali view berganti (termasuk loading → picker, qr → offline).
  2. Mint menggantung setelah timeout 15 dtk: beri jalan keluar (tombol "Coba lagi" / "Periksa status" yang me-reset `mintInFlight` sesudah timeout, guard double-mint tetap: mint baru hanya bila token lama tidak diketahui ada — bila ragu, minta periksa status dulu).
  3. Countdown di blockedReason: jangan di live region; teks waktu `aria-hidden` (atau `role="timer" aria-live="off"`), kalimat statis untuk pembaca layar.
  4. `errorNote` "Poin belum digunakan." hanya bila tidak ada `outstanding`; bila ada → "Status poin belum bisa dipastikan." (key baru).
  5. `checkFailed`: tampilkan sebagai Note di dekat tombol pemicunya (lewat prop ke panel/StatusView), bukan di bawah grid.
  6. "..." → "…" di katalog page.
- **R3-picker** (`points-picker.tsx`, `member-tukar-poin-picker.ts`):
  1. Mobile (<md): panel dulu; konteks penuh `hidden md:block`; di mobile tampil baris tagihan ringkas + `<details>` "Rincian tagihan dan poin" (pola sama `redeem-qr-panel.tsx` ActiveQr/CompactBill — salin, jangan impor dari panel).
  2. Validasi `touched` saat blur/submit, bukan onChange; jangan tampilkan error `<p>` dan `limitNote` bersamaan.
  3. Error dan field hint `text-base` (16 px).
  4. "..." → "…".
- **R3-panel** (`redeem-qr-panel.tsx`, `member-tukar-poin-qr.ts`, `open-bill-view.tsx`, `member-tukar-poin-bill.ts`):
  1. Tombol back di QR aktif berlabel "Ubah jumlah poin" (key baru; page tetap memanggil onBack → picker).
  2. `open-bill-view.tsx` ~453: `<p>` kosong dirender kondisional.
  3. Consumed: bila `status.points`/`discountIdr` null → teks netral tanpa "tepat N poin"; hapus `??` mati pada field wajib.
  4. `chooseHint` "Kamu" → "Anda".
