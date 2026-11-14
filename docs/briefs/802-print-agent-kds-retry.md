# 802 Print agent: retry alert tahan restart + fallback KDS (2 kartu, tingkat S)
Peran: engineer (Codex, kartu S). Baca ~/.agents/team/roles/engineer.md. Codex tidak menjalankan bd; CTO memindah kartu.
Basis: worktree dari `origin/fix/print-alert-supervisor` (7fcfdb369). Cabang `fix/print-agent-kds-retry`.
1. legend-ge9ur: alert di `edge_print_alerts` yang gagal di-enqueue (dua kali) ditandai belum terkirim; sweep periodik di agent print meng-enqueue ulang dengan event id yang sama (dedupe), tahan restart. Test: enqueue gagal, restart, sweep mengirim tepat satu `print_alert.raised`.
2. legend-2lp.3: layar KDS mengirim heartbeat ke `getEdgePrintAgent().recordKdsHeartbeat(stationId)`; tiket stasiun baru lewat `routeStationTicket()` (cetak dengan banner KDS mati bila layar diam > 15 detik); backlog tiket belum di-bump dicetak saat stasiun mati. Baca `bd`-nya tidak bisa: deskripsi lengkap ada di `.beads/issues.jsonl` (cari "legend-2lp.3"). Bila kode KDS yang dibutuhkan belum ada di basis ini, jangan mengarang: kerjakan kartu 1 saja dan laporkan apa yang kurang.
Paralel: subagent per kartu (file terpisah), satu reviewer.
Tanpa migrasi kecuali perlu; bila perlu nomor 0378 dan laporkan. Jangan sentuh panik, DOIT, payout, HRIS, `edge-master-data-publisher`.
Selesai: test terarah lewat `heavy`, prettier, eslint, typecheck API lewat `heavy`, commit, push. Laporan: SHA, test, angka subagent (total, puncak, pemegang token heavy). Jangan merge ke m1.
