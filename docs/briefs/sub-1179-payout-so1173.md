# Sub-brief 1179: fix SO 1173 (payout recon, DOIT recurring, approve clearance)

Temuan lengkap (skenario, berkas:baris, perbaikan, usul test): `/private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app-legend-1af0ee4e/272ca03f-096d-40db-b488-2f5c66da8e3b/scratchpad/so1173.md`. Kartu: `bd show legend-qqsw8 | legend-x2jzq | legend-1hpqt`.
Cabang `ws/1179-payout-so1173-fix`, base e35d52a76. Aturan uang: bila ragu, slip tetap ditahan, tagihan tidak dilanjutkan.

## Potongan (berkas milik, tidak bertumpuk)

| Potongan | Kartu | Kode milik | Test milik |
|---|---|---|---|
| A | qqsw8 + 1hpqt | `apps/api/drizzle/0708_*.sql` (baru), `drizzle/meta/_journal.json`, snapshot 0708, data-import-registry, `payroll-payout-recon.service.ts` (hanya bila perlu) | test-writer A1 (qqsw8): tambah ke `src/test/payroll-payout-q2nkl-lock-waiter.test.ts`; test-writer A2 (1hpqt): tambah ke `src/test/payroll-payout-jsrcs-clear-while-locked.test.ts` |
| B | x2jzq | `apps/api/src/services/payment-recurring.service.ts` | test-writer B: berkas BARU `src/test/payment-recurring-x2jzq-cancel-pending.test.ts` |

Satu implementer memegang A (kartu 1 dan 3 berbagi migrasi 0708: `CREATE OR REPLACE` fungsi; tanpa ubah data). Satu implementer memegang B.

## Kartu 1 qqsw8
Episode timeout masuk identitas flag atau fingerprint (reason/exception 0473, fingerprint 0481/0464). Timeout kedua di hari sama sesudah clearance = flag baru, slip held, clearance lama tidak melepas. Waiter serentak di episode sama tetap satu flag (idempotent). Test: alur q2nkl-lock-waiter dengan day2 = day1 -> slip held, clearance pertama tidak melepas.

## Kartu 2 x2jzq
`CANCEL_PENDING` bertahan pada respons stop tidak terkonfirmasi (200/active tetap CANCEL_PENDING, bukan RESPONSE_MISMATCH). Tiap transisi noncancel (pause, resume, resolve) membaca marker terkini di bawah row lock dan menolak menghapusnya. Test: cancel 500 -> retry 200/active -> resolve dan resume tetap parkir tanpa panggilan resume DOIT; barrier pause tertunda -> cancel gagal/park -> jawaban pause: tetap needs_reconcile/CANCEL_PENDING sampai cancelled terkonfirmasi.

## Kartu 3 1hpqt
Approve clearance (0706/0707): ganti cek `pg_locks` dengan `pg_try_advisory_xact_lock(operationKey)` dipegang sampai transaksi approve selesai; gagal -> PAYOUT-91 409. Test barrier tiga koneksi: 409, approved_at null, slip held, holder operasi masih jalan saat assertion.

## Batas
Jangan sentuh: `payment-webhook*`, `order-given.ts`, `reservation-*`, `edge-*`, `access.service.ts`, `sole-owner-self-approval.ts`, `hris-*`. Migrasi hanya 0708 (butuh lebih: berhenti, lapor). Jangan edit migrasi 0706/0707 yang sudah ada (tulis ulang fungsi di 0708). FK/constraint: ikuti `AGENTS.md`.

## Aturan eksekusi subagent
- Test-writer: tulis test gagal-dulu (sebab yang benar, bukan setup), jalankan SEKALI lewat `LEGEND_TEST_FILES="..." heavy pnpm test` dari root worktree, catat output gagal. Satu eksekutor heavy per thread: test-writer dan implementer jangan jalankan test bersamaan; test-writer duluan, implementer menjalankan setelah test ada.
- Implementer: baca temuan, petakan sendiri file, edit milik potongan saja, jangan commit. Lapor ringkas: file, perubahan, apa yang belum dijalankan.
- Jangan commit/push; agent induk yang commit.

## Ronde 2: legend-t1ufu (P2-1), fail-closed re-raise
Keputusan CTO: hold batal = payout bisa keluar. Aturan: re-raise yang gagal untuk SATU baris tidak boleh membatalkan hold baru dan tidak boleh menggagalkan baris lain sechunk (savepoint per baris); baris gagal tetap tertahan + tercatat error. Counter flagged/reraised boleh berubah; perbarui test lama (`payroll-payout-990-recon-reopen.test.ts` dll). Tanpa migrasi baru (0709 hanya bila wajib).
Kode: `payroll-payout-recon.service.ts` (`reconcileTrustedPayouts` ~2440-2510: `known`/`fresh`; `reraiseKnownFlags` ~2192; `payout-trusted-recon.job.ts` memakai counternya).
Rancangan:
1. Flag `evidence_read_locked:*` yang sudah `known` ikut jalur tulis pertama (bukan jalur re-raise best-effort), supaya episode baru (`#n`) pasti dibuat atau halaman gagal (kursor tidak maju).
2. Kedua jalur memakai savepoint per baris (nested transaction): baris gagal di-rollback sendiri, dicatat (log error tanpa data pribadi), baris lain commit. Di jalur pertama, sesudah commit baris yang berhasil, halaman tetap dilempar gagal bila ada yang gagal (fail-closed, kursor tidak maju). Di jalur re-raise, gagal = dicatat + dihitung `failed`, tidak melempar.
Test gagal-dulu: (a) satu flag gagal di chunk (induksi gagal: mis. trigger/constraint sementara atau reason yang ditolak fungsi) -> baris lain sechunk tetap diproses; (b) timeout kedua di hari sama saat re-raise chunk berisi flag gagal -> slip tetap held (episode baru terbentuk atau halaman gagal tanpa slip bebas).

## Ronde 3: tutup celah hold (legend-t1ufu lanjutan), migrasi 0709
Keputusan CTO: bila tulis flag/episode gagal, slip terkait HARUS tetap tertahan, tanpa bergantung baris di `payroll_payout_recon_exceptions`. Halaman gagal -> slip tidak bisa di-clear/dibayar. Job jangan log `error.cause` utuh (nama/kode saja).
Rancangan (satu migrasi `0709_*.sql`, CREATE OR REPLACE + satu fungsi baru, tanpa ubah data; journal, snapshot, data-import-registry ikut):
1. Fungsi baru `app.payout_recon_hold_unwritten(p_tenant uuid, p_operation uuid) RETURNS void` SECURITY DEFINER, `SET search_path = pg_catalog, pg_temp`, `p_tenant = app.require_tenant_id()` (PAYOUT-68), GRANT hanya `legend_app` (seperti `app.payout_recon_evidence_observe`, 0481). Menyisipkan observasi `state='error'` ke `payroll_payout_recon_evidence_observations` TANPA advisory lock operasi (pemegang lock yang macet tidak boleh menghalangi): lewati bila observasi terakhir operasi itu sudah `error`; `episode` sama aturannya dengan `_internal` (0481: episode observasi non-error terakhir, atau 1).
2. `app.payout_payslip_held_by_recon` (0464:365) diganti: tahan bila ada exception tanpa clearance sesuai fingerprint live (isi lama) ATAU ada item `payroll_disbursement_items` slip itu (`payslip_id`, `operation_id`) yang observasi terakhir operasinya `state='error'`. Rilis hanya lewat observasi non-error berikutnya (ok dari bacaan sukses). Signature, owner, ACL tetap.
3. `app.payout_recon_clear_approve` (0708) sudah menolak bila observasi terakhir `error` (PAYOUT-91) untuk operasi flag itu: pertahankan.
4. Service `payroll-payout-recon.service.ts` `raiseFlagsPerRow`/jalur tulis pertama: untuk tiap flag yang gagal (kunci operationId), sesudah savepoint di-rollback, panggil `app.payout_recon_hold_unwritten` di transaksi sendiri (savepoint per operasi); bila inipun gagal, catat error (nama saja) dan tetap lempar. Sesudah itu halaman dilempar gagal seperti sekarang. Jalur re-raise (known flags gagal) tidak perlu: flag sudah ada.
5. Log: `payout-trusted-recon.job.ts`/`worker-main.ts` (cetak "Payout trusted recon sweep failed") dan error "could not be written": log `errorName` + kode pg (`code`) saja, jangan cetak `cause`/`message` yang bisa memuat parameter query. Ubah `new Error(..., {cause})` agar cause tidak ikut tercetak di log; test bila mudah (spy logger/console).
Test: perketat T3 di `payroll-payout-t1ufu-reraise-failclosed.test.ts` (halaman gagal -> `app.payout_payslip_held_by_recon` true, clear-approve 409, guard bayar menolak); test baru: first-ever flag gagal (tanpa exception sama sekali) -> slip tetap tertahan; observasi ok berikutnya melepas hanya bila tidak ada exception; fungsi baru menolak tenant lain / role lain; test log tanpa cause.

## Ronde 3 REVISI (hasil architect xhigh; menggantikan butir 1, 2, 4 di atas)
Pemetaan slip->operasi lewat data tidak lengkap (P0) dan observasi `error` bisa macet selamanya (P1). Rancangan baru: hold PER ITEM, tanpa observasi.
1. Tabel baru append-only `payroll_payout_recon_unwritten_holds` (tenant_id, id, kind, operation_id, item_id, payslip_id, created_at; FK tenant_id+item_id ke payroll_disbursement_items, FK tenant_id+payslip_id ke payslips; RLS tenant seperti tabel recon lain; SELECT untuk legend_app/legend_payout; tidak ada UPDATE/DELETE; index (tenant_id, payslip_id); UNIQUE (tenant_id, kind, operation_id, item_id)). FK di dalam CREATE TABLE (AGENTS.md). Tambah ke `src/db/schema/payroll-payout.ts` agar `db:generate` kosong.
2. `app.payout_recon_hold_unwritten(p_tenant uuid, p_kind text, p_operation uuid, p_items uuid[]) RETURNS void` SECURITY DEFINER, search_path = pg_catalog, pg_temp, tenant check PAYOUT-68, GRANT hanya legend_app. Menyisipkan satu baris hold per item (payslip dicari di dalam fungsi dari payroll_disbursement_items), ON CONFLICT DO NOTHING. TIDAK menulis observasi, tanpa advisory lock operasi.
3. `app.payout_payslip_held_by_recon`: isi 0464 lama ATAU ada hold untuk payslip itu yang belum diambil alih (tidak ada exception dengan (kind, operation_id, item_id) sama; begitu flag tertulis, exception+clearance yang menentukan). Observasi ok TIDAK melepas hold. Signature/owner/ACL tetap. Tidak ada jalan lepas lain: catat bead untuk pelepasan dua orang.
4. Service `raiseFlagsPerRow`: kumpulkan (kind, operationId, itemId) tiap flag yang gagal; sesudah transaksi flag selesai (commit baris yang berhasil), panggil hold_unwritten di `withTenant` terpisah, lalu lempar gagal (error tanpa cause: nama + kode pg). `worker-main.ts` log nama+kode saja (lihat `scratchpad/r3-first-impl.patch` untuk bagian log yang boleh dipakai).
5. Test: satu kasus per jenis operasi (missing, posting_source, closure, lost resolve, return_withdraw fallback) bila bisa diinduksi, minimal 2 jenis berbeda; hold lepas setelah flag tertulis; TIDAK lepas oleh observasi ok saja; fungsi menolak tenant lain/role lain.
