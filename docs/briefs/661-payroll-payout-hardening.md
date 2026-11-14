# Brief: engineer — pengerasan payout gaji (legend-8codi, legend-qxkm6)

Peran: baca `~/.agents/team/roles/engineer.md`. Model Sonnet. Area uang + akses: "jangan sampai rugi".

## Konteks
`ws/payroll-payout-gl` (83892702e) memposting jurnal payout per item, fee ke beban bank (8101), step-up password. Keputusan CTO 14 Nov ada di deskripsi bead:
- `legend-8codi`: tolak approve/export batch bila mapping `bank_charges` atau akun bank sumber belum ada (gagal tertutup sebelum uang keluar); simpan `fee_posted=false` + daftar untuk finance re-post sebagai cadangan.
- `legend-qxkm6`: route HTTP untuk `returnManualItems` (izin `payroll.disburse.approve`, step-up MFA + password, dua orang selain pembuat); jurnal overpaid; kembalikan guard dua orang di trigger DB untuk `succeeded -> returned` langsung dan perbaiki test L4 lama, bukan melonggarkan trigger.

## Repo
Worktree dari `origin/ws/payroll-payout-gl`: `git worktree add .worktrees/payout-hard-661 -b ws/payroll-payout-hardening origin/ws/payroll-payout-gl`, `pnpm worktree:setup`. Migrasi rentang **0542-0545**.

## Test gagal-dulu
Approve/export ditolak tanpa mapping; fee yang dilewati tercatat dan bisa di-re-post tepat sekali; return lewat HTTP butuh dua orang + step-up dan membalik jurnal tepat sekali ke akun asal; overpaid tercatat tanpa membayar lebih; update SQL langsung `succeeded -> returned` tanpa dua orang ditolak trigger.

## Review
Tingkat K: satu subagent `architect` effort xhigh, maks 2 ronde.

## Bukti selesai
Test terarah payroll/accounting lewat `heavy`, typecheck api (+ web bila tersentuh) lewat `heavy`, prettier + eslint, text-contract bila ada teks baru, `db:generate` kosong, registry migrasi. Push tanpa force. `bd update --status review` + `bd comment`.

## Batas
Jangan merge, deploy, `pkill`, `pnpm test` penuh. Maks 4 subagent bersamaan.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
