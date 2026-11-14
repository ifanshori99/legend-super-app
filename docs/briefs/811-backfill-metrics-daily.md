# 811 Skrip backfill metrics_daily untuk langkah rilis (Codex, engineer kartu S)

## Peran
engineer (baca ~/.agents/team/roles/engineer.md dan bagian "Paralel dulu" di ~/.agents/team/TEAM.md lewat Grep + Read offset/limit).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `origin/milestone/m1`. Cabang akhir `ws/metrics-daily-backfill` (rename dari ghostex/..., push tanpa --force).

## Kartu
`legend-ka1hg` (bd show untuk konteks; CTO memindah status, kamu tidak menjalankan `bd`).

## Tujuan
Langkah rilis "jalankan recomputeMetricsDaily untuk seluruh riwayat" bisa dijalankan operator dengan satu perintah aman: skrip API (mis. `pnpm --filter @starter/api metrics:backfill -- --from <tanggal> [--tenant <slug>] [--dry-run]`) yang memanggil `recomputeMetricsDaily` per tenant per hari, idempoten (jalan dua kali = hasil sama), batch kecil, log hanya id tenant + angka, tidak mengubah hari tanpa sumber data. Daftarkan langkahnya di runbook rilis yang ada (`docs/deployment.md` atau `docs/release-notes-m1-migrations.md`).

## Scope
- Boleh: skrip baru di `apps/api/src/scripts/` (ikuti pola skrip yang ada), `apps/api/package.json` scripts, test di `apps/api/src/test/`, dokumen runbook.
- Jangan: migrasi, logika metrik itu sendiri (bug terbukti: lapor dulu), edge, panik, pembayaran, payout, pemindai.

## Paralel
Subagent bawaan Codex: (a) peta `recomputeMetricsDaily` + brief 268/272 + pola skrip lain, (b) test (idempoten, rata-rata berbobot benar setelah backfill, dry-run tidak menulis, isolasi tenant), (c) runbook.

## Bukti selesai
- `LEGEND_TEST_FILES="src/test/<file>.test.ts" heavy pnpm test` hijau; test gagal-dulu tercatat (sebelum skrip ada).
- Pra-gate AGENTS.md: prettier --check, eslint, `heavy pnpm --filter @starter/api typecheck` sekali.

## Laporan
SHA, cabang akhir, test, cara pakai skrip, baris `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
