# 803 Kontras tombol outline di status bar gelap shell operasional (tingkat S, UI kecil)
Peran: ui-engineer (Codex). Baca ~/.agents/team/roles/ui-engineer.md dan ~/.agents/team/ui-standard.md. Codex tidak menjalankan bd.
Kartu legend-1d0yz (deskripsi di `.beads/issues.jsonl`, cari "legend-1d0yz"): tombol outline di status bar gelap shell operasional kontras 2,7:1 (< 3:1). Pertimbangkan variant secondary. Ukur juga tinggi status bar di lebar 390px dengan picker outlet.
Basis: worktree dari `origin/ghostex/780-ui-operasional-kecil` (sudah disetujui founder). Cabang `fix/ops-statusbar-contrast`.
Bukti: rasio kontras baru >= 3:1 (sebutkan angkanya), screenshot 390 dan 1280 lewat `heavy` (`ghostex visual check` atau Playwright), tinggi status bar 390px dilaporkan. Teks UI baru masuk katalog (`node --test tests/text-contract.test.mjs`).
Selesai: prettier, eslint, typecheck web lewat `heavy`, commit, push. Laporan: SHA, rasio, path screenshot, angka subagent. Jangan merge ke m1.
