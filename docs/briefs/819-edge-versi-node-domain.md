# 819 Tiga kartu kecil: versi edge, pin Node, batas laju verifikasi domain (Codex, engineer kartu S)

## Peran
engineer (baca ~/.agents/team/roles/engineer.md dan bagian "Paralel dulu" di ~/.agents/team/TEAM.md lewat Grep + Read offset/limit).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `origin/ws/tenant-domain-audit` (ad6c16b86, berisi audit tenant_domains). Cabang akhir `ws/edge-node-domain-rate` (rename dari ghostex/..., push tanpa --force).

## Kartu
`legend-6t8f1`, `legend-ubbd6`, `legend-rc8m3`. CTO memindah status; kamu tidak menjalankan `bd`.

## Tujuan
1. legend-6t8f1: build image edge (`deploy/edge`, Dockerfile/compose/skrip build) mengisi `EDGE_NODE_VERSION` dengan semver nyata (>= 0.2.0, ambil dari `package.json` paket edge atau satu sumber versi). Batas minimum ada di `packages/shared/src/edge/link-dead-letter.ts` ("0.2.0"); peringatan versi di onHello harus bisa membaca nilainya. Test: nilai kosong/bukan semver ditolak saat build atau menghasilkan peringatan yang jelas.
2. legend-ubbd6: pin Node >= 22.18 di `.nvmrc`, `engines` root `package.json`, dan image Docker API/worker (worker pdf-safety butuh TypeScript bawaan Node). Jangan ubah versi pnpm.
3. legend-rc8m3: batasi laju verifikasi domain tenant (tiap gagal menambah baris audit). Batas per tenant per domain (mis. 5 per 10 menit), jawaban 429 dengan kode jelas, percobaan yang ditolak tidak menulis audit. Ikuti pola rate limit yang sudah ada di API.

## Scope
- Boleh: `deploy/edge`, Dockerfile, `.nvmrc`, `package.json` engines, service/route verifikasi domain tenant, test terkait.
- Jangan: migrasi (bila perlu: berhenti dan lapor, nomor 0381), panik, pembayaran, payout, pemindai, logika edge sync.

## Paralel
Subagent bawaan Codex: satu per kartu (file tidak bertumpuk), plus satu test-writer untuk rc8m3 (gagal-dulu sebelum fix).

## Bukti selesai
- rc8m3: `LEGEND_TEST_FILES="src/test/<file>.test.ts" heavy pnpm test` hijau, gagal-dulu tercatat.
- 6t8f1/ubbd6: perintah build atau skrip cek yang membuktikan nilai versi terisi (tanpa docker build penuh bila berat; bila perlu, lewat `heavy`).
- Pra-gate AGENTS.md: prettier --check, eslint, `heavy pnpm --filter @starter/api typecheck` sekali.
- Lapor hanya saat selesai atau butuh keputusan.

## Laporan
SHA, cabang akhir, per kartu apa yang berubah, test, baris `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
