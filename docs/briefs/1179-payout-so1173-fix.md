# 1179 Fix SO 1173 payout recon + DOIT recurring (engineer, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (test-writer per kartu; implementer kartu 2 paralel dengan satu implementer kartu 1+3 karena migrasi sama).
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs --full && heavy pnpm worktree:setup` (ada migrasi).

Base: `ws/1175-approval-payout-p3` (e35d52a76, memuat 1164 + migrasi kerja 0707). Cabang kerja: `ws/1179-payout-so1173-fix`. Tingkat K (uang + migrasi): architect effort xhigh sebelum lapor. Migrasi kerja: 0708 saja (CREATE OR REPLACE fungsi; tanpa ubah data; journal, snapshot, data-import-registry ikut).
Temuan: `docs/qa/second-opinion-payout-doit-approval-1173.md` (skenario, berkas:baris, perbaikan, usul test). Semua keputusan CTO membatasi pembayaran: bila ragu, slip tetap ditahan dan tagihan tidak dilanjutkan.

## Kartu (baca `bd show <id>`)
1. `legend-qqsw8` timeout lock kedua pada hari sama: episode timeout masuk identitas flag atau fingerprint, sehingga clearance lama tidak melepas slip; waiter serentak di episode sama tetap satu flag. Test: ulang alur `payroll-payout-q2nkl-lock-waiter.test.ts` dengan day2 = day1 -> slip held, clearance pertama tidak melepas.
2. `legend-x2jzq` `payment-recurring.service.ts`: `CANCEL_PENDING` bertahan pada respons stop tidak terkonfirmasi (200/active -> tetap CANCEL_PENDING, bukan RESPONSE_MISMATCH yang menghapusnya); tiap transisi noncancel (pause, resume, resolve) membaca marker terkini di bawah row lock dan menolak menghapusnya. Test: cancel 500 -> retry 200/active -> resolve & resume tetap parkir tanpa panggilan resume DOIT; barrier pause tertunda -> cancel gagal/park -> jawaban pause: tetap needs_reconcile/CANCEL_PENDING sampai cancelled terkonfirmasi.
3. `legend-1hpqt` 0706/0707 approve clearance: ganti cek `pg_locks` dengan `pg_try_advisory_xact_lock(operationKey)` dipegang sampai transaksi approve selesai; gagal -> PAYOUT-91 409. Test barrier tiga koneksi sesuai laporan: 409, approved_at null, slip held, holder masih jalan saat assertion.

## Batas
- Jangan sentuh: `payment-webhook*`, `order-given.ts`, `reservation-*`, `edge-*`, `access.service.ts`, `sole-owner-self-approval.ts`, `hris-*`.
- Migrasi hanya 0708. Butuh lebih: berhenti dan lapor ke CTO.

## Bukti selesai
Test gagal-dulu per kartu (terarah lewat `heavy`), test lama area payout recon/recurring tetap hijau, typecheck api lewat `heavy` sekali dengan exit code di laporan, prettier + eslint file berubah, `db:generate` kosong. Tunggu job heavy dengan Bash run_in_background (notifikasi exit); jangan akhiri giliran dengan kabar tunggu. Commit dan push ke cabang kerja.

## Laporan
SHA, kartu selesai, jumlah subagent dan puncak bersamaan, hasil gate, temuan architect dan fixnya, yang belum teruji. Lapor sekali.
