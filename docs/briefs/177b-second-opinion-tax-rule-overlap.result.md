# Hasil 177b — Tumpang-tindih aturan pajak

Tanggal: 9 November 2026. Prosedur: `217-review-queue-procedure.md`, run gabungan 219.

| Id brief | Kartu | Hasil | Kartu baru | Catatan |
| --- | --- | --- | --- | --- |
| 177b | legend-de3b, legend-mdh0 | Temuan P2 | legend-7gwap | Guard publish dapat dilewati melalui UUID probe; daftar konflik ikut kosong. |

## Basis dan ruang lingkup

- Diff slice: `bd62055c..4cc287f3`, merge `5f709692`.
- Kondisi kini: `milestone/m1@94d769c6da4ca5a00972fea5d0d18f1b727a6d6b`. Tidak ditemukan perubahan sesudah tip pada shared tax, tax service/provisioning/routes, atau test overlap terkait.
- Satu subagent Codex untuk brief ini; induk memeriksa kembali probe dan membuktikan jalur HTTP dengan PostgreSQL sementara.
- Tidak mengubah kode repo, checkout, staging, commit, push, atau menutup kartu. Hanya berkas hasil ini ditulis. Total run 219: 3 subagent, puncak 3 paralel.

## Temuan P2 — legend-7gwap

`packages/shared/src/tax/overlap.ts:103` (juga 111; konstanta pada 33): UUID tetap `NO_ITEM` dapat muncul dalam `appliesTo.itemIds`. Probe kategori/kelas lalu menguji item yang justru mendapat specificity lebih tinggi, sehingga konflik pada item biasa tidak terlihat.

Reproduksi HTTP pada tenant baru yang sudah memiliki default `PBJT-FNB`:

1. Buat aturan tenant-wide `SENTINEL-PBJT`, aktif, dengan `appliesTo = { itemClasses: ["food_beverage"], categoryIds: [], itemIds: ["00000000-0000-4000-8000-00000000ffff"] }`.
2. Create mengembalikan 201 dan publish mengembalikan **200**.
3. Preview item F&B lain mengembalikan **409 `TAX_RULE_AMBIGUOUS`**.
4. `GET /api/tax/rules/conflicts` mengembalikan **200, `conflicts: []`**.

UUID tersebut sah menurut skema. Item tidak harus ada di katalog: create menyimpan `input.appliesTo` langsung (`apps/api/src/services/tax.service.ts:530`), tanpa validasi referensi katalog. Jadi ini dapat dicapai melalui API biasa, tanpa menunggu UUID acak suatu item kebetulan sama.

Saran: pilih item probe yang dipastikan tidak terdapat dalam kedua daftar item, atau bandingkan dimensi secara simbolik. Tambahkan regresi publish dan konflik untuk rule kelas/kategori yang juga menargetkan UUID probe. Publish pada reproduksi semestinya ditolak 409, sehingga preview tetap 200.

Pencarian bd `sentinel`, `probe`, `overlap`, `ambiguous`, dan `tumpang` tidak menemukan kartu khusus bypass ini. Ini celah pada guard baru `legend-de3b`, bukan pengulangan laporan aturan tanpa guard. Konteks yang sudah dikecualikan pada brief 219 tidak dilaporkan ulang.

## Jawaban pertanyaan brief

1. Ada false negative konkret di atas; guard publish dan daftar konflik memakai helper yang sama. Subagent juga memeriksa 3.000 kombinasi pasangan/outlet dan 276.382 konteks resolver tanpa menemukan false positive lain. Konflik tanggal mendatang terdeteksi; tombstone pada tanggal yang sama memungkinkan penggantian aturan. Probe pure induk mengonfirmasi kasus dasar tersebut.
2. Provisioning memegang lock yang sama dan hanya menyisipkan default bila belum ada konfigurasi (`tax-provisioning.service.ts:150–161`). Create membuat draft, update hanya mengubah draft. Seed menulis langsung sebagai sumber sintetis development yang dijaga import guard. Tidak ditemukan jalur production import/edge lain yang menulis aturan pajak dalam scope.
3. Dua publish normal terserialisasi: advisory lock diambil sebelum pembacaan/perubahan (`tax.service.ts:749`), memakai `tax:provisioning:<tenant>` (`tenant-config-locks.ts:68`). Test PostgreSQL dua publish lulus dalam run induk; tepat satu rule yang seri terbit.
4. Pemindaian mencakup view tenant dan outlet yang memiliki aturan (`tax.service.ts:711–728`). Endpoint memakai middleware izin yang sama dengan daftar aturan (`tax.routes.ts:50,62`); service memeriksa izin tenant dan filter tenant/outlet (`tax.service.ts:691–703`). Tidak ditemukan kebocoran tenant. Kelengkapan hasil tetap gagal pada bypass UUID di atas.

## Bukti verifikasi

- Run induk pada arsip SHA m1 dengan dependensi lengkap: **12 berkas / 168 test terarah lulus**, exit 0, termasuk `tax-rule-overlap.test.ts`, `tax-service-overlap.test.ts`, dan `tax-service-default.test.ts`. Log: `/tmp/legend-219-snapshot-tests.log`.
- Probe pure dijalankan ulang oleh induk: `/tmp/legend-review-219-94d769c6/review-219-overlap.mjs`, `node --experimental-strip-types`, exit 0. Skema menerima input, helper mengembalikan tanpa konflik, resolver item lain melempar ambiguity.
- Reproduksi HTTP induk: `/tmp/legend-review-219-94d769c6/apps/api/src/test/review-219-overlap-api.test.ts`, dijalankan melalui `heavy` dan `LEGEND_TEST_FILES=... pnpm test` dengan DB disposable. Invariant publish/preview **gagal sebagaimana diharapkan**. Log `/tmp/legend-219-repro-red.log`, marker `219_SENTINEL_API`, mencatat publish 200 / preview 409 / konflik kosong.
- Test reproduksi hanya ada di `/tmp`; tidak ditambahkan ke repo dan belum ada perbaikan implementasi.
- Lint, typecheck, build, e2e, dan data produksi tidak diuji. Tidak ada P0/P1 yang ditemukan dalam scope.
