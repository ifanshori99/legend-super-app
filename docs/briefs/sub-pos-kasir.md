# Brief subagent — POS kasir UI (legend-mjmm)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-kasir-ui`, cabang `ui/pos-kasir`. Jangan pindah cabang, jangan commit, jangan push. Jangan jalankan dev server, `pnpm build`, atau Playwright (agent induk yang menjalankan). Boleh: `pnpm --filter @starter/web typecheck`, `pnpm --filter @starter/web lint` (atau eslint pada file sendiri), `pnpm format` pada file sendiri.

## Sumber wajib dibaca

- Mockup: `design/mockups/pos/<layar>.png` (baca HANYA gambar layarmu) + sumber HTML-nya (`payment.html`, `edc.html`, `cashier-code.html`, `shift.html`, `supervisor.html`) untuk copy persis. Keputusan founder di `design/mockups/pos/README.md` bagian akhir: DP lebih dari tagihan jadi saldo pelanggan; blind count wajib per pecahan; tutup hari oleh manajer outlet, batas hari usaha 04.00.
- Aturan: `DESIGN.md` (density `kontras`: target 60 px, body 18 px, `rounded-control`, satu tombol `default`/petrol per layar, tab dan pilihan dipilih dengan ink bukan aksen, status = ikon + teks), `docs/frontend.md`, `~/.agents/team/ui-standard.md`.
- Pola data: `apps/web/src/features/ws05-payment/` (api → queries → hooks, `mock.ts` dengan `registerMock`), `apps/web/src/lib/mock/registry.ts`, `apps/web/src/lib/api/endpoint.ts`.

## Aturan keras

- Komponen hanya memakai hook dari `features/ws04-pos-kasir/hooks.ts`. Tidak ada `apiFetch`/`useQuery` langsung di komponen. Komponen tidak tahu data mock.
- Teks UI lewat `useT()` (`apps/web/src/components/i18n.tsx`) dan katalog di `packages/shared/src/i18n/messages/pos-kasir-*.ts`. Tiap subagent hanya menulis file katalog miliknya.
- Uang: `<Money>` dari `@/components/ui/money` (`size="stat"` / `"hero"` untuk angka besar). Semua angka, waktu, kode: kelas `tabular`.
- Tanpa warna mentah (hex, rgb, oklch, kelas palet Tailwind seperti `bg-white`/`text-red-500`): pakai token (`bg-primary`, `text-muted-foreground`, `bg-muted`, token status yang ada di `apps/web/src/styles/globals.css`). Dicek `node scripts/ci/color.mjs`.
- Tanpa cabang logika pada id/nama/domain tenant (dicek `node scripts/ci/tenant-hardcode.mjs`). Nama outlet/terminal dari `useTenantContext()` atau data.
- Komponen yang ada dipakai ulang: `components/ui/*` (button, badge, dialog, sheet, input, form-field, tabs, segmented-control, status-band, feedback-state, skeleton, money, table), `features/ws01-device-pin/components/pin-pad.tsx`. Jangan fork; tambah varian bila perlu.
- Tiap layar: loading (skeleton sesuai bentuk), kosong, error (apa yang salah + cara pulih), sukses. `?mock=empty` / `?mock=error` harus menghasilkan kondisi itu.
- Persetujuan supervisor menghasilkan `overrideId` (dari endpoint `createPosOverride` di `@starter/shared/access/override` atau setara), BUKAN `approvalRequestId`. Body void/refund/diskon memakai `overrideId`.
- Shell: route `_ops/pos*` sudah dibungkus `OperationsShell` (header: outlet, terminal, status koneksi, kasir, jam). Jangan buat header kedua. Isi layar = judul halaman + subjudul + tombol kembali di kanan, lalu konten (lihat mockup).
- Ukuran utama 1280×800 landscape. Juga harus utuh di 390 px (kolom menumpuk, tanpa scroll horizontal).
- Dialog: komponen `dialog`/`sheet` shadcn yang ada. Fokus terlihat, semua bisa keyboard. Status pembayaran yang berubah diumumkan `aria-live="polite"`.

## Struktur

Feature: `apps/web/src/features/ws04-pos-kasir/`.

### Konstanta demo (dipakai mock, e2e, screenshot)

- `DEMO_ORDER_ID = "0b0b0048-0000-4000-8000-000000000048"` (Meja A12, POS–0048, 6 item, 2 tamu, subtotal 220.000, service 8.000, pajak 20.000, total 248.000, DP RSV–0018 100.000 lunas).
- `DEMO_CODE_ORDER_ID = "0b0b0044-0000-4000-8000-000000000044"` (kode LG–0044, Meja A01, 1 Espresso dingin, Rp26.600).
- `DEMO_SHIFT_ID = "0c0c0001-0000-4000-8000-000000000001"` (Kasir 01, modal 500.000; hitungan fisik 2.230.000, sistem 2.250.000 → kurang 20.000).
- Seed demo lewat query `?demo=<seed>`, dibaca HANYA oleh modul mock (bukan komponen) saat `VITE_API_MOCK=true`:
  - Bayar `/pos/bayar/$orderId`: `baru` (default), `split` (QRIS 100.000 terkonfirmasi 14.31, sisa 48.000), `qris-aktif`, `qris-kedaluwarsa`, `gagal`, `va`, `edc-menunggu`, `edc-tidak-pasti`, `edc-berhasil`, `lunas` (DP+QRIS+tunai 48.000, diterima 50.000, kembalian 2.000, struk POS01–000048).
  - Shift: `/pos/shift` tanpa seed = belum ada shift (tampil form buka); `?demo=shift-aktif` = shift aktif dengan riwayat kas.
  - Tutup hari `/pos/tutup-hari`: default terbuka; `?demo=hari-ditutup` = sudah ditutup.
- Status pembayaran gateway/EDC di mock: QRIS/VA menunggu sampai tombol "Cek status pembayaran" ditekan; mock lalu mengembalikan terkonfirmasi (atau gagal untuk seed `gagal`). EDC menunggu → berhasil setelah ±3 detik (seed `edc-tidak-pasti` → status belum pasti sampai "Cek status").

### Rute (file di `apps/web/src/routes/_ops/`)

| Rute                             | File                                | Mockup                                                     |
| -------------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| `/pos/bayar/$orderId`            | `pos.bayar.$orderId.tsx`            | payment-_, edc-_                                           |
| `/pos/kode`                      | `pos.kode.tsx`                      | cashier-code-found, cashier-code-invalid                   |
| `/pos/shift`                     | `pos.shift.index.tsx`               | shift-open (bila belum ada shift), shift-active            |
| `/pos/shift/tutup`               | `pos.shift.tutup.tsx`               | shift-blind (+ kondisi sesudah kirim: menunggu supervisor) |
| `/pos/supervisor/shift/$shiftId` | `pos.supervisor.shift.$shiftId.tsx` | supervisor-approval                                        |
| `/pos/tutup-hari`                | `pos.tutup-hari.tsx`                | supervisor-day-close, supervisor-day-closed                |

Guard rute: pola `evaluateGuard` seperti `routes/_ops/pos.reservasi.tsx` (izin `pos.sale.create` untuk kasir; supervisor/tutup hari: izin persetujuan/tutup hari yang ada di `packages/shared/src/permissions.ts`, cari yang paling cocok).

### Panel pembayaran

`components/payment/panel-types.ts` mengekspor:

```ts
export type PaymentPanelProps = {
  orderId: string;
  /** Nominal yang sedang dialokasikan ke metode ini (rupiah utuh). */
  amountIdr: number;
  /** Kembali ke pilihan metode. */
  onChangeMethod: () => void;
};
```

File panel (masing-masing satu pemilik): `method-grid.tsx`, `split-panel.tsx`, `cash-panel.tsx`, `success-panel.tsx` (P1); `qris-panel.tsx`, `va-panel.tsx`, `ewallet-panel.tsx`, `card-online-panel.tsx`, `failed-panel.tsx` (P2); `edc-panel.tsx` + `edc-*.tsx` (P3). Panel yang mana yang tampil ditentukan `payment-screen.tsx` (P1) dari status sesi pembayaran (hook), bukan dari dugaan kasir.

### Daftar metode

Metode aktif diambil dari data (hook), bukan hardcode enam metode di komponen. Mock mengembalikan enam: QRIS, Virtual Account, E-wallet, Kartu kredit/debit (online), Tunai, EDC.

## Kontrak yang belum ada (pakai tipe lokal + mock, tandai `// DEMO-CONTRACT:` dan catat di `features/ws04-pos-kasir/CONTRACT-GAPS.md`)

EDC: status terminal/ECR, kirim nominal, cek status, catat standalone (referensi bank + PIN supervisor + tanda rekonsiliasi). VA: daftar bank + nomor + batas waktu. E-wallet: daftar dompet + status. Kartu online. Lookup kode "Bayar di kasir" per outlet. DP reservasi teralokasi ke tagihan (+ sisa DP jadi saldo pelanggan). Rencana split/sisa tagihan. Tutup hari: settlement per bank, antrean akuntansi, standalone belum cocok. `closePosShiftInputSchema` masih `approvalRequestId` (perlu `overrideId`).

Saat tidak mode mock dan kontrak belum ada: hook mengembalikan error `CONTRACT_PENDING`; layar menampilkan kondisi error yang jelas ("Fitur ini belum tersambung ke server"), bukan data palsu.

---

# Tugas per subagent

## Gelombang 1

### A — Lapisan data (implementer)

Milik: `features/ws04-pos-kasir/{types.ts,api.ts,queries.ts,hooks.ts,mock.ts,mock-engine.ts,fixtures.ts,demo-seed.ts,CONTRACT-GAPS.md,index.ts}`.

- Endpoint yang ada di `@starter/shared/pos` (`getPosOrder`, `addPosTender`, `completePosOrder`, `issuePosReceipt`, `openPosShift`, `listPosShifts`, `getPosShift`, `recordPosCashMovement`, `listPosCashMovements`, `closePosShift`, `getEndOfDayRecap`, `closePosDay`, `getPosApprovalPolicy`) dan `createPosOverride`/`getPosOverride` (`@starter/shared/access/override`): api/queries/hooks + `registerMock` di `mock.ts` (belum ada mock lain untuk endpoint ini; cek dulu `grep -rn "registerMock(<nama>" apps/web/src` agar tidak dobel). Fixture lolos validasi schema.
- Kontrak belum ada: tipe lokal di `types.ts` + fungsi di `api.ts` yang di mode mock memanggil `mock-engine.ts`, di luar mock melempar `ApiError(… "CONTRACT_PENDING" …)`.
- State mock di sessionStorage (lihat `features/ws03-qr-order/mock-engine.ts`), seed `?demo=` dibaca di `demo-seed.ts`.
- Hook view-model untuk layar (nama wajib, boleh tambah):
  - `usePaymentSession(orderId)` → `{ bill: { tableLabel, orderNo, itemCount, guestCount, subtotalIdr, serviceIdr, taxIdr, totalIdr, deposit?: { reference, amountIdr, paid: boolean } , allocations: Array<{ id, method, label, amountIdr, status, confirmedAt? }>, remainingIdr, paid: boolean }, activeAttempt: null | { id, method, status: "waiting"|"expired"|"failed"|"confirmed"|"unknown", amountIdr, expiresAt?, va?: {bank, number, deadline}, edc?: {terminalId, terminalLabel, bank, mode: "card"|"qris", lockedAmountIdr}, cardMasked?, bankRef? }, cash?: { receivedIdr, changeIdr }, receiptNo? }` + `isLoading/error`.
  - `usePaymentMethods(orderId)` → daftar metode aktif `{ code, label, hint, enabled }`.
  - Mutasi: `useStartPayment` (metode, nominal, opsi bank/dompet/terminal), `useCheckPaymentStatus`, `useRefreshQris`, `useConfirmCash` (nominal tagihan, uang diterima), `useRecordEdcStandalone` (bankRef, overrideId), `useCancelAttempt`, `usePrintReceipt`, `useEdcTerminals()`, `useVaBanks()`, `useEwallets()`.
  - `useCashierCodeLookup()` (mutasi, input kode → `{ orderId, code, tableLabel, items: [{name, qty, amountIdr}], totalIdr, status }` atau error `NOT_FOUND`).
  - Shift: `useActiveShift()`, `useOpenShift`, `useCashMovements(shiftId)`, `useRecordCashMovement`, `useSubmitBlindCount` (per pecahan: `{ denominationIdr, quantity }[]` + gabungan pecahan kecil/koin sebagai nominal), `useRegisteredTerminals()`.
  - Supervisor: `useShiftReview(shiftId)` (setelah kirim: hitungan kasir, angka sistem, selisih), `useRequestOverride` (alasan + PIN → `overrideId`), `useApproveShiftClose` (shiftId, overrideId, alasan).
  - Tutup hari: `useDayCloseRecap()` (kanal, metode, settlement per bank, stok opsional, status: open|closed, batas hari usaha 04.00), `useCloseDay` (manajer outlet), hasil: rekap lokal tersimpan, batch per bank, antrean akuntansi, standalone belum cocok.
- Outlet id dari tenant context (lihat cara fitur lain mengambil outlet id).
- Bukti: `pnpm --filter @starter/web typecheck` lulus untuk file milikmu; tulis unit test kecil `features/ws04-pos-kasir/mock-engine.test.ts` bila ada runner (cek `apps/web/package.json`) untuk aritmetika sisa/kembalian/selisih.

### B — Komponen bersama, rute, i18n, nav (implementer)

Milik: `features/ws04-pos-kasir/components/shared/*`, `components/payment/panel-types.ts` + STUB semua file panel (lihat "Panel pembayaran"; stub = `export function XPanel(_: PaymentPanelProps) { return null; }`, nama: `MethodGrid`, `SplitPanel`, `CashPanel`, `SuccessPanel`, `QrisPanel`, `VaPanel`, `EwalletPanel`, `CardOnlinePanel`, `FailedPanel`, `EdcPanel`), stub `components/payment/payment-screen.tsx`, `components/cashier-code/cashier-code-screen.tsx`, `components/shift/{shift-open-screen,shift-active-screen,blind-count-screen}.tsx`, `components/supervisor/shift-approval-screen.tsx`, `components/day-close/day-close-screen.tsx` (props minimal: id dari rute); semua route file di tabel Rute (guard + render screen) lalu regenerasi `apps/web/src/routeTree.gen.ts` (cari cara tanpa build penuh, mis. `npx tsr generate` dari `apps/web` bila ada; bila hanya lewat vite, jalankan `heavy pnpm --filter @starter/web build` sekali); katalog kosong `packages/shared/src/i18n/messages/pos-kasir-{common,payment,gateway,edc,code,shift,supervisor,dayclose}.ts` terdaftar di `messages/id.ts`; `features/ws04-pos-kasir/nav.ts` (area ops: Kode bayar → `/pos/kode`, Shift kasir → `/pos/shift`, Tutup hari → `/pos/tutup-hari`; cek cara nav di-glob di `lib/areas/nav-registry.ts`).

- Komponen bersama (presentasi murni, props polos, tanpa hook data), dari mockup `payment-methods.png` + `payment-split.png` + `shift-blind.png`:
  - `PosPageHeading` (judul, subjudul, aksi kembali di kanan).
  - `PosTwoPane` (kiri panel tetap ±400 px, kanan panel kerja; menumpuk di <768 px).
  - `BillPanel` (meja, pill status Belum lunas/Lunas, nomor pesanan · item · tamu, baris subtotal/service/pajak, total, DP terpakai + "✓ DP lunas · RSV–…", alokasi terkonfirmasi, kotak "Sisa yang harus dibayar" angka besar). Props polos sesuai `bill` di tugas A.
  - `PosPanel` (kartu bergaris dengan judul + pill kanan + footer aksi kanan-bawah).
  - `StatusPill` (tone: neutral|warning|success|danger|info, selalu ikon + teks).
  - `Notice` (tone info|warning|danger, judul tebal + kalimat).
  - `StateBlock` (tanda bulat ok/fail opsional, judul, kalimat, nominal besar, slot).
  - `AmountKeypad` (input nominal besar + tombol 1–9, 000, 0, ⌫; tombol cepat opsional; `inputmode="numeric"`, label terlihat).
  - `TenderCard` (judul, pill, baris referensi + nominal, catatan).
  - `DenominationCounter` (baris per pecahan: label, stepper/inputs jumlah, subtotal; total fisik).
  - `SupervisorPinDialog` (dialog: ringkasan, alasan wajib, PIN pakai `PinPad` yang ada; `onSubmit({reason, pin})`, `pending`, `error`).
- Bukti: typecheck lulus; rute terdaftar di routeTree.

### T — Test penerimaan mock (test-writer)

Milik: `e2e/legend-mjmm-pos-kasir.mock.spec.ts`. Baca `e2e/legend-2w5-payment.mock.spec.ts`, `e2e/mock-server.ts`, `e2e/screenshots.ts`, `playwright.mock.config.ts`, mockup README + HTML untuk copy. Tulis test per alur memakai rute dan seed di atas, locator berbasis role/teks Indonesia dari mockup (bukan testid): bayar tunai penuh sampai lunas + kembalian; split QRIS (seed `split`) lalu tunai 48.000 dengan uang 50.000 → kembalian 2.000 → lunas; QRIS kedaluwarsa tidak menampilkan QR lama; QRIS gagal → "Pilih metode lain"; EDC tidak pasti → wajib "Cek status" sebelum ulang/ganti metode (tombol ulang tidak tersedia sebelum cek); EDC standalone wajib referensi bank + PIN supervisor; kode LG-0044 ditemukan → lanjut bayar; kode salah → input dipertahankan; buka shift modal 500.000; kas keluar wajib nominal + alasan; blind count tidak menampilkan saldo sistem/selisih ke kasir; supervisor melihat selisih −20.000, alasan + PIN wajib; tutup hari menampilkan batas 04.00 dan hasil per bank. Juga ambil screenshot 1280×800 tiap state lewat helper `e2e/screenshots.ts` (nama berkas = nama PNG mockup). JANGAN jalankan Playwright (agent induk menjalankan). Bukti: file ditulis, `pnpm exec tsc --noEmit -p e2e` atau typecheck setara lulus bila ada.

## Gelombang 2 (setelah A dan B selesai)

Tiap subagent: isi screen/panel stub miliknya + katalog i18n miliknya, wiring hook dari `hooks.ts`, kondisi loading/kosong/error/sukses, 390 px utuh. Baca hanya mockup layarmu.

- P1 Bayar inti: `payment-screen.tsx`, `method-grid.tsx`, `split-panel.tsx`, `cash-panel.tsx`, `success-panel.tsx`, route `pos.bayar.$orderId.tsx`, katalog `pos-kasir-payment.ts`. Mockup: payment-methods, payment-split, payment-cash, payment-success. "Bayar sebagian" membuka nominal alokasi (split). DP lebih besar dari tagihan: tampilkan "Sisa DP Rp… jadi saldo pelanggan" (keputusan Q7).
- P2 Gateway: `qris-panel.tsx`, `va-panel.tsx`, `ewallet-panel.tsx`, `card-online-panel.tsx`, `failed-panel.tsx`, katalog `pos-kasir-gateway.ts`. Mockup: payment-qris-active, payment-qris-expired, payment-va, payment-failed. Tidak ada QR palsu di layar kasir (QR tampil di customer display); hitung mundur masa berlaku.
- P3 EDC: `edc-panel.tsx` + `edc-select.tsx`, `edc-waiting.tsx`, `edc-unknown.tsx`, `edc-success.tsx`, `edc-standalone.tsx`, katalog `pos-kasir-edc.ts`. Mockup: edc-select, edc-waiting, edc-unknown, edc-success, edc-standalone. Nominal terkunci setelah kirim, terminal tidak bisa diganti setelah kirim; status belum pasti → hanya "Cek status" sampai hasil pasti; standalone hanya bila tidak ada permintaan sebelumnya atau hasil gagal/batal, wajib referensi bank + PIN supervisor (`overrideId`), ditandai rekonsiliasi.
- S1 Kode bayar: `components/cashier-code/*`, `pos.kode.tsx`, katalog `pos-kasir-code.ts`. Mockup: cashier-code-found, cashier-code-invalid.
- S2 Shift: `components/shift/*`, `pos.shift.index.tsx`, `pos.shift.tutup.tsx`, katalog `pos-kasir-shift.ts`. Mockup: shift-open, shift-active, shift-blind. Blind count per pecahan, tanpa saldo sistem/selisih.
- S3 Supervisor: `components/supervisor/*`, `pos.supervisor.shift.$shiftId.tsx`, katalog `pos-kasir-supervisor.ts`. Mockup: supervisor-approval.
- S4 Tutup hari: `components/day-close/*`, `pos.tutup-hari.tsx`, katalog `pos-kasir-dayclose.ts`. Mockup: supervisor-day-close, supervisor-day-closed. Manajer outlet, batas 04.00, rekap tersimpan ≠ batch berhasil ≠ akuntansi tersinkron.

## Gelombang 3 — perbaikan review (temuan reviewer 0768b37)

- R1 (payment-screen.tsx + cash-panel.tsx + edc-panel/edc-select bila perlu): setelah alokasi terkonfirmasi bertambah tapi tagihan belum lunas, `step` (dan `edcStep`) harus reset ke pilihan metode/split; nominal panel = `Math.min(step.amountIdr, bill.remainingIdr)`. Tombol Konfirmasi tunai nonaktif bila nominal > sisa. Kirim kunci idempotensi per percobaan bila hook mendukung (lihat `useConfirmCash`/`useStartPayment`). Tagih ganda = bug High.
- R2 (shift): `blind-count-screen.tsx` boleh kirim hitungan nol setelah konfirmasi eksplisit (laci kosong sah). `cash-movement-panel.tsx`: `record.reset()` saat ganti tipe dan saat submit ulang.
- R3 (data): `mock-engine.ts` `recordCashMovement` jangan tolak kas keluar berdasarkan saldo laci dengan pesan yang membocorkan saldo ke kasir (hapus cek, atau pesan generik tanpa angka); catat di CONTRACT-GAPS.md bahwa server juga tidak boleh membocorkan. `queries.ts`: semua key memuat `outletId`.

Temuan reviewer kedua:

- R4 (gateway: `gateway-parts.tsx`, `va-panel.tsx`, `method-grid.tsx`, `success-panel.tsx`): "Pilih metode lain" di ExpiredPanel/ProblemPanel untuk attempt yang bisa dicek wajib `checkPaymentStatus` dulu; lanjut hanya bila tetap tidak paid, error cek ditampilkan (High, tagih ganda). VA: kedaluwarsa dan teks batas waktu dari satu sumber (`va.deadline` atau `expiresAt`, konsisten). `method-grid.tsx`: cabang error + "Coba lagi" (bedakan CONTRACT_PENDING), jangan tampil sebagai kosong. `success-panel.tsx`: bila cetak gagal, sediakan "Lewati cetak, transaksi baru".
- R5 (supervisor + kode bayar: `shift-approval-screen.tsx`, `cashier-code-screen.tsx`): supervisor — state error + retry bila daftar supervisor gagal, pesan bila approver kosong; simpan `overrideId` yang sudah didapat dan pakai ulang saat approve diulang; FORBIDDEN dari approve jangan dipetakan ke PIN. Kode bayar — `lookup.reset()` di tiap edit bila status bukan idle; input/keypad nonaktif saat pending; hapus `aria-label` yang menimpa `<label>`.
- R3 tambahan (`api.ts`): kunci idempotensi dibuat sekali per niat (di hook/komponen, simpan di ref) lalu dikirim sebagai input, bukan dibuat baru di tiap panggilan (`closeDay`, `openShift`, dan mutasi lain yang sama).

Pembagian file gelombang 3 (tidak bertumpuk): R1 = payment-screen.tsx, cash-panel.tsx, split-panel.tsx, edc-_.tsx. R2 = components/shift/_. R3 = api.ts, hooks.ts, queries.ts, mock-engine.ts, mock.ts, CONTRACT-GAPS.md — kunci idempotensi dikelola DI DALAM hook (ref per niat, dibuat ulang setelah sukses atau saat input berubah), API hook untuk komponen TIDAK berubah. R4 = gateway-parts.tsx, va-panel.tsx, ewallet-panel.tsx, card-online-panel.tsx, failed-panel.tsx, qris-panel.tsx, method-grid.tsx, success-panel.tsx. R5 = supervisor/_, cashier-code/_. Katalog i18n: masing-masing hanya file katalog area sendiri. Pakai `npx prettier --write <file sendiri>`, JANGAN `pnpm format`.

### Temuan e2e mock (run pertama: 17 lulus, 15 gagal) — tambahan per potongan

Konteks gagal: `test-results/<test>/error-context.md`. Semua kondisi error di semua layar wajib punya tombol berlabel "Coba lagi" (atau diawali "Coba lagi").

- R2: error state shift (buka/aktif/tutup) dengan "Coba lagi". Cek `/pos/shift` tanpa seed tampil form buka shift (run pertama tampil shift aktif; koordinasi lewat data R3 — kamu cukup pastikan layar memilih form buka bila `useActiveShift` kosong).
- R3: jalur engine di `api.ts` (fungsi DEMO-CONTRACT dan sesi) wajib menghormati skenario `?mock=error|empty` (lihat `apps/web/src/lib/mock/control.ts`) seperti `registerMock`. Mock `refreshQris` diberi jeda ±2,5 detik agar kondisi kedaluwarsa terlihat. Pastikan default tanpa seed = belum ada shift. Selidiki EDC standalone dengan referensi `736214805192` + PIN `123456` (= `MOCK_SUPERVISOR_PIN`) yang tetap di form (tidak ke layar sukses) — betulkan di data bila akar di sana, atau laporkan file UI-nya.
- R4: QRIS menunggu: tombol utama "Lihat customer display →" (link ke `/pos/customer-display`) + sekunder "Cek status pembayaran" sesuai mockup. QRIS dan kartu online: dibuat otomatis saat panel dibuka tanpa attempt (tanpa langkah "Buat QRIS"), jaga agar tidak dobel (StrictMode/re-render). Kedaluwarsa: tampil heading "QRIS kedaluwarsa" + progres "Memeriksa status dan memperbarui QRIS…" selama refresh. MethodGrid: error + "Coba lagi".
- R5: error state supervisor dengan "Coba lagi".
- R6 (`components/day-close/*`, katalog `pos-kasir-dayclose.ts`): kondisi ditutup: tombol utama "Kembali ke kasir" (link ke `/pos`) + "Cetak rekap harian" sekunder sesuai mockup; error state dengan "Coba lagi".
- T (test-writer, `e2e/legend-mjmm-pos-kasir.mock.spec.ts`): betulkan asumsi spec yang salah: heading kembar h1/h2 (strict mode) → pakai `level` atau scope panel; "Lanjut ke pembayaran" adalah link (role link); label pecahan pakai regex toleran spasi/NBSP (`/Rp\s?100\.000/`); tombol hapus keypad bernama "Hapus angka terakhir"; PIN demo `123456`; teks referensi tampil dengan tanda pisah panjang (`LG–0044`, `POS01–000048`) bila spec mencari teks tampilan. Jangan longgarkan assert yang mengunci perilaku mockup (CTA, status, nominal); yang salah di UI biarkan gagal dan sebutkan di laporan. Jangan jalankan Playwright.
