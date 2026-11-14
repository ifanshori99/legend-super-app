# 810 Audit tulis domain tenant (engineer, tingkat K kecil)

## Peran
engineer (baca ~/.agents/team/roles/engineer.md dan bagian "Paralel dulu" di ~/.agents/team/TEAM.md lewat Grep + Read offset/limit).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `origin/milestone/m1`. Cabang akhir `ws/tenant-domain-audit` (rename dari ghostex/..., push tanpa --force).

## Kartu
`legend-ix04y`. Di awal: `bd update legend-ix04y --status in_progress`. Saat lapor: `bd update legend-ix04y --status review` + `bd comment`.

## Tujuan
Setiap aksi tulis `tenant_domains` (tambah, hapus, `POST /api/org/domains/:domainId/verify`) tercatat di audit log yang sudah ada (pakai helper audit yang dipakai fitur lain, cari lewat Explore): aktor, tenant, hostname, hasil (sukses/gagal verifikasi). Tanpa token atau rahasia DNS di audit.

## Scope
- Boleh: service/route domain org (`apps/api/src/services/*domain*`, `routes/*domain*`), test di `apps/api/src/test/`.
- Jangan: skema audit (tanpa migrasi; bila ternyata butuh migrasi, berhenti dan lapor, nomor 0379), edge, panik, pembayaran.

## Pembagian paralel
- Explore x2: (a) route + service domain tenant dan tulisannya, (b) helper audit + contoh pemakaian + test audit yang ada.
- test-writer: test gagal-dulu (tiap aksi menulis satu baris audit dengan field benar; tenant B tidak melihat audit tenant A; verifikasi gagal tetap tercatat).
- implementer: satu, di service domain.
- Pemegang token heavy: test-runner.

## Bukti selesai
- `LEGEND_TEST_FILES="src/test/<file>.test.ts ..." heavy pnpm test` hijau; gagal-dulu tercatat di basis.
- Pra-gate AGENTS.md (prettier, eslint, `heavy pnpm --filter @starter/api typecheck`).
- Satu reviewer sonnet atas diff (aturan akses: tingkat K -> satu subagent architect effort high).

## Laporan
Ikuti brief-template (SHA, cabang, test gagal-dulu, baris Subagent).
