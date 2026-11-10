# Brief: engineer — perbaikan temuan Codex profit share distribusi (legend-33im6)

## Peran
Baca `~/.agents/team/roles/engineer.md` lalu ikuti. Uang dan akses: kerja dengan Opus high.

## Worktree
`.worktrees/8s992` (cabang ws/8s992-profit-rules, HEAD 0033ea1d). Commit di cabang yang sama.

## Tujuan
Tutup 2 temuan second-opinion Codex (brief 377). Tiap temuan: test gagal-dulu, lalu fix.
1. P1 `apps/api/src/services/profit-share-distribution.service.ts:1128`: approval melewati matriks; pengguna selain pembuat yang punya izin approve bisa menyetujui nominal yang butuh approver tertentu atau beberapa tingkat. Fix: saat submit buka approval chain dari matriks approval yang sudah ada (pakai service approval yang dipakai modul lain, jangan buat baru); status `approved` hanya setelah chain selesai.
2. P2 `profit-share-distribution.service.ts:803`: clawback parsial berulang mengembalikan pajak melebihi potongan. Contoh: distribusi Rp1.000.000 pajak 10%, koreksi -Rp499.995 dua kali lalu -Rp5, total pajak kembali Rp100.001; koreksi -Rp5 menghasilkan pajak positif dan melanggar constraint. Fix: alokasi kumulatif, pengembalian pajak dibatasi sisa potongan; koreksi terakhir mengambil sisa persis.

## Cakupan
Berkas di atas, test-nya, helper langsung. Migrasi bila wajib: 0252, jangan menomori ulang.

## Bukti
- Test baru kedua skenario gagal sebelum fix, lulus sesudah; test profit share lain tetap hijau.
- `heavy` typecheck api, test file profit share. Batas Retro 11: 2x gagal typecheck, baca log.
- Satu subagent architect xhigh mereview diff fix.

## Laporan
Commit SHA, test ditambah, hasil typecheck/test, temuan architect dan penanganannya.
