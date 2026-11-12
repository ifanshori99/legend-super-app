# 550 Second-opinion Codex: area CRM/promo dan inventory/pembelian
Peran: second-opinion (~/.agents/team/roles/second-opinion.md). Read-only, jangan edit/commit. Jangan jalankan `heavy` (antrean Mac penuh); baca kode saja, test hanya bila sangat perlu dan tunggu antrean.
Cabang vs origin/milestone/m1: ws/ws08-crm (1b0ba72b, worktree .worktrees/ws08-crm), ws/ws06-purchasing (9378da96, worktree .worktrees/ws06-purchasing).
Keputusan final (jangan diusulkan ulang): refund sebagian pesanan multi-promo dengan snapshot lama tanpa prioritas ditolak 409, refund penuh tetap boleh.
Cari: refund promo membayar lebih dari yang dibayar pelanggan (tender + DP), urutan promo saat refund, FK komposit lintas tenant/outlet, izin loyalty ganda, foto waste privat (akses lintas tenant/outlet, URL bocor), migrasi 0371/0376/0377 aman di data lama, nama staf bocor lintas outlet, saran AI purchasing tanpa batas. Laporan: P0-P3, file:line, skenario, fix. Maks 400 kata.
