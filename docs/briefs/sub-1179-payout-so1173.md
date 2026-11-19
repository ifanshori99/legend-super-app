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
