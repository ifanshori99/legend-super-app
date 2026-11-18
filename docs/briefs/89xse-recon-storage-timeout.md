# Brief legend-89xse: timeout storage.get + advisory lock di payout recon

Kode: `apps/api/src/services/payroll-payout-recon.service.ts`, blok "The stored proof read again..." di `reconcileTrustedPayouts` (~baris 1936-1989).

## Masalah
Per operasi, satu `withTenant` transaksi: `pg_advisory_xact_lock(...)` lalu `storage.get` lalu `recordReadOk` / `app.payout_recon_evidence_observe`. `storage.get` menggantung = lock advisory + 1 koneksi pool tertahan; run lain di operasi sama menunggu lock tanpa batas.

## Aturan (keputusan CTO, fail closed, tanpa tebak)
1. `storage.get` dibungkus timeout (`Promise.race` + timer yang dibersihkan; `ObjectStorage.get` tidak punya AbortSignal). Timeout = state `"error"` (sama dengan bacaan gagal lain): `app.payout_recon_evidence_observe(..., 'error', ...)` dicatat di transaksi yang sama, `unreadable += 1`, slip ditahan seperti qh11l. Promise storage yatim diberi `.catch(() => {})` supaya tidak ada unhandled rejection. Transaksi selesai normal: lock dan koneksi pool lepas.
2. Lock advisory: `SET LOCAL lock_timeout = '<ms>ms'` sebelum `pg_advisory_xact_lock`. Error 55P03 (lock_not_available) ditangkap DI LUAR `withTenant` per operasi: state operasi itu = `"error"` di `fileOf`, `unreadable += 1`, log tanpa data pribadi (`logger.error`/warn dengan errorName saja), lanjut operasi berikut. Tidak ada observasi yang ditulis (observe butuh lock yang sama; pemegang lock mencatat hasilnya sendiri, dibatasi timeout storage). Error lain tetap melempar (fail closed seperti sekarang).
3. Nilai: konstanta ekspor `PAYOUT_RECON_STORAGE_READ_TIMEOUT_MS = 15_000`, `PAYOUT_RECON_LOCK_TIMEOUT_MS = 30_000` (lock harus > storage supaya pemegang lock sempat mencatat). Override untuk test lewat `PayoutReconOptions`: `storageTimeoutMs?`, `lockTimeoutMs?`.
4. Tanpa migrasi baru kecuali perlu (rentang 0679). Tanpa ubah perilaku jalur normal.
5. Bukan sekadar timeout storage: bacaan yang selesai tepat sebelum timeout tetap dihitung normal (ok/mismatch/missing).

## Bukti test (fail-first), file baru `apps/api/src/test/payroll-payout-89xse-storage-timeout.test.ts`
Fixture: tiru `payroll-payout-1057-clearance-stale-evidence.test.ts` (dunia dengan operasi + bukti) dan `payroll-payout-1052-evidence-order.test.ts` (storage wrapper yang bisa menahan `get`).
- T1: storage `get` tidak pernah selesai; `reconcileTrustedPayouts(context, {storage, storageTimeoutMs: 200})` selesai (tidak menggantung), `unreadable >= 1`, observasi terakhir operasi = `error`, slip `app.payout_payslip_held_by_recon` = true; sebelum fix test ini timeout/menggantung (pakai batas test sendiri, mis. race 5 s, supaya gagal-dulu cepat dan tidak membekukan suite).
- T2: setelah T1, tidak ada lock advisory tertahan (`pg_locks` advisory untuk key operasi) dan koneksi pool bebas (`pool.waitingCount`/`idleCount` atau jalankan query dari pool setelahnya) .
- T3: run A menahan lock (storage menggantung, timeout panjang) lalu run B untuk operasi sama dengan `lockTimeoutMs: 300`: B selesai, `unreadable >= 1`, tidak melempar, tidak menulis observasi baru; setelah A dilepas, A selesai normal.
- T4: setelah storage timeout, bacaan berikut yang sukses (`ok`) melepas slip lagi sesuai aturan qh11l (recon role) - jalur pulih tetap jalan.
Jalankan: `LEGEND_TEST_FILES="src/test/payroll-payout-89xse-storage-timeout.test.ts" heavy pnpm test` dari `apps/api`? (ikuti CLAUDE.md: dari root worktree). Pertama kali di worktree: `heavy pnpm worktree:setup`.
