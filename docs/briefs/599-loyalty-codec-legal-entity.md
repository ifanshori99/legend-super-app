# Brief: engineer — codec config loyalty bocorkan legalEntityId (legend-5tmks)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep, Read sempit), lalu ikuti. Tingkat K kecil (loyalty, cakupan tenant/PT).

## Repo
Worktree baru dari `int/batch53` (8f956b33, sudah dibuat Ghostex). Commit di cabang kerja dan push ke `origin` sebagai `fix/loyalty-codec-legal-entity`. Jangan ubah `int/batch53` langsung; merge train (thread lain) akan mengambil commitmu.

## Tujuan
Root test `tests/platform-config-codecs-loyalty-policy.test.mjs:88,:247` gagal: program hasil decode berisi `legalEntityId: null`, export menolak `forbidden_key [0].legalEntityId`. Dugaan akar: `packages/shared/src/crm/loyalty.ts:485` (default baru `legalEntityId: null`) diwarisi `packages/shared/src/crm/config-codec.ts:22` (`programItemSchema.omit(id, tenantId, updatedAt)` tanpa `legalEntityId`). Scanner TEN-09 di `platform/config.ts` sengaja melarang id tenant/PT di salinan config: JANGAN dilonggarkan, JANGAN ubah assertion test.

Perbaiki di batas codec (keluarkan `legalEntityId` dari salinan config). Pastikan juga sisi import: program hasil import tidak menjadi lintas-PT diam-diam (founder Q80: poin per PT saja, tidak lintas PT). Bila import tanpa PT membuat program berlaku lintas PT, pilih aturan restriktif (wajib dipilih PT saat import / tolak) dan jelaskan di laporan.

## Kartu
`legend-5tmks`: `bd update legend-5tmks --status in_progress` di awal; saat lapor `--status review` + `bd comment`.

## Scope
- Boleh: `packages/shared/src/crm/config-codec.ts`, file import config loyalty terkait, test root/API yang relevan (test baru boleh, assertion lama tidak dilonggarkan).
- Jangan: scanner `platform/config.ts`, migrasi.

## Paralel
Explore 1 (alur export/import config loyalty + arti legalEntityId null), implementer 1, test-runner pemegang heavy. Reviewer `architect` effort high atas diff.

## Bukti selesai
- `heavy env LEGEND_TEST_FILES="tests/platform-config-codecs-loyalty-policy.test.mjs <test terkait>" pnpm test` hijau.
- Pra-gate: prettier, eslint pada file berubah; typecheck shared lewat `heavy`.
- Jangan `pkill`; jam dari `date '+%H:%M'`; jangan merge ke milestone/m1.

## Laporan
Hasil, bukti, commit, risiko. Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
