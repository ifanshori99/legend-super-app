# 1204 Merge train batch99: status (20 Nov)

Cabang int/batch99 dari int/batch98 (b9990c6fa). Langkah 1-3 selesai; langkah 4 (ws/1199) menunggu pesan CTO.

| Langkah | Cabang | SHA di int/batch99 |
|---|---|---|
| 1 | ws/1191 (cherry-pick 48da44a3f) | 2186f232c |
| 2 | ws/1192 (9174668d0), migrasi 0710-0712 -> 0509-0511 | c1ccc02c8 |
| 3a | Reapply merge ws/1172 (batalkan revert def286166) | 1c3e14aee |
| 3b | ghostex/26e97de4 (b15c3ac85, kartu 1201) | a6459335b |

## Peta renumber (ws/1192)
0710 -> 0509, 0711 -> 0510, 0712 -> 0511. Journal idx/tag diganti dan `when` dinaikkan (1795000019101, 20101, 21101) supaya urut sesudah 0508. Snapshot dibangun ulang 3-arah (base int 0508 + delta cabang 0709 -> 0710 -> 0711 -> 0712), prevId 0509 = id 0508. Komentar nomor di SQL, schema, service, dan kunci registry `data-import-registry.test.ts` ikut diganti (0709 -> 0507).

## Keputusan di langkah 3
Cabang ghostex/26e97de4 dibuat di atas 1172 (readDbClock di access.service.ts) tetapi batch98 me-revert 1172. Merge langsung menjatuhkan kode 1172 diam-diam (readDbClock hilang). Karena kartu 1201 memperbaiki bug 1172 (tulis jam DB, baca jam app) dan brief menyebut kartu ini menggantikan ws/1172, revert def286166 dibatalkan lebih dulu (commit 1c3e14aee, bersih tanpa konflik), lalu cabang digabung. Hasilnya sama dengan isi cabang untuk berkas akses.

## Konflik
- docs/PROGRESS.md (tiap langkah): dua bagian ditambahkan di akhir, keduanya dipertahankan.
- platform-approval.service.ts: HEAD memakai `lockedCaller`/`checkAt`, cabang memakai `caller.data.clock ?? now`. Dipadukan: `now: lockedCaller.data.clock ?? checkAt` (sama dengan perlakuan `reachContext`).
- platform-tenant-owner.service.ts: hilang sendiri sesudah 1172 dikembalikan.

## Langkah 4-6 (CTO menambah: merge int/batch98 0940e5351, faf6f7394, b9e1a6856 legend-7zwmv; tip awal 24c5b7dfe)
| Langkah | Cabang | SHA |
|---|---|---|
| 4a | ws/1199-edge-catalog-so1197 7dd1c996b (tanpa migrasi) | 970b21ac1 |
| 4b | ws/1199 3f094d767 (legend-bg5wy) | 6b1257918 |
| 5 | ws/1205a-refund-echo 958fe014e (tanpa migrasi) | 8c848f8a9 |
| 6 | ws/1205b-storage-env 874471cbd (tanpa migrasi) | d0d2fd24f |

Konflik langkah 4-6: hanya `docs/PROGRESS.md` di 4a (dua bagian dipertahankan); sisanya merge otomatis. Tidak ada tests/doctor*.test.mjs di repo.

## Gate (bukan full run)
- check-workspace-links: lulus. prettier: hijau kecuali `docs/review/img/ui1192-check.json` (artefak cabang 1192, tidak diubah).
- `heavy pnpm run lint`: 0 error (2 warning lama di web). `heavy pnpm run typecheck`: shared, web, api hijau.
- `heavy node --test tests/text-contract.test.mjs tests/*-contract.test.mjs`: 873 lulus, 0 gagal.
- `heavy pnpm db:generate`: "No schema changes".
- Test terarah 30 berkas / 311 tes hijau (25 berkas test diff + data-import-registry, platform-access-api, platform-tenant-owner, platform-approval*, berkas 1192/recon-hold).
- Belum: full run (CTO sesudah batch98 mendarat), e2e, reviewer sonnet atas hunk konflik (tidak ada tool subagent di thread ini).
- Langkah 4 (ws/1199) belum dikerjakan, menunggu pesan CTO. Perbaikan batch98 tambahan (reseal role grants) belum masuk.

## Gate langkah 4-6 (tip d0d2fd24f, bukan full run)
- lint 0 error (2 warning lama), typecheck shared/web/api hijau, prettier hijau di berkas berubah, `db:generate` "No schema changes".
- `node --test tests/text-contract.test.mjs tests/*-contract.test.mjs tests/dev-public-site-setup.test.mjs`: 885 lulus, 0 gagal.
- Test terarah 37 berkas / 483 lulus, 1 skip: edge-catalog-*, edge-link-heartbeat-compat, access-read-db-clock, refund-1205-a, refund-1191, refund-1144, storage-env, config/env.test, profit-share-statement-ports, core-storage-runtime, health-scanner, core-storage-pdf-scanner.
- Belum: full run, e2e, merge perbaikan batch98 berikutnya (tunggu CTO).
