# Hasil 173b — Race provisioning dan default pajak

Tanggal: 9 November 2026. Prosedur: `217-review-queue-procedure.md`, run gabungan 219.

| Id brief | Kartu | Hasil | Kartu baru | Catatan |
| --- | --- | --- | --- | --- |
| 173b | legend-dq0n, legend-hd1m | Temuan P2 | legend-usa4b | Race owner sudah terlindungi; penulis CoA melalui edge belum berbagi lock. |

## Basis dan ruang lingkup

- Slice `bdbab782..bd62055c`, merge `0aba8ba7`; diperiksa kembali pada `milestone/m1@94d769c6da4ca5a00972fea5d0d18f1b727a6d6b`.
- Perubahan lanjutan terkait: `tax.service.ts` mendapat guard overlap `4cc287f3`; edge master sync mendapat import guard `d2beba65`. Keduanya tidak menutup celah lock edge di bawah.
- Satu subagent Codex untuk brief ini; induk menelusuri precheck/write edge dan menjalankan interleave PostgreSQL sendiri.
- Tidak mengubah kode repo, checkout, staging, commit, push, atau menutup kartu. Hanya berkas hasil ini ditulis. Total run 219: 3 subagent, puncak 3 paralel.

## Temuan P2 — legend-usa4b

`apps/api/src/edge/master-sync.ts:183`: import edge hanya memegang lock `edge-master-sync:<tenant>:<outlet>`, lalu menulis CoA pada 264 dan mapping pada 291/306 tanpa `lockChartOfAccounts`. Backfill mengambil lock CoA sendiri lalu memeriksa chart kosong (`accounting-provisioning.service.ts:162–197`); kedua transaksi tidak saling menunggu pada lock yang sama.

Reproduksi deterministik induk dengan DB disposable:

1. Edge memiliki tenant, entity, dan outlet; chart kosong. Snapshot cloud sah memuat satu akun root `9999`, mapping kosong.
2. Helper memegang `LOCK TABLE chart_of_accounts IN SHARE MODE`.
3. Mulai `applyEdgeMasterSnapshot` sampai INSERT menunggu. Mulai `backfillTenantCharts`; backfill memperoleh advisory lock CoA, membaca chart masih kosong, dan INSERT juga menunggu pada relation.
4. Lepaskan SHARE lock. Kedua transaksi **fulfilled**; backfill melaporkan `provisioned`, **63 akun dan 44 mapping**. Chart akhirnya berisi akun cloud `9999` ditambah seluruh 63 akun template.

Tidak ada natural-key collision: kode akun berbeda. Ini melanggar invariant tidak mencampur chart cloud/custom dengan template, bukan penolakan `LOCAL_CONFLICT` yang memang dirancang.

Saran: penulis edge mengambil `lockChartOfAccounts(tx, tenantId, legalEntityId)` sebelum natural-key precheck dan write. Ikuti urutan CoA sebelum lokasi bila jalur yang sama juga mengambil lock lokasi. Tambahkan race edge/backfill dan mapping writer ke regresi.

Pencarian bd `provisioning`, `master`, `chart`, `CoA`, `race`, dan `backfill` tidak menemukan kartu untuk jalur edge ini. `legend-hd1m`/hasil 122 menyebut `createAccount` owner serta benturan nama lokasi; keduanya sudah diperbaiki. `legend-bqup` membahas parent-cycle owner, bukan interleave edge ini.

## Jawaban pertanyaan brief

1. Penulis owner tax rules/settings memegang lock bersama sebelum write; create/update CoA dan penggantian mapping juga terlindungi (`accounting-accounts.service.ts:137,208,298`). Jalur edge di atas adalah pengecualian yang masih ada. Tidak ditemukan jalur lain dalam scope yang membuktikan default pajak tetap tersisip setelah konfigurasi owner.
2. Tidak ditemukan urutan terbalik pada empat lock: tenant creation pajak lalu service; outlet creation lokasi lalu service; backfill entitas/outlet berurutan. Row lock tax `FOR UPDATE` diambil sesudah advisory lock (`tax.service.ts:576–577,749–750,1372–1383`).
3. Nama alternatif lokasi deterministik dan unik case-insensitive (`inventory-provisioning.service.ts:138–145`), memakai nama dasar standar pendek, tanpa memperbarui baris lama. Test benturan nama dan default location lulus. Query pemilihan dapur produksi memilih tepat satu kitchen aktif (`inventory-production.service.ts:183–200`); test terkait memeriksa data hasil SQL, belum memanggil `createProductionOrder` langsung.
4. Sensitivitas dua test race owner dibuktikan oleh induk: kode m1 lulus; hanya dua lock owner dihapus sementara pada salinan `/tmp`, kedua test gagal dengan data ganda/campuran dan waiter `relation`; setelah sumber snapshot dipulihkan, kedua test lulus lagi. Kode repo tidak disentuh dalam eksperimen ini.

## Bukti verifikasi

- Baseline induk pada arsip SHA m1 dengan dependensi lengkap: **12 berkas / 168 test terarah lulus**, exit 0, termasuk `provisioning-race.test.ts`, `provisioning-defaults.test.ts`, dan `tax-provisioning.test.ts`. Log `/tmp/legend-219-snapshot-tests.log`.
- Reproduksi baru: `/tmp/legend-review-219-94d769c6/apps/api/src/test/review-219-edge-race.test.ts`. Run melalui `heavy` dan `LEGEND_TEST_FILES=... pnpm test`; invariant **gagal sebagaimana diharapkan**. Log `/tmp/legend-219-repro-red.log`, marker `219_EDGE_RACE`: waiter relation, edge/backfill fulfilled, chart 64 akun.
- Eksperimen tanpa dua lock owner: `/tmp/legend-219-owner-race-without-lock.log`, **2 test gagal**. Run setelah pemulihan: `/tmp/legend-219-owner-race-restored.log`, **2 test lulus**.
- Test reproduksi hanya berada di `/tmp`; tidak ada perbaikan implementasi atau test baru pada repo.
- Lint, typecheck, build, e2e, jalur `createProductionOrder` langsung, dan data produksi tidak diuji. Tidak ada P0/P1 yang ditemukan dalam scope.
