# 769 Edge KDS: sinkron stations + status pemindai (legend-i78o6, legend-40nvj)
Peran: engineer (Claude Sonnet high). Base: milestone/m1 (sudah memuat batch 64b: KDS station save, routing inactive). Cabang: ws/edge-kds-stations. Migrasi: bila perlu, pakai nomor 0366-0367 saja dan lapor.
Langkah 0 (Explore paralel): cara kerja sinkron master data cloud->edge sekarang (Grep "setEdgeEventApplier\|cloud_to_edge" di apps/api/src), apakah legend-3x9l (down-sync applier) sudah ada di base. Bila i78o6 butuh 3x9l yang belum ada: lapor dan berhenti sebelum menulis kode.
Kartu:
- legend-i78o6: perubahan stations (display_order, is_active, auto_print_fallback) ikut sinkron ke edge. Test: ubah di cloud -> event keluar -> edge menerapkan; urutan dan idempotensi (event ganda tidak merusak).
- legend-40nvj: status pemindai KDS dilaporkan device shell/edge agent. Ini kontrak edge baru: tulis usulan kontrak singkat dulu (docs/design/edge-kds-scanner-status.md: payload, frekuensi, siapa membaca), lalu implementasi bila tidak menyentuh auth perangkat. Bila menyentuh auth/pairing perangkat: berhenti setelah usulan, lapor.
Review: tingkat S reviewer sonnet; bila menyentuh auth perangkat atau migrasi: architect high.
Aturan umum: baca ~/.agents/team/roles/engineer.md dan "Paralel dulu" di ~/.agents/team/TEAM.md. Kerja berat lewat `heavy`, satu job sekaligus. Test bukti gagal-dulu. Pra-gate AGENTS.md. Commit, push cabang tanpa force, jangan merge. Lapor angka subagent.
