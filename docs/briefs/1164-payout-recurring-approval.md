# 1164 brief (engineer, 19 Nov)

Cabang: `ws/1164-payout-recurring-approval`. Tanpa migrasi. Jangan sentuh: `payroll-payout-gl.service.ts`, `payment-admin*`, `order-given.ts`, `accounting-journal*`. Tingkat K (uang + akses): aturan restriktif, bila ragu batasi pembayaran. Tes terarah: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` dari `apps/api`/root worktree (lihat CLAUDE.md "Test terarah"). Tes harus gagal dulu karena sebab yang benar.

## Kartu A: legend-q2nkl (recon payout)
File: `apps/api/src/services/payroll-payout-recon.service.ts`, `apps/api/src/db/index.ts` bila perlu. Prasyarat e7d803748 sudah di base.
Masalah: waiter yang kena `lock_timeout` 55P03 melewati operasi tanpa observasi; slip bertahan di catatan terakhir (bisa 'ok') selama pemegang lock macet.
Maunya: waiter timeout tidak melewatkan recon (catat bacaan unreadable/hold lewat jalur yang tak butuh lock yang sama, ATAU batasi umur 'ok' terakhir) dan tidak membayar ganda. Plus listener error per koneksi di `db/index.ts` + test `pg_terminate_backend` pada pemegang lock.

## Kartu B: legend-ww562 (DOIT recurring)
File: `apps/api/src/services/payment-recurring.service.ts` (~:118 `defaultClientFor`), `apps/api/src/config/env.ts` (~:268), rute `payment-recurring.routes.ts:34`.
Maunya: cek `DOIT_RECURRING_ENABLED` juga di service: throw `SERVICE_UNAVAILABLE` bila flag mati. Test: flag mati, pemanggil service langsung (job/consumer) ditolak. P3 opsional: env.ts:268 blankToUndefined.

## Kartu C: legend-k8g62 (platform-approval)
File: `apps/api/src/services/platform-approval.service.ts` (~:1357).
Maunya: muat ulang peran/jangkauan approver sesudah `lockChain`. Test: peran dicabut di antara cek awal dan lock -> approval ditolak.

## Keputusan engineer (tanpa migrasi)
- Kartu A: `observe` butuh advisory lock yang sama dengan pemegang macet, jadi 'error' tak bisa ditulis oleh waiter. Tanpa migrasi: waiter yang kena 55P03 menaikkan flag `app.payout_recon_flag` (tanpa advisory lock, kolom reason teks bebas) dengan reason baru `evidence_read_locked` untuk tiap terminal item operasi itu (state file baru `"locked"` di `FileState`, `evaluate` -> `addAll("evidence_read_locked")`). Flag menahan slip sampai ditutup dua-orang. Tambah ke tipe `PayoutReconReason`. Ubah T3 di `payroll-payout-89xse-storage-timeout.test.ts` ("tanpa observasi") hanya bila bertentangan; jelaskan.
- Kartu A, db/index.ts: tambah `pool.on("connect", c => c.on("error", ...))` log tanpa data pribadi, agar backend dimatikan (`pg_terminate_backend`) pada koneksi yang sedang dipinjam tidak jadi unhandled 'error'.
- Kartu B: flag + rute sudah ada di worktree (cherry-pick 64d5d345e dari m1; base belum memuatnya). Tambah gerbang di service.
