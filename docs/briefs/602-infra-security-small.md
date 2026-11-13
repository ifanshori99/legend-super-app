# Brief: engineer — 4 kartu infra/keamanan kecil

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu", kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti.

## Repo
Worktree baru dari `milestone/m1` (sudah dibuat Ghostex). Push cabang kerja ke `origin` sebagai `ws/infra-security-small`.

## Kartu (cek dulu tiap kartu belum dikerjakan di m1; bila sudah, tutup dengan bukti dan lewati)
1. `legend-2mey`: `apps/web` masuk.email/google/tautan pakai `safeReturnPath` (open redirect) + `signed-in.tsx:37` jangan buang query `/wifi?zone=...`.
2. `legend-moe5`: SSR web -> API meneruskan IP pengunjung secara terautentikasi (header bertanda/HMAC atau rahasia internal, bukan X-Forwarded-For mentah), supaya batas per-IP publik berlaku. `TRUST_PROXY=true` tetap ditolak.
3. `legend-3sbl`: pasang `S3ObjectStorage` dari env + pemindai malware di `createApp`, sehingga `POST /api/menu/media` tidak 503 bila env diisi; tanpa env tetap 503 jelas. Key baru di `.env.example` + `apps/api/src/config/env.ts`. Jangan baca `.env*` nyata.
4. `legend-bj5m`: cek sisa kerja (catatan: sweeper sudah terjadwal di worker-main); selesaikan wiring customer resolver bila belum.

Tiap kartu: `bd update <id> --status in_progress` di awal; lapor `--status review` + `bd comment`.

## Scope
Hanya file kartu di atas + test-nya. Jangan sentuh uang/refund, AI, QRIS, edge emergency. Migrasi: tidak perlu; bila terpaksa `0446-0447`.

## Pembagian paralel (giliran pertama)
Explore 1 (cek status 4 kartu di m1). test-writer: test gagal-dulu per kartu. implementer 3-4 (satu per kartu; moe5 dan 3sbl sama-sama mungkin menyentuh `app.ts`: urutkan atau satu implementer). reviewer: satu `reviewer` sonnet (2mey+moe5 keamanan: `architect` effort high). Pemegang heavy: satu `test-runner`.

## Bukti selesai
Test gagal-dulu lalu hijau via `heavy env LEGEND_TEST_FILES="..." pnpm test`; typecheck web/api via `heavy`; pra-gate AGENTS.md (prettier, eslint, text-contract bila teks baru).

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy. Jam dari `date '+%H:%M'`. tsc gagal identik 2x: baca `~/.claude/state/heavy-fail/<terbaru>`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
