# 535 Second-opinion Codex area WS-05 uang (refund, void, pay-admin, sarapan)
Peran: second-opinion (~/.agents/team/roles/second-opinion.md). Read-only, jangan ubah file.
Cabang (worktree di .worktrees/<nama>): ws/pos-refund-ceilings ffb47d9a, ws/ws05-pay-admin 5cb6daf1, ws/breakfast-pay c7a57878. Bandingkan masing-masing dengan origin/milestone/m1 (7917440a).
Aturan bisnis: Q63 batas refund Supervisor <=200rb, manajer outlet <=1jt, GM <=5jt, di atasnya owner, kumulatif semua jalur (void tunai dihitung refund); Q67 refund/void di kasir offline ditolak sampai pusat; total uang keluar <= dibayar. Aturan founder: tidak ada pihak dibayar lebih, outlet tidak rugi.
Cari: bayar ganda, lolos batas, race, fail-open, idempotensi, migrasi 0340-0341 (index + data matriks). Laporan: P0-P3, file:line, skenario, fix. Maks 500 kata.
