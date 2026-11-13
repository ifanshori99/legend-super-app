# Brief: engineer — GL posting payout gaji per item + step-up bukti (legend-wnkep.5, legend-f5n9y)

Peran: baca `~/.agents/team/roles/engineer.md`. Model Sonnet. Area uang + akses: "jangan sampai rugi".

## Konteks
Kanal gaji manual BCA sudah di m1 (batch59, migr 0343-0346). Desain: `docs/design/payroll-disbursement.md` bagian 8 (slice BE-4). Founder Q15: biaya transfer Rp5.000 ditanggung PT (beban bank), karyawan terima utuh. Q16: manual dulu, Duitku mati.

## Keputusan CTO (14 Nov)
- `paid_by` = penyetuju terakhir batch (sesuai desain), bukan pengonfirmasi. Pengonfirmasi tetap dicatat di kolom/audit sendiri.
- Fee manual: dijurnal otomatis per item `succeeded` ke beban bank (debit beban bank, kredit kas/bank sumber) dari nilai fee yang tersimpan per item; tidak dipotong dari gaji. Finance tidak perlu mencatat terpisah.

## Repo
Worktree dari `milestone/m1` (b17554cb9): `git worktree add .worktrees/payout-gl-658 -b ws/payroll-payout-gl milestone/m1`, `pnpm worktree:setup`. Migrasi rentang **0534-0537** (bead menyebut 0534).

## Kerja
1. wnkep.5: jurnal per item payout (settle di bawah advisory lock batch, key `payroll-payout:<item_set_hash>`, tautkan item di transaksi yang sama); jurnal fee, return (`failed` setelah `succeeded`), dan overpaid; `payroll.paid` dengan `settledPerItem` tidak memposting apa pun di level run (cegah kredit ganda). Kirim event `payroll.paid`.
2. f5n9y (L5): kunci bukti pembayaran diikat ke storage tenant; step-up untuk resolve/konfirmasi minta ulang password bila `mfa_verified_at` hanya dari pendaftaran MFA pertama.

## Test gagal-dulu
Total kredit = jumlah gaji bersih tepat sekali; replay/konfirmasi ganda tidak menggandakan jurnal; fee hanya ke beban bank dan tidak mengurangi gaji; return membalik tepat sekali; run-level `paid` tidak memposting lagi; tenant lain tidak tersentuh; bukti tenant lain ditolak.

## Review
Tingkat K: satu subagent `architect` effort xhigh, maks 2 ronde.

## Bukti selesai
Test terarah payroll/accounting lewat `heavy`, typecheck api (+ web bila tersentuh) lewat `heavy`, prettier + eslint, `db:generate` kosong, registry migrasi. Push tanpa force. `bd update --status review` + `bd comment`.

## Batas
Jangan merge, deploy, `pkill`, `pnpm test` penuh. Maks 4 subagent bersamaan.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
