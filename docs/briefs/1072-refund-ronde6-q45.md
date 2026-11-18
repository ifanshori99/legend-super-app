# Brief bersama 1072 — refund ronde 6 + refund otomatis mati (Q45)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-d17aaede`, cabang `ws/1072-refund-ronde6-q45`, base 1c9e3fcaa.
Laporan SO ronde 6 (sumber temuan, baca penuh): `/Users/ifanshori99/Projects/legend super app/legend/docs/qa/second-opinion-refund-ronde6-1068.md`.
Ronde sebelumnya: `.../legend/docs/qa/second-opinion-refund-*.md`. Diterima CTO/founder (BUKAN temuan): Q32 aturan aman kredit DP; W3a/W3b; hold membebani finance; hold senilai laporan penyedia; hold refund tanpa nomor; hold konflik transaksi HANYA boleh `not_this_intent` (dana tetap tertahan); legend-jw2xt (over-count pembukuan echo); legend-qwma1, legend-ksypc.

Aturan uang: tiap fix dibuktikan test bahwa tidak ada pihak dibayar lebih dan outlet tidak rugi, di urutan mana pun (webhook x poller x resolve hold x refund baru x kredit DP x jurnal). Ragu: tahan dana.
Migrasi: hindari. Bila tak terhindar, nomor 0687-0689 saja, lapor dulu ke engineer.
Test terarah: `LEGEND_TEST_FILES="src/test/a.test.ts" heavy pnpm test` dari root worktree. SATU token heavy per thread: hanya pemegang token yang boleh menjalankan vitest/tsc.

## Temuan Tugas A (SO ronde 6)

- A1 (P1) Webhook matched melewati batas nominal echo: `payment-webhook.service.ts:~1834-1855` meneruskan nominal ke updater; updater (`payment-refund.service.ts:~4040-4045`) menolak beda nominal -> `REJECTED_CONFLICT`, webhook hanya audit, TANPA hold. Recorder (`payment-provider-partial-refund.ts:~638-683`) sudah menahan echo lebih besar. Fix: tetap tolak penyelesaian R, tapi tahan intent (hold) untuk success signed bernominal lebih besar, di bawah kunci yang sama dengan keputusan uang; aturan echo sama di jalur matched dan recorder. Test: R completed 30k/ref X, transaksi T 100k tanpa dokumen penjualan; signed `refund.succeeded` X/T 80k + replay; request/approve/payout 70k -> hold terbuka, R tetap 30k, tidak ada payout tambahan. Kontrol: R approved ber-ref, nominal sama (tanpa hold), payload `payment.refunded`.
- A2 (P1) Fact kecil sama-transaksi menyembunyikan hold konflik lebih besar dari pool DP: `reservation-deposit-credit.ts:~172-176` menganggap hold terwakili fact dengan ID+transaksi sama tanpa banding nominal/alasan. Fix: fact hanya menggantikan hold bila mewakili uang yang ditahan; hold konflik/selisih nominal tetap membatasi. Test: perluas `refund-1063-b-conflict-hold-dp-credit.test.ts`: DP T 100k, R 40k terkirim tanpa ref, fact X/T 40k force, R completed ref X, lalu `payment.refunded` X/T 100k -> hold; assert kredit asli DAN pindahan tetap terbatas, pesanan tak bisa pakai 60k, replay tak membuka, resolve sah memulihkan sekali; dua urutan hold-vs-apply.
- A3 (P2) Hold konflik ditutup lewat same_as_counted pasangan anonymous: `refund-recon-hold.service.ts:~577-582` cek konflik hanya di `payment_provider_refunds`, ref X di `payment_refunds` lolos; cabang `:603-644` mengikat fact anonim. Fix: tolak counted untuk alasan `HOLD_TRANSACTION_CONFLICT` SEBELUM cabang dedup/pemilihan fact (keputusan CTO rilis 1: konflik transaksi hanya `not_this_intent`). Test: T1/T2/T3 satu intent; anonymous T2 20k sudah counted; own X/T1 20k completed; recorder X/T2 20k -> conflict hold; counted/same ditolak, hold+binding tak berubah, fund T3 tetap terblokir; kontrol not_this_intent.
- A4 (P2) Fact pra-0679 dipakai ulang: picker (`payment-provider-partial-refund.ts:~167-169`) hanya mengecualikan fact dengan binding eksplisit, sementara hold legacy (resolved same_as_counted, `matched_fact_id` NULL) hanya mengurangi jumlah (`:205-211`). Fix: bila ada hold legacy resolved tanpa binding pada transaksi/intent itu dan kandidat lebih dari jumlah tersisa tak terbukti, tahan (tolak konservatif / tetap hold) daripada memilih fact yang mungkin sudah dipakai; atau pulihkan binding yang terbukti. Test: A 10k + B 20k anonymous, P1=10 resolved same tanpa binding (simulasi data pra-0679: set matched_fact_id NULL), lalu P2=30 same -> A tidak dipakai lagi; hanya top-up 10k atau penolakan konservatif; total fact <= 40k.

## Tugas B — legend-kmrto (Q45 refund otomatis mati)

`bd show legend-kmrto`. Saklar `DOIT_REFUNDS_ENABLED` (`apps/api/src/config/env.ts:~258`, default false); `server.ts:~53`, `worker-main.ts:~231` hanya register doitGateway bila aktif; tanpa gateway -> `UNCONFIGURED_REFUND_PROVIDER` (`payment-refund-gateway.ts:~92`).

- B1 Flag mati: `runRefundPayout` (`payment-refund.service.ts:~2247`; pemanggil approve ~1720/1725, sweep ~3069, retry ~3258) tidak pernah memanggil API penyedia, termasuk lewat `paymentRefundGatewayLegacyMode()` (~2099, ~2134).
- B2 Refund disetujui saat flag mati masuk antrean finance manual (status jelas, bukan gagal diam/retry tanpa akhir); finance mencatat refund manual sekali (idempoten, tak bisa dua kali, jumlah <= dibayar tamu).
- B3 Webhook/laporan refund penyedia (`payment-doit-refund-webhook.ts`, `payment-webhook.service.ts`) tetap dicocokkan; laporan janggal (refund penyedia tanpa refund kita, nominal beda) ditahan, tidak membuka dana.
- B4 `pos-order-corrections.ts` dan `order-recovery-refund.ts` tidak memanggil penyedia.
- B5 `docs/deployment.md`: DOIT_REFUNDS_ENABLED wajib false/tak diset di rilis 1; nyala lagi hanya setelah SO refund bersih + keputusan founder. Log peringatan startup bila true (server dan worker).

## Pembagian file (implementer, tidak bertumpuk)

- I1 `payment-webhook.service.ts` (+ bila perlu helper baru di `payment-provider-partial-refund.ts` untuk A1 — hanya I1 yang menyentuh file itu untuk A1/A4, lihat I3)
- I2 `reservation-deposit-credit.ts` (A2)
- I3 `refund-recon-hold.service.ts` + `payment-provider-partial-refund.ts` picker (A3, A4)
- I4 `payment-refund.service.ts`, `payment-refund-gateway.ts`, `server.ts`, `worker-main.ts`, `docs/deployment.md` (B)
  Konflik file I1/I3 di `payment-provider-partial-refund.ts`: I1 hanya menambah fungsi ekspor baru di akhir file; I3 hanya mengubah picker/`unmatchedAnonymousFacts`.

## I4 detail (Tugas B, hasil Explore)

Fakta: hanya `port.refund` di `payment-refund.service.ts:2533` (dalam `runRefundPayout` :2247) memanggil penyedia; flag mati -> `unconfiguredRefundGateway`, runRefundPayout (:2254) dan retryRefundPayout (:3221) lempar SERVICE_UNAVAILABLE sebelum claim, sweep (:2994) keluar. `settleRefundManually` (:3723) + rute `payment-admin.routes.ts:364` sudah ada dengan key idempotensi.
Kerja minimal, TANPA migrasi, TANPA UI baru:

1. Error saat flag mati punya kode stabil yang jelas (mis. `REFUND_PROVIDER_DISABLED`, pesan "Refund otomatis penyedia dimatikan; catat refund manual oleh finance"), refund tetap `approved` = antrean manual. Sweep: satu log `warn` berisi jumlah refund approved yang menunggu catat manual (tanpa data pribadi), tidak menambah hitungan retry.
2. Periksa `settleRefundManually`: jumlah <= sisa yang dibayar tamu (dikurangi refund lain + fact penyedia + hold terbuka), tidak bisa dicatat dua kali (key sama -> hasil sama; key beda pada refund yang sudah settled -> 409). Celah: perbaiki minimal.
3. `server.ts` dan `worker-main.ts`: `logger.warn` bila DOIT_REFUNDS_ENABLED true ("refund otomatis penyedia AKTIF; rilis 1 wajib false").
4. `docs/deployment.md`: bagian DOIT_REFUNDS_ENABLED wajib false/tak diset di rilis 1; nyala hanya setelah SO refund bersih + keputusan founder.
   Jangan ubah file I1-I3. Test: `refund-1072-b-doit-refunds-disabled.test.ts` (ditulis test-writer; jangan diubah kecuali salah setup, lapor).

## Fix review 1 (keputusan engineer)

- R1 `settleRefundManually` cap baru (`payment-refund.service.ts` ~3810-3826): tetap tolak 409 `REFUND_CAP_EXCEEDED` hanya bila refund TIDAK punya jejak penyedia (`hasProviderTrace` / cabang stuck legend-17ml MANUAL_RECONCILIATION, PAYOUT_NOT_FOUND_MAYBE_SENT). Ada jejak penyedia: jangan blokir, catat kelebihan cap di audit `detail` (seperti `approvalDefect`).
- R2 `fileOwnRefundSurplusHoldInTx` (akhir `payment-provider-partial-refund.ts`): bila insert tidak menghasilkan baris, cari hold TERBUKA dengan kunci unik yang sama (tenant, intent, kind, refundId, coalesce(T,'')); bila nominalnya < laporan atau alasannya bukan konflik: UPDATE amount_idr = greatest(amount, laporan) dan reason = HOLD_TRANSACTION_CONFLICT (hold live_own tidak boleh lagi ditutup otomatis membuka surplus). Hold yang sama sudah resolved: jangan buka ulang; log warn + audit (kasus dicatat bead terpisah). Terapkan logika yang sama di `fileTransactionConflictHold` (~473-510) lewat helper bersama.
- R3 cek: R berstatus `failed` lalu webhook matched sukses lebih besar/sama: apakah laporan tercatat sebagai fact (seperti recorder) atau hilang? Bila hilang tanpa fact/hold, minimal file hold konflik (restriktif). Lapor temuan.

## Fix B tahap 2 (keputusan engineer, setelah run 1072-b: 9 merah)

- G1 (implementer, `payment-refund-gateway.ts` saja): pertahanan berlapis. `paymentRefundGatewayFor(provider)`: bila BUKAN legacy dan `!env.DOIT_REFUNDS_ENABLED` dan provider = "doit" -> `unconfiguredRefundGateway` walau terdaftar; `registeredRefundProviders()` konsisten (buang doit saat flag mati). `setPaymentRefundGateway` (shim test) lempar Error bila `process.env.NODE_ENV === "production"` sehingga legacy mode mustahil di produksi. Cek pemanggil `registeredRefundProviders`/approve tetap memberi 503 `REFUND_PROVIDER_DISABLED` dan refund tetap approved.
- G2 (test-writer, `refund-1072-b-doit-refunds-disabled.test.ts` saja): legacy mode adalah shim test (71 file test lain memakainya dengan flag default false), jadi kasus "legacy + flag mati tidak bayar" diganti: assert `setPaymentRefundGateway` melempar saat NODE_ENV=production (stub sementara, pulihkan). Kasus "registered + flag mati" tetap: tidak ada panggilan penyedia. Diagnosa 3 merah B2 ("port none" 422 vs 200, "legacy" status mismatch, "REFUND_CAP_EXCEEDED" 409 vs 200) terhadap aturan R1 (cap hanya ditolak bila tanpa jejak penyedia): betulkan ekspektasi test bila test salah; bila produksi salah (uang bisa lebih), lapor, jangan ubah produksi.

## Fix architect akhir (keputusan engineer)

- F-P1: `closeLiveOwnHold` (`payment-provider-partial-refund.ts` ~336-356) tambah syarat WHERE `reason <> HOLD_TRANSACTION_CONFLICT_REASON` (hold live-own yang dieskalasi R2 tidak boleh ditutup otomatis). Test a1-09: DP T 100k; R 30k terkirim tanpa ref; `payment.refunded` X/T 30k -> hold live-own; `refund.succeeded` X 80k cocok R -> eskalasi 80k CONFLICT; R gagal; replay `payment.refunded` X/T 30k -> hold tetap terbuka 80k, refund baru 70k ditolak.
- F-P2: `fileTransactionConflictHoldInTx` (~1354-1390): hold lama dengan kunci sama sudah RESOLVED dan laporan > nominal hold itu -> insert hold kedua: `providerRefundId: null`, `providerRefundIdKind` sesuai skema untuk null, alasan CONFLICT, nominal = PENUH nominal laporan (restriktif), `webhookEventId` = hash yang sama + `\0surplus`, `onConflictDoNothing`, alert sekali. Test a1-10: count hold X/T 30k (resolved), lalu signed X/T 80k -> hold baru terbuka, refund 70k ditolak, replay tetap satu hold surplus.
- F-P3: pindahkan `HOLD_TRANSACTION_CONFLICT_REASON` ke modul daun baru `apps/api/src/services/refund-hold-reasons.ts` (tanpa impor), re-export dari `payment-provider-partial-refund.ts` agar impor lama tetap jalan; `reservation-deposit-credit.ts` pakai konstanta itu (ganti literal).
- F-T: a2 tambah dua urutan hold-vs-apply dengan barrier (bila premis pool tak bisa, pakai kredit sesi terbuka seperti a2-02) dan kontrol hold live-own + fact non-echo nominal sama -> pengurang 0 (tidak dobel).

## Ronde 7 (SO 1075) — perintah CTO

Laporan: `/Users/ifanshori99/Projects/legend super app/legend/docs/qa/second-opinion-refund-ronde7-1075.md` (baca penuh). Kode dipatok 7c662f8d9.

- R7-1 (P1) Atomik: webhook matched (`payment-webhook.service.ts` ~1840-1880) memasang hold di transaksi BARU setelah `applyRefundProviderUpdate` (`payment-refund.service.ts` ~4091-4108) melempar 409 dan melepas kunci intent; ada juga transaksi audit di antaranya (~1849, ~1573-1599). Settle manual R2 / apply kredit DP bisa masuk di celah itu. Aturan CTO: settle manual dan pemasangan hold berbagi kunci yang sama; hold di-commit di transaksi yang memeriksa konflik, sebelum kunci intent/DP lepas; penolakan dikembalikan setelah commit.
- R7-2 (P1) Generasi surplus: `payment-provider-partial-refund.ts` ~1373 `holdEventId("\0surplus")` permanen; surplus resolved -> laporan lebih besar berikutnya hilang. Aturan: setiap laporan sukses yang tidak terbukti echo <= refund kita selalu meninggalkan hold terbuka, termasuk sesudah hold sebelumnya resolved; replay bukti yang SAMA tetap stabil (tidak menggandakan hold).
- R7-3 (P1, legend-55up0) Keputusan CTO: success matched dengan ref berbeda (key `refund:<R>` tetapi refund_id Y != ref X, nominal sama/lebih kecil) atau nominal tak terbaca (parser invalid, ~1782-1812) WAJIB jadi hold (dana tertahan lebih baik daripada lepas). Pertahankan pengecualian payment-object fallback (legend-r7g2).
- Test gagal-dulu per temuan; race pakai dua koneksi PostgreSQL + barrier bila bisa. File test baru: `apps/api/src/test/refund-1075-r1-*.test.ts`, `refund-1075-r2-*.test.ts`, `refund-1075-r3-*.test.ts` (pakai `refund-1072-harness.ts`).
