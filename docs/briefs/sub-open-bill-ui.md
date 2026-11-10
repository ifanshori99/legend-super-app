# Sub-brief: open bill UI, langkah 1 (legend-8cm4, legend-2zb5)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/open-bill-r1` (cabang `ws/open-bill-r1`). Kerja HANYA di worktree ini. Jangan commit, jangan push.
Baca dulu: `AGENTS.md` (bagian Web), `DESIGN.md` §1 (densitas: POS = `kontras`, kelola = `padat`), `~/.agents/team/ui-standard.md` (aturan yang bisa diperiksa).
Langkah 1 = UI yang bisa diklik dengan data mock. Backend nyata (route API, permission, PIN asli, audit) dikerjakan langkah 2, setelah founder meninjau UI. Jangan sentuh `apps/api`.

## Keputusan bisnis
- Founder Q31: supervisor atau manager yang bertugas bisa mengubah sesi meja yang sedang berjalan (bayar dulu / `pay_first`) jadi open bill (bayar belakangan), dalam batas kebijakan outlet. Q32: masuk rilis pertama.
- F&B: kebanyakan bayar dulu; open bill hanya untuk tamu/area tertentu.
- Tombol "Jadikan open bill" tampil untuk semua staf yang membuka panel meja (route `/pos/meja` sudah dijaga `floor.table.operate`); otorisasinya PIN supervisor+ (pola override POS). Server (langkah 2) yang memutuskan.
- Batas yang dicek: sisa tagihan belum dibayar (`row.outstandingIdr`) dibanding `maxBillValueIdr` kebijakan outlet. Sama atau lebih dari batas = ditolak (tanpa PIN pad).
- Kebijakan outlet: `maxBillValueIdr` default 3.000.000, `inactivityMinutes` default 45, `billRequestSloSeconds` default 180. Rentang dan skema: `packages/shared/src/qr-order/open-bill.ts` (`openBillPolicySchema`, `upsertOpenBillPolicyInputSchema`, konstanta `OPEN_BILL_*`).
- Halaman kebijakan: `/kelola/pengaturan/open-bill`, untuk outlet_manager ke atas. Guard sementara langkah 1: `anyOf: ["floor.table.manage"]` (dipegang tenant_admin, general_manager, outlet_manager). Langkah 2 menggantinya dengan permission sempit baru.

## Potongan A: kontrak draf + mock + lapisan data (implementer A)
File: `packages/shared/src/qr-order/endpoints.ts` (tambah di dekat `confirmOpenBillSession`), `packages/shared/src/qr-order/open-bill.ts` (skema input baru + kode error), `apps/web/src/lib/mock/ws03/engine.ts` dan seed-nya di `apps/web/src/lib/mock/ws03/` (aksi konversi + fixture), `apps/web/src/features/open-bill/{api,queries,hooks,mock,lib,outlet}.ts`.
- Endpoint draf (pakai `defineEndpoint`, `dataResponseSchema`, ikuti pola file itu):
  - `getOpenBillPolicy`: GET `/api/outlets/:outletId/open-bill-policy` → `{ data: OpenBillPolicy }`.
  - `updateOpenBillPolicy`: PUT `/api/outlets/:outletId/open-bill-policy`, body `upsertOpenBillPolicyInputSchema` → `{ data: OpenBillPolicy }`.
  - `convertSessionToOpenBill`: POST `/api/table-sessions/:sessionId/open-bill`, body `convertSessionToOpenBillInputSchema` = strictObject `{ reason: string trim 3..300, pin: string 6 digit (samakan dengan skema PIN staf yang sudah ada bila ada) }` → `{ data: TableSession }`.
  - Kode error baru di `open-bill.ts`: `OPEN_BILL_CONVERT_LIMIT` (409, tagihan sudah ≥ batas), `OPEN_BILL_PIN_REJECTED` (403, PIN salah atau bukan supervisor+), `OPEN_BILL_NOT_ELIGIBLE` (409, sesi bukan pay_first yang berjalan).
- Mock (`features/open-bill/mock.ts`, `registerMock`, pola `features/ws03-floor/mock.ts`):
  - Kebijakan per outlet di memori, mulai default (isDefault true). PUT menyimpan, isDefault false. Skenario `empty` = default.
  - Konversi: PIN `123456` diterima; lainnya → 403 `OPEN_BILL_PIN_REJECTED`. Outstanding ≥ batas → 409 `OPEN_BILL_CONVERT_LIMIT`. Bukan pay_first berjalan → 409 `OPEN_BILL_NOT_ELIGIBLE`. Sukses: `paymentMode` sesi jadi `open_bill`, papan ikut berubah (lewat engine ws03).
  - Fixture: pastikan papan mock punya (1) satu sesi `pay_first` berjalan dengan outstanding di bawah Rp3.000.000, dan (2) satu sesi `pay_first` berjalan dengan outstanding ≥ Rp3.000.000 (misal Rp3.450.000). Catat kode mejanya di bagian "Hasil A" di bawah.
- Lapisan data web (pola `features/ws03-floor/{api,queries,hooks}.ts`):
  - `api.ts`: `getOpenBillPolicy(params)`, `updateOpenBillPolicy(params, body)`, `convertSessionToOpenBill(params, body)` lewat `callEndpoint`.
  - `queries.ts`: `openBillKeys`, `openBillPolicyQuery(outletId)`.
  - `hooks.ts`: `useOpenBillPolicy(outletId)`, `useUpdateOpenBillPolicy(outletId)`, `useConvertToOpenBill()` (variabel `{ sessionId, reason, pin }`, invalidasi query papan meja dari `features/ws03-floor/queries.ts` dan kebijakan).
  - `lib.ts`: `openBillErrorKey(error): MessageKey` memetakan ketiga kode di atas ke `openBillConvert.error.limit|pin|notEligible`, `NETWORK_ERROR`/lainnya ke `openBillConvert.error.generic`; `isOverOpenBillLimit(outstandingIdr, policy)`.
  - `outlet.ts`: `OPEN_BILL_OUTLET_ID` mengikuti pola `features/ws05-tax/outlet.ts` (outlet mock yang sama dengan papan meja).

## Potongan B: aksi POS "Jadikan open bill" (implementer B)
File: `apps/web/src/features/ws03-floor/lib.ts` (`rowActions`: flag `convertOpenBill` = sesi berjalan dan `paymentMode === "pay_first"`), `apps/web/src/features/ws03-floor/components/table-actions-panel.tsx`, komponen baru `apps/web/src/features/open-bill/components/convert-open-bill-dialog.tsx`, teks `packages/shared/src/i18n/messages/open-bill-convert.ts` (sudah terdaftar di `id.ts` sebagai `openBillConvert`).
- Tombol tampil juga saat `canManage` false (supervisor tidak memegang `floor.table.manage`); taruh di luar blok `!canManage`, gaya `MenuButton` (outline), ikon lucide `HandCoins` atau `ReceiptText`.
- Dialog memakai `SupervisorPinDialog` (`features/ws04-pos-kasir/components/shared/supervisor-pin-dialog.tsx`) untuk alasan + PIN. `summary` berisi blok "Batas outlet" (dl): Batas tagihan, Tagihan belum dibayar (`Money`), Pengingat tidak aktif. Kebijakan dari `useOpenBillPolicy(board.outletId)`.
- Kondisi: memuat (skeleton di blok batas, PIN pad tetap boleh tampil? tidak: tunggu kebijakan), error muat kebijakan (pesan + tombol "Coba lagi", tanpa PIN pad), ditolak batas (Dialog biasa, alert, tanpa PIN pad, tombol "Tutup"), PIN ditolak (`error` prop), sukses (toast, tutup panel).
- Copy (Bahasa Indonesia, isi file i18n):
  - action: "Jadikan open bill"
  - title: "Jadikan open bill · Meja {code}"
  - summary: "Tamu bayar belakangan. Pesanan berikutnya masuk ke tagihan terbuka meja ini."
  - limits.title: "Batas outlet"; limits.max: "Batas tagihan"; limits.outstanding: "Tagihan belum dibayar"; limits.idle: "Pengingat tidak aktif"; limits.idleValue: "{minutes} menit"
  - who: "Butuh PIN supervisor, manajer outlet, atau pemilik. Alasan dan nama penyetuju tercatat di jejak audit."
  - over.title: "Tagihan sudah melewati batas"; over.body: "Tagihan belum dibayar {outstanding} sudah mencapai batas open bill outlet {limit}. Minta tamu membayar sebagian dulu, atau minta manajer menaikkan batas di Kelola › Pengaturan › Open bill."
  - error.limit: sama makna dengan over.body singkat; error.pin: "PIN salah atau bukan milik supervisor. Coba lagi, atau minta supervisor yang bertugas."; error.notEligible: "Meja ini sudah open bill atau sesinya sudah selesai. Muat ulang papan meja."; error.generic: "Belum bisa menyimpan. Periksa koneksi lalu coba lagi."
  - policyError: "Batas open bill outlet belum bisa dimuat. Periksa koneksi lalu coba lagi."; retry: "Coba lagi"; close: "Tutup"
  - success: "Meja {code} sekarang open bill"

## Potongan C: halaman kebijakan `/kelola/pengaturan/open-bill` (implementer C)
File: `apps/web/src/routes/_kelola/kelola.pengaturan_.open-bill.tsx` (pola `kelola.pengaturan_.outlet.tsx`, guard sementara di atas, tanpa loader), `apps/web/src/features/open-bill/components/open-bill-policy-page.tsx`, `apps/web/src/features/open-bill/nav.ts` HANYA bila hub pengaturan tidak bisa dipakai (utamakan tautan di hub `/kelola/pengaturan`, cari di `routes/_kelola/kelola.pengaturan.tsx` dan komponennya), teks `packages/shared/src/i18n/messages/open-bill-policy.ts` (terdaftar sebagai `openBillPolicy`). Jalankan generator routeTree seperti repo biasa (dev/build TanStack menulis `routeTree.gen.ts`; bila perlu `pnpm --filter @starter/web exec tsr generate`).
- Form state React biasa (pola `features/ws05-tax/components/tax-settings-dialog.tsx`): `FormField`, `Input` (`inputMode="numeric"`), validasi saat blur dan saat kirim dengan `upsertOpenBillPolicyInputSchema`, pesan dekat field. Rupiah ditampilkan berformat (Rp3.000.000), angka `tabular-nums`.
- Kondisi: memuat (skeleton bentuk form), error muat (pesan + "Coba lagi"), default (badge "Memakai nilai default"), simpan sukses (toast), simpan gagal (alert `role="alert"`).
- Copy:
  - title: "Kebijakan open bill"; subtitle: "Atur batas meja yang boleh bayar belakangan di outlet ini."
  - defaultBadge: "Memakai nilai default"
  - explain: "Supervisor yang bertugas bisa menjadikan meja open bill dengan PIN, selama tagihan belum dibayar di bawah batas ini."
  - max.label "Batas nilai tagihan"; max.hint "Sisa tagihan belum dibayar per meja. Pesanan baru ditolak setelah batas ini. Rp100.000 sampai Rp1.000.000.000."
  - idle.label "Pengingat meja tidak aktif"; idle.unit "menit"; idle.hint "Waiter zona diberi tahu bila meja open bill tanpa aktivitas selama ini. 5 sampai 720 menit."
  - slo.label "Target respons minta tagihan"; slo.unit "detik"; slo.hint "Permintaan tagihan dianggap terlambat setelah waktu ini. 30 sampai 3.600 detik."
  - who: "Hanya manajer outlet ke atas yang bisa mengubah. Setiap perubahan tercatat di jejak audit."
  - save "Simpan kebijakan"; reset "Kembalikan ke default" (mengisi nilai default ke form, belum menyimpan); saved "Kebijakan open bill disimpan"; loadError "Kebijakan open bill belum bisa dimuat. Periksa koneksi lalu coba lagi."; saveError "Kebijakan belum tersimpan. Periksa koneksi lalu coba lagi."; retry "Coba lagi"
  - hub link: label "Open bill", deskripsi "Batas tagihan dan pengingat meja bayar belakangan"

## Aturan bersama
- Komponen memakai hook dari `features/open-bill/hooks.ts` (A). Bila A belum selesai, tulis kode terhadap nama hook di atas; jangan membuat lapisan data sendiri.
- Hanya file potonganmu. `id.ts` sudah didaftarkan; jangan edit kecuali kunci `nav.*` bila C memakai nav.
- Target sentuh ≥ 44 px di mobile, label selalu terlihat, status dengan ikon + teks, tanpa gradien/glow/sparkle.
- Bukti selesai potongan: `pnpm --filter @starter/web exec eslint <file berubah>` dan `pnpm exec prettier --check <file berubah>` bersih. JANGAN menjalankan tsc, build, atau e2e (agent induk menjalankannya lewat `heavy`).
- Lapor: file berubah, keputusan kecil yang kamu ambil, yang belum selesai.

## Hasil A
- Fixture mock (pay_first, status open, papan `/pos/meja`):
  - Di bawah batas: meja **B01** (zona Taman Outdoor), sisa tagihan Rp218.300.
  - Di atas batas: meja **A02** (zona Indoor Reguler), sisa tagihan Rp3.492.700 (batas default Rp3.000.000).
  - A03 tetap pay_first tanpa pesanan (sisa Rp0): sengaja tidak diubah, e2e `legend-7ko` menutup dan memindahkan A03.
- PIN mock: `123456` diterima; PIN lain ditolak 403 `OPEN_BILL_PIN_REJECTED`. Urutan cek di mock: PIN, lalu kelayakan (`OPEN_BILL_NOT_ELIGIBLE`), lalu batas (`OPEN_BILL_CONVERT_LIMIT`).
- Hook mengembalikan payload terbuka: `useOpenBillPolicy(outletId).data` bertipe `OpenBillPolicy` (api.ts membuka envelope `{ data }`). Pakai `.data` satu kali, bukan `.data?.data`.
- `useUpdateOpenBillPolicy(outletId).mutate(body)` menerima `{ maxBillValueIdr, inactivityMinutes, billRequestSloSeconds }`; sukses mengganti cache kebijakan.
- `useConvertToOpenBill().mutate({ sessionId, reason, pin })`; sukses menyegarkan papan, tagihan sesi, dan kebijakan.
- Default kebijakan (untuk "Kembalikan ke default"): `OPEN_BILL_DEFAULTS` di `features/open-bill/lib.ts`.
- File berubah: `packages/shared/src/qr-order/{open-bill,endpoints}.ts`, `apps/web/src/lib/mock/ws03/engine.ts` (aksi `convertSessionToOpenBill`, seed B01 dan A02), `apps/web/src/features/open-bill/{api,queries,hooks,mock,lib,outlet}.ts`.
- Diperiksa: eslint dan prettier bersih; `ws03-open-bill.test.ts` 10 lulus; skrip sementara memastikan engine (A02 ditolak batas, B01 sukses, ulang jadi NOT_ELIGIBLE). Belum: tsc, build, e2e.

## Potongan D: spec screenshot mock (test-writer)
File: `e2e/legend-8cm4-open-bill.mock.spec.ts` saja. Pola: spec mock yang membuka `/pos/meja` (cari `grep -ln "pos/meja" e2e/*.ts`, mis. `e2e/legend-5kop.mock.spec.ts`) dan helper `captureScreenshot` di `e2e/screenshots.ts`. Kode meja fixture + PIN mock: bagian "Hasil A" (atau seed di `apps/web/src/lib/mock/ws03/`).
Tiap layar di dua lebar: 390x844 dan 1280x800, nama `legend-8cm4/<layar>-<lebar>.png`:
1. `pos-panel`: panel meja sesi pay_first di bawah batas, tombol "Jadikan open bill" terlihat.
2. `pos-convert`: dialog konversi siap (blok Batas outlet + alasan + PIN pad).
3. `pos-convert-pin-error`: alasan diisi, PIN salah `000000`, pesan PIN ditolak.
4. `pos-convert-over-limit`: meja di atas batas, dialog ditolak batas.
5. `pos-convert-policy-error`: `window.__legendMock.failNext("GET /api/outlets/:outletId/open-bill-policy", { status: 500, code: "INTERNAL" })` sebelum membuka dialog (cek format `failNext` di `apps/web/src/lib/mock/control.ts`).
6. `pos-convert-success`: PIN benar, toast sukses, panel tertutup.
7. `kelola-policy`: `/kelola/pengaturan/open-bill` default (badge default).
8. `kelola-policy-invalid`: batas diisi `50000`, blur, pesan error field.
9. `kelola-policy-error`: `?mock=error`.
10. `kelola-policy-saved`: ubah nilai, "Simpan kebijakan", toast.
Assert minimal yang bermakna per langkah (teks terlihat). Jangan jalankan spec; agent induk menjalankannya lewat `heavy`. Bukti: eslint + prettier bersih untuk file spec.

## Potongan E: perbaikan temuan review (implementer)
1. Alasan < 3 karakter lolos ke server lalu tampil sebagai error generik. Tambah prop opsional `minReasonLength` di `features/ws04-pos-kasir/components/shared/supervisor-pin-dialog.tsx` (default perilaku lama), pesan dekat field, teks baru `posKasirCommon.pinDialog.reasonTooShort` ("Alasan minimal {min} karakter."); `convert-open-bill-dialog.tsx` mengirim `minReasonLength={3}`.
2. `convert-open-bill-dialog.tsx`: cabang error kebijakan hanya bila belum ada data: `if (!policy && policyQuery.isError)`.
3. `open-bill-policy-page.tsx`: field menit dan detik menolak input yang bukan `/^\d+$/` (trim) sehingga pesan "Isi angka bulat" tampil; strip digit hanya untuk field Rupiah. Ganti `DEFAULT_VALUES` lokal dengan `OPEN_BILL_DEFAULTS` dari `features/open-bill/lib.ts`.
Bukti: eslint + prettier bersih untuk file berubah. Jangan jalankan tsc/e2e.

## Potongan F1: perbaikan audit, halaman kebijakan (implementer)
File: `apps/web/src/features/open-bill/components/open-bill-policy-page.tsx`, `packages/shared/src/i18n/messages/open-bill-policy.ts`.
- Target sentuh mobile ≥ 44 px: tombol Simpan/Kembalikan dan input `h-11 sm:h-control` (atau `size="lg"` di mobile).
- Sesi akses dukungan "Hanya baca": cari cara halaman kelola lain mendeteksi sesi read-only (grep `support` / `readOnly` / `Hanya baca` di `apps/web/src`), lalu nonaktifkan form + tampilkan alasan bila berlaku. Bila tidak ada pola, lapor saja.
- Submit tidak valid: fokus ke field salah pertama.
- Hint rentang memakai placeholder `{min}`/`{max}` yang diisi dari konstanta `OPEN_BILL_*` (Rupiah lewat `formatRupiah`).
- Skeleton berbentuk form (3 label + input + tombol).
- Hint dan teks penjelas `text-base sm:text-sm` (body ≥ 16 px di mobile).
- Atribut `name` pada input.
- Istilah satu: "sisa tagihan" (bukan "tagihan belum dibayar"). "Pesanan baru ditolak setelah batas ini" BENAR (order QR ditolak 409 `QR_ORDER_OPEN_BILL_LIMIT`), pertahankan; tambahkan bahwa meja di atas batas juga tidak bisa dijadikan open bill.
Bukti: eslint + prettier bersih.

## Potongan F2: perbaikan audit, dialog POS + papan (implementer)
File: `apps/web/src/features/open-bill/components/convert-open-bill-dialog.tsx`, `packages/shared/src/i18n/messages/open-bill-convert.ts`, `apps/web/src/features/ws04-pos-kasir/components/shared/supervisor-pin-dialog.tsx`, `apps/web/src/features/ws03-floor/components/table-card.tsx`.
- `SupervisorPinDialog`: prop opsional `details?: ReactNode` dirender di body setelah header, di luar `DialogDescription`; dialog konversi memakai `summary` satu kalimat dan blok batas lewat `details`. Pemakai lama tidak berubah.
- Judul ditolak: "Sisa tagihan sudah mencapai batas" (aturan `>=`).
- Dialog tanpa PIN (memuat, error kebijakan, ditolak batas) tidak memakai kalimat ringkasan sukses; beri deskripsi sesuai kondisi atau tanpa deskripsi.
- Istilah satu: "Sisa tagihan" (sama dengan panel `floor.session.outstanding`).
- `LimitsBlock`: item ketiga jangan sendirian di grid 2 kolom (mis. 3 kolom di sm, atau baris penuh).
- `table-card.tsx`: sesi dengan `paymentMode === "open_bill"` menampilkan penanda kecil ikon + teks "Open bill" (pakai `paymentModeLabel`/kunci `floor.paymentMode.open_bill`), tenang, bukan warna aksen penuh.
Bukti: eslint + prettier bersih.
