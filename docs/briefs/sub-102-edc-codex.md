# Sub-brief 102: fix temuan Codex EDC (4 P1, tingkat K)

Worktree `.worktrees/fix-edc-codex`, cabang `ws/fix-edc-codex`. Jangan commit. Jangan pkill/killall test. Teks temuan lengkap: `legend/docs/briefs/102-fix-edc-codex.md` di checkout utama (`/Users/ifanshori99/Projects/legend super app/legend/docs/briefs/102-fix-edc-codex.md`). Tiap temuan: test merah dulu (jalankan, catat gagal), lalu fix, lalu hijau.
Run satu file test dari root worktree: `LEGEND_TEST_FILES="<path>" pnpm test` (cek `scripts/test.mjs`; test edge/edc mungkin unit tanpa DB, cek config vitest yang relevan).

## Potongan X (implementer, berurutan): temuan 1–3, `apps/api/src/edge/edc/agent.ts` + test edc agent yang ada/baru

1. `agent.ts` ~319: `not_found` melewati validasi trace. Validasi trace/STAN/invoice milik transaksi ini SEBELUM outcome apa pun (termasuk not_found) diterapkan; respons yang tidak cocok diabaikan/diperlakukan unknown, tidak boleh membuat transaksi `failed` (yang memicu tagih ulang).
2. `agent.ts` ~1061: dispatch tidak cek ulang kepemilikan outlet. Simpan generasi/token kepemilikan saat ambil lock; cek ulang tepat sebelum kirim ke terminal; `stop()` menunggu operasi in-flight selesai (atau di-abort sebelum kirim) sebelum melepas lock. Test: stop() saat preflight menunggu + agent pengganti → hanya satu yang mengirim.
3. `agent.ts` ~953: inquiry memakai config terminal terkini. Simpan identitas terminal (TID/MID/IP/batch) pada transaksi saat dispatch, inquiry pakai snapshot itu; bila terminal berganti, inquiry ke terminal lama atau status tetap unknown (bukan not_found → boleh tagih). Pilih opsi yang paling kecil dan aman; bila butuh kolom DB baru (migrasi), BERHENTI dan laporkan desainnya dulu, jangan buat migrasi.

## Potongan Y (implementer): temuan 4, `packages/shared/src/edc/index.ts` ~143 + parser respons provider EDC

- `cardType` allowlist (mis. VISA, MASTERCARD, JCB, AMEX, UNIONPAY, GPN, DEBIT/lainnya sesuai yang dipakai kode) — cek nilai yang dipakai provider/driver dan fixture yang ada. Tolak string mirip PAN (13–19 digit) di batas respons provider: normalisasi ke `null`/`UNKNOWN`, jangan simpan.
- Field kartu lain (mis. maskedPan, approval code) pastikan tidak bisa membawa PAN utuh.
- Jangan edit `apps/api/src/edge/edc/agent.ts` (milik X). Bila parser provider ada di file lain, itu milikmu.
- Laporkan: kolom DB/log mana yang bisa sudah menyimpan PAN (data lama) dan usulan pembersihan; jangan buat migrasi data.

## Bukti

Merah-lalu-hijau per temuan, berkas berubah.

## Keputusan temuan 3 (agent, 9 Nov)

Tanpa migrasi: `payment-admin-config.service.ts` menolak perubahan identitas terminal (TID, MID, IP/host, port, batch bila ada) selama terminal itu punya `edc_transactions` berstatus belum final (`pending`/`unknown`/sejenis). Error jelas (mis. 409 `EDC_TERMINAL_BUSY`, pesan Indonesia). Inquiry tetap memakai config terminal; karena config tak bisa berubah selama ada transaksi terbuka, inquiry selalu ke terminal yang sama. Test merah dulu (ganti TID saat ada row unknown → harus ditolak). Milik potongan X.

## Potongan Z1 (implementer): legend-dahk — wire `setPosEdcTenderPort`

`apps/api/src/services/pos-order-ports.ts` punya `setPosEdcTenderPort`, hanya dipanggil test. Sambungkan di composition root produk (cari tempat port POS lain di-set, mis. `server.ts`/`app.ts`/bootstrap services) ke adapter EDC nyata (`apps/api/src/edge/edc/*` atau service EDC). Milik Z1: berkas bootstrap + adapter baru bila perlu. JANGAN edit `agent.ts` (X), `staff-override.service.ts`/`packages/shared/src/access/*` (Z2). Test: POST tender EDC tidak lagi 503 di app yang dibangun lewat composition root (pakai pola test API yang ada). `bd update legend-dahk --claim` di awal, jangan close.

## Potongan Z2 (implementer): legend-m4fv — override `edc_standalone`

Keputusan CTO: action `edc_standalone` di `POS_OVERRIDE_ACTIONS` + `ApprovalActionType`, permission `pos.edc_standalone.approve` (supervisor). Wajib PIN supervisor + nomor referensi EDC + flag rekonsiliasi pada tender standalone. Berkas: `packages/shared/src/access/override.ts`, permissions shared, `apps/api/src/services/staff-override.service.ts` (~138), jalur tender EDC standalone di service POS tender. Bila grant permission butuh migrasi (seed role), ikuti pola migrasi repo yang ada, additive saja, dan sebut di laporan (merge train regen nomor). JANGAN edit berkas bootstrap Z1 atau `agent.ts`. Test merah dulu. `bd update legend-m4fv --claim`, jangan close.
Catatan: skip e2e EDC-01/02/04 di `prep/e2e-az` TIDAK dibuka di sini (cabang lain, lewat merge train).

## Putaran 2 (temuan architect, 9 Nov) — wajib test merah dulu

### Potongan X2 (implementer): `apps/api/src/edge/edc/agent.ts`, `apps/api/src/services/payment-admin-config.service.ts`, `packages/shared/src/edc/index.ts`, test edc-agent*/payment-admin-api

1. High: inquiry (~982-999), queued cancel (~1552-1557), bypass cancel (~1541-1550), dan inquiry di `guardRetry` (~1157) tidak cek ulang token kepemilikan sebelum kirim. Satu perubahan di `withTerminalLock`/`hold`: cek owner tepat sebelum SETIAP panggilan ke terminal (sale, inquiry, cancel, bypass).
2. High: `stop()` hanya menunggu `performSale`, bukan panggilan provider yang masih jalan (timeout → `provider.sale` masih di kabel; `bypassWire` tak dilacak). Catat tiap panggilan terminal per outlet; `releaseOutlet` menunggu semuanya selesai.
3. Medium: config terminal dibaca (~1337-1368) jauh sebelum row ditulis (~1207). Baca ulang row terminal `FOR KEY SHARE` di dalam transaksi `writeAhead` dan bangun `ecrTerminal` dari salinan itu (agar busy-check admin dan dispatch konsisten).
4. Low: owner check menolak (~1085) → row tetap `unknown` dengan `dispatchedAt`; bila belum terkirim, tandai jelas tidak terkirim (status final yang aman / `dispatchedAt` null) supaya tak perlu rekonsiliasi manual.
5. Low: tulis aturan "not_found inquiry wajib membawa trace bila provider mendukung" di kontrak provider (`packages/shared/src/edc/index.ts` ~207, komentar/tipe), dan jadikan `EDC_TERMINAL_BUSY` kode error/reason yang bisa dicek UI (bukan hanya prefix teks).

### Potongan Z3 (implementer): EDC-04 tender standalone (legend-m4fv), desain architect diterima

Berkas: `packages/shared/src/pos/endpoints.ts`, `apps/api/src/services/pos-order-payment.ts`, `apps/api/src/services/pos-order-support.ts`, service baru `apps/api/src/services/pos-edc-standalone.ts`, `apps/api/src/services/pos-edc-tender.ts`, migrasi `apps/api/drizzle/0099_pos_override_edc_standalone.sql` (+ snapshot/journal bila perlu), test baru.

- Tanpa kolom tender baru. Di transaksi order: tulis row `edc_transactions` `mode='standalone'`, `status='approved'`, `needs_reconciliation=true`, `rrn` = referensi bank, `approval_code`, trace acak. Tender menaut lewat `edc_transaction_id` yang ada; `approvedBy` = supervisor, `reference` = referensi bank.
- overrideId dicatat di `pos_order_approval_uses` dengan purpose baru `edc_standalone` (single-use). Lipat perubahan `pos_order_approval_uses_purpose_check` (dan partial unique index pada `pos_order_tenders.edc_transaction_id`) ke dalam 0099 (belum di-merge, boleh diubah).
- Kontrak `addPosTender`: `standalone: { terminalId, bankRef, approvalCode?, overrideId }`, eksklusif dengan `edcTransactionId`. bankRef 13–19 digit (mirip PAN) ditolak.
- Guard: advisory lock sama dengan `writeAhead`; tolak bila ada row terminal kartu untuk bill itu `pending`/`unknown`/flagged; jumlah override = sisa bill persis; `consumeApproval` menerima objectType `pos_order`.
- `pos-edc-tender.ts`: tolak row dengan `needs_reconciliation` untuk jalur non-standalone; andalkan unique index juga.

## Putaran 3 (reviewer Opus) — potongan X3 (implementer): `packages/shared/src/edc/index.ts`, `apps/api/src/edge/edc/agent.ts`, `apps/api/src/edge/edc/simulator.ts`, test edc-*

1. PCI read-side: `toDto` (agent.ts ~223) dan schema transaksi baca di shared (~369, `cardType: z.string()`) meneruskan data lama apa adanya. Terapkan allowlist cardType + filter PAN yang sama saat BACA (cardType → UNKNOWN, rrn/invoiceNo/batchNo mirip PAN → null) untuk get/inquire/replay.
2. `not_found` tanpa trace (agent.ts ~325-328) masih diterima di inquiry strict → perlakukan sebagai `unknown` (bukan failed). Update simulator (~295) agar meng-echo trace pada not_found by-trace, supaya alur normal tetap jalan.
3. PAN dengan huruf tempelan lolos (shared ~146-151): tolak/null-kan nilai yang MENGANDUNG deret 13–19 digit (bukan hanya seluruhnya digit) untuk rrn/invoiceNo/batchNo/approvalCode.
   Test merah dulu per butir. Test terarah tanpa heavy.
