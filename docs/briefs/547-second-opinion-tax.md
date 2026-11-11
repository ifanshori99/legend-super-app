# 547 Second-opinion Codex area akuntansi dan pajak
Peran: second-opinion (~/.agents/team/roles/second-opinion.md). Read-only.
Cabang: ws/ws07-tax-reports (6f9087b9), worktree .worktrees/ws07-tax-reports. Bandingkan dengan merge-base origin/milestone/m1.
Isi: laporan keuangan 5 jenis, pajak penjualan per jenis (0355), refund pajak dibatasi per pesanan (0356 + backfill), sumber laporan PPh 21/PPh 23/PPN (0357-0358, supplier_invoices).
Cari: refund pajak melebihi yang dipungut, jurnal tidak seimbang, PPN setor salah (keluaran-masukan), PPh 21 tidak cocok slip, kebocoran lintas tenant/outlet, backfill 0356 salah pada data nyata, supplier_invoices bisa diubah. Laporan P0-P3, file:line, skenario, fix. Maks 400 kata.
