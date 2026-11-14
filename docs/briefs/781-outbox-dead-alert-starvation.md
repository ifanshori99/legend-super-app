# 781 Outbox dead alert: alarm lama tidak boleh kelaparan (legend-o2iul)
Peran: engineer (Codex, kartu S, backend tanpa uang). Basis: worktree dari origin/milestone/m1. Tidak ada migrasi kecuali benar perlu (nomor bebas 0373).
Masalah: `bd show legend-o2iul` dan docs/qa/second-opinion-edge-64d.md (P2, core-outbox-dead-alert.ts:108).
Bukti: test gagal-dulu: tiap sweep mendapat blocked head baru, alarm lama tetap dicoba ulang dalam N sweep / batas waktu; tidak ada kirim ganda per alarm. Test terarah lewat `LEGEND_TEST_FILES=... heavy pnpm test`, typecheck api sekali lewat heavy, prettier/eslint. Satu reviewer subagent.
Commit+push ke cabang kerja, jangan merge. Lapor: berkas, test, angka subagent.
