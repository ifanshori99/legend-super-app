# Brief: engineer (Codex) — race reversal vs payout retur DP (legend-ayz7q)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md`.

## Kartu
`bd show legend-ayz7q` (temuan second opinion, P2). `apps/api/src/services/accounting-auto-journal-guards.ts:801`: worker membaca jurnal retur sebagai `posted`, finance membaliknya, worker tetap memposting payout. Contoh: DP/penjualan Rp50.000, retur Rp25.000 → saldo debit `customer_deposit` Rp25.000 tersisa.

## Tujuan
1. Test gagal-dulu: dua transaksi bersamaan (reversal finance vs worker payout retur) di DB nyata; buktikan saldo debit tersisa sebelum fix.
2. Fix: samakan protokol lock — pembacaan sumber dana di worker dan reversal mengunci baris yang sama dengan urutan yang sama (mis. `SELECT ... FOR UPDATE` pada jurnal sumber, cek ulang status setelah lock). Bila sumber sudah dibalik: payout tidak diposting, kewajiban tidak tercipta.
3. Test sesudah fix: urutan apa pun, tidak ada pihak dibayar lebih, jurnal seimbang, `customer_deposit` tidak bersaldo debit.

## Repo
Worktree dari Ghostex basis `ws/loyalty-dp` (72bf7b71). Cabang `ws/loyalty-dp-race`. Push cabang boleh. Tanpa migrasi kecuali terbukti perlu (0412-0413).

## Bukti selesai
- Race test lulus 3x berturut, test accounting terkait lulus, typecheck api.
- Satu subagent architect effort xhigh (uang) mereview diff.
- Jangan `pnpm check` penuh, jangan sentuh milestone/m1 atau main, jangan deploy.
