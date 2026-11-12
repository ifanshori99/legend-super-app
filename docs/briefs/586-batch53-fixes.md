# Brief: engineer (Codex) — perbaiki 3 penghalang batch53

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md`.

## Repo
Worktree Ghostex basis `int/batch53` (dda688e4 = m1 5cbe2a1e + ws/dheu-m1 + ws/loyalty-dp-m1, migrasi sudah dinomori 0309-0313). Kerja di cabang `fix/batch53-blockers`. Catatan merge train: `docs/PROGRESS.md` (bagian batch53).

## Tiga penghalang (dari `heavy pnpm check`: 21 gagal / 15.986 lulus)
1. **legend-4ztnz** (15 gagal, tingkat K migrasi): upgrade dari DB m1 sebagai pemilik biasa (tanpa BYPASSRLS/superuser) gagal `42501` di `apps/api/drizzle/0312_public_tarantula.sql:20` saat validasi FK ke `outlets`. Cari akar: kemungkinan VALIDATE CONSTRAINT/ADD FK ke tabel ber-RLS FORCE butuh hak lain. Perbaiki dengan pola yang sudah dipakai migrasi m1 sebelumnya untuk FK ke tabel ber-RLS (Explore cari contoh). SQL migrasi yang sudah di m1 jangan diubah; hanya 0309-0313 (belum pernah diterapkan di luar lokal) yang boleh diubah, journal + snapshot konsisten, `db:generate` kosong.
2. **legend-fszig** (2 gagal): test progres/reward misi loyalty. Cari apakah penyebabnya perubahan poin per PT (Q80) vs fixture lama atau bug nyata. Bug nyata di jalur uang/poin: perbaiki dengan test bukti tidak ada poin berlebih. Bila hanya fixture: perbaiki fixture, jangan longgarkan assertion.
3. **legend-fesa8** (4 gagal): hitungan laporan rotasi kunci (dheu). Sama: bedakan fixture vs bug, jangan longgarkan assertion.

## Pembagian paralel
3 Explore (satu per penghalang) → 3 implementer (file terpisah) → test-runner tunggal pemegang heavy. Satu subagent architect effort xhigh hanya untuk perbaikan migrasi (4ztnz).

## Bukti selesai
- Test gagal-dulu sudah ada (21 merah); tunjukkan hijau: `LEGEND_TEST_FILES="<7 file gagal>" heavy pnpm test`, plus upgrade dari DB m1 sebagai pemilik biasa lulus.
- Pra-gate AGENTS.md hijau. Commit + push `fix/batch53-blockers` tanpa --force. Jangan merge ke m1 (merge train lanjut sesudahnya). Jangan jalankan `pnpm check` penuh.
- Lapor SHA, akar tiap penghalang, angka subagent.
