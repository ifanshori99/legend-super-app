# 529 Uji pasang rtk dan graphify untuk workflow tim (infra, tingkat S)

Peran: engineer (~/.agents/team/roles/engineer.md), Sonnet. Tujuan: kurangi token output perintah dan bacaan file tanpa merusak hook yang ada. Jangan ubah kode produk Legend.
Konteks: `rtk` (/opt/homebrew/bin/rtk) sudah terpasang tapi hook belum (`rtk gain`: 21 perintah manual, hemat 98,5%). `graphify` (~/.local/bin/graphify) terpasang, belum dipakai di Legend. caveman sudah aktif.

A. rtk (prioritas):
1. `rtk init --show` dan baca `~/.claude/settings.json` hooks PreToolUse Bash yang ada (heavy guard, agent-nudge, ram-guard, deny rules). Tentukan urutan: rtk rewrite tidak boleh membuat hook `heavy` lolos atau menolak salah (mis. `pnpm test` jadi `rtk pnpm test` tanpa `heavy`, atau `heavy pnpm test` jadi tidak dikenali).
2. Uji di sesi uji terpisah (bukan mengubah global dulu): pasang hook di settings proyek sementara atau dengan `exclude_commands` untuk `heavy`, `ghostex`, `bd`, `git push`, `git commit`. Bukti: `~/.claude/scripts/tests/test-delegation-enforce.sh` dan test hook heavy tetap lulus; satu test gagal sengaja tetap menampilkan nama test + pesan assertion.
3. Telemetry mati (`RTK_TELEMETRY_DISABLED=1`). Pakai binary default hanya bila lisensi BUSL tidak masalah untuk pemakaian internal; catat.
4. Bila lulus: `rtk init -g` dengan pengecualian di atas. Catat di ~/.agents/team/TEAM.md bagian "Hemat waktu dan token" satu baris cara bypass (`RTK_DISABLED=1`).
B. graphify (uji coba, jangan dipasang global):
1. `graphify` di worktree baru dari origin/milestone/m1 dengan `--code-only` (tidak ada kode/dokumen dikirim ke API luar). Ukur waktu index, RAM puncak (`heavy` bila berat), ukuran output. Jangan commit graphify-out.
2. Bandingkan 3 pertanyaan nyata (mis. "siapa memanggil payment-refund.service failRefund", "alur kirim ke dapur sarapan", "di mana idempotencyKeySchema dipakai") lewat graphify query vs Explore subagent: token dan ketepatan.
3. Jangan pasang hook `--strict` atau instruksi always-on. Rekomendasi pakai/tidak dengan angka.
Laporan akhir: apa yang dipasang, bukti test hook, angka hemat, rekomendasi graphify, cara rollback. Satu laporan; tunggu job latar dengan Monitor di giliran yang sama.
