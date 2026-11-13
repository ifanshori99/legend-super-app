# Brief: engineer — endpoint platform buat brand/outlet/PT untuk tenant

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `milestone/m1` (sudah dibuat Ghostex). Push cabang kerja ke `origin` sebagai `ws/platform-tenant-wizard`.

## Kartu
`legend-0mn8` (endpoint platform admin untuk membuat brand, outlet, dan legal entity/PT milik tenant; wizard admin platform).
Cek dulu tiap kartu belum dikerjakan di basis; bila sudah, tutup dengan bukti. Di awal `bd update <id> --status in_progress`; lapor `--status review` + `bd comment <id> "<ringkasan>"`. Detail: `bd show <id>` dan PRD di `docs/prd/`.

## Tujuan dan aturan
Hanya admin platform (izin platform) yang boleh; tenant admin tidak. Validasi strict zod; ID tenant dari path, bukan body bebas; semua tulis dalam satu transaksi; audit log. Jangan membuat akses lintas tenant. Tanpa UI baru (UI wizard menunggu gerbang mockup); hanya kontrak + API + test.

## Scope
Boleh: routes/services platform, packages/shared validators/types/permissions untuk endpoint ini, test.
Migrasi: hanya rentang `0456-0458`. Jangan rahasia nyata; nama key dari `.env.example`. Jangan sentuh uang/QRIS/AI/edge darurat kecuali disebut.

## Pembagian paralel (giliran pertama)
Explore 2 (peta kode per kartu), test-writer (test gagal-dulu), implementer satu per kartu/potongan file (tidak bertumpuk), review: satu `architect` effort xhigh (akses), satu `test-runner` pemegang heavy.

## Bukti selesai
Gagal-dulu lalu hijau via `heavy env LEGEND_TEST_FILES="..." pnpm test`; typecheck paket yang berubah via `heavy`; `db:generate` kosong bila ada migrasi; pra-gate AGENTS.md (prettier, eslint, text-contract bila teks baru).

## Batas
Jangan `pkill`; jangan merge ke milestone/m1; jangan deploy. Jam dari `date '+%H:%M'`. tsc gagal identik 2x: baca `~/.claude/state/heavy-fail/<terbaru>` sampai habis.

## Laporan
Hasil, bukti, commit, risiko. Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
