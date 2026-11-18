# Brief: engineer — tiga kartu kecil (c3prg, 85qyi, 5eveh)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo dan worktree
Worktree Ghostex milikmu (base `milestone/m1`). Disk < 15 GB: langkah 0 jalankan
`node ~/.claude/scripts/worktree-slim.mjs && git sparse-checkout add docs/design/screenshots/legend-zx8k && heavy pnpm worktree:setup`.
Migrasi: tidak ada (jangan buat migrasi).

## Kartu
Di awal: `ghostex board associate <id>` dan `bd update <id> --status in_progress` untuk ketiganya. Saat lapor: `--status review` + `bd comment`.

1. `legend-c3prg` (S, docs/deploy): tambah `SSR_SHARED_SECRET` dan `WEB_TRUST_PROXY_HOPS` ke `deploy/single-vm/*.example` dan checklist `docs/deployment.md`; origin hanya menerima IP Cloudflare (catat langkahnya di checklist). Nilai contoh placeholder, bukan rahasia. Cek arti env di `apps/web` / `apps/api` config supaya dokumen benar.
2. `legend-85qyi` (S, apps/api): cek `apps/api/src/**/tenant-config-core.ts` (~:285) apakah import `loyalty_policy` masih `unsupportedSection`. Bila masih: jangan bangun handler; tambah test kontrak bahwa codec config tidak membawa `legalEntityId` (atau tidak pernah menulis null) dan komentar penjaga di titik handler nanti; cek apakah ada baris `config_templates` seed/fixture dengan `legalEntityId: null` dan laporkan. Bila handler sudah ada: update program harus menghilangkan `legalEntityId` dari input (bukan null), test gagal-dulu bahwa PT program lama tidak terhapus.
3. `legend-5eveh` (P3, gambar): regenerate `docs/design/screenshots/legend-zx8k/revpash-*.png` sesuai spec legend-zx8k terbaru (4 baris zona, lihat batch88 68422e367). Cari skrip/render yang membuatnya (`git log --format=%H -1 -- docs/design/screenshots/legend-zx8k`). Browser lewat `heavy`.

## Pembagian paralel
- implementer per kartu (3), file terpisah.
- test-runner: pemegang token heavy (setup, test terarah 85qyi, typecheck API sekali, render 5eveh).
- reviewer sonnet: diff akhir (tingkat S).

## Bukti selesai
- c3prg: diff example + checklist.
- 85qyi: test terarah lulus (gagal-dulu bila ada perubahan perilaku), typecheck API lulus.
- 5eveh: path PNG baru + ukuran, screenshot cocok 4 baris zona (subagent cek gambar).

## Batas kerja ulang
Ikuti `~/.agents/team/brief-template.md` bagian "Batas kerja ulang". Jangan `pkill`.

## Sebelum melapor
Pra-gate AGENTS.md (prettier, eslint, text-contract bila ada teks UI). Commit di cabang `ws/1078-kartu-kecil`, push tanpa `--force`.

## Laporan
Hasil per kartu, bukti, berkas, commit, cabang, risiko.
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
