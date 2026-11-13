# Brief: engineer — perbaikan temuan Codex login ChatGPT (cek ulang owner)

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat K (auth/akses).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `fix/ai-login-review` (3ba2911a). Push ke `origin` sebagai `fix/ai-owner-recheck`.

## Kartu (keputusan sudah diambil CTO; jangan ditanyakan)
`legend-80oot`: `apps/api/src/services/ai-chatgpt.service.ts:782` owner penyetuju hanya dicek sebelum refresh token. Bila peran owner dicabut saat refresh menunggu jaringan, token baru tetap disimpan dan dipakai. Benar: cek ulang assignment owner aktif di transaksi simpan (di bawah lock baris koneksi). Bila hilang: putus koneksi, revoke token baru (best-effort setelah commit), tolak permintaan. Jalur gagal tidak boleh fallback ke API key tenant.

`bd update legend-80oot --status in_progress` di awal; lapor `--status review` + `bd comment`.

## Pembagian paralel
test-writer (test gagal-dulu: owner dicopot di tengah refresh -> token tidak disimpan, koneksi terputus), implementer (ai-chatgpt.service.ts), satu `architect` effort xhigh atas diff, satu `test-runner` pemegang heavy.

## Bukti selesai
Gagal-dulu lalu hijau via `heavy env LEGEND_TEST_FILES="..." pnpm test` (test baru + test AI ChatGPT terkait); typecheck api via `heavy`; prettier + eslint. Tanpa migrasi. Jangan login ChatGPT nyata.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy; jangan sentuh `apps/web`. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
