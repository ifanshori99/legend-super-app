# Brief: engineer (Codex) — kuning karena disk tidak memotong slot (legend-hq9it)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti.

## Repo
Skrip tim di `~/.claude/scripts/` (bukan repo Legend). Cabang: tidak ada; buat cadangan file yang diubah di scratchpad sesi sebelum mengedit.

## Tujuan
Retro 28: 80% sampel mode kuning (122 menit) hanya karena disk < 15 GB padahal RAM longgar, sehingga slot Claude terpotong dari 8 ke 4. Ambang 15 GB (kuning) dan 5 GB (merah) TIDAK diubah, karena itu keputusan founder (legend-h32dy). Yang diubah akibatnya: bila kuning HANYA karena disk (RAM, swap, dan tekanan kernel hijau), maka:
- Batas slot thread dan subagent memakai batas hijau.
- Pembuatan worktree baru (`ghostex coordinator start-thread --worktree`, `git worktree add`) ditolak dengan pesan yang menyarankan `~/.claude/scripts/cleanup-ssd`.
- `ram-guard status` menulis alasan "kuning (disk)".
Merah karena disk (< 5 GB) dan `heavy` yang menolak job di bawah 3 GB tetap seperti sekarang.

## Kartu (agent Codex tidak menjalankan bd)
legend-hq9it (P1).

## Scope
- Boleh: `~/.claude/scripts/ram-guard`, hook penjaga slot/worktree yang membaca modenya (cari dengan Grep di `~/.claude/scripts` dan `~/.claude/hooks`), serta test di `~/.claude/scripts/tests/`.
- Jangan: ambang angka, `heavy` antrean, skrip lain.

## Bukti selesai
- Test baru di `~/.claude/scripts/tests/` untuk kuning-disk-saja (slot hijau, worktree ditolak) dan kuning-RAM (slot kuning). Semua `~/.claude/scripts/tests/*.sh` lulus.
- `~/.claude/scripts/ram-guard status` dijalankan sekali, outputnya dicantumkan.

## Batas kerja ulang
- Jangan `pkill`/`killall`, jangan hentikan sampler yang berjalan (restart sampler hanya dengan cara yang didokumentasikan skrip). Jam dari `date '+%H:%M'`.

## Laporan
Hasil, bukti test, file berubah (dengan lokasi cadangan), risiko. Wajib baris: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
