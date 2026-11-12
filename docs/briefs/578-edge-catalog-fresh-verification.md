# 578: sisa kesegaran katalog dan stream promo edge

Basis worktree `ws/edge-catalog-fresh`: `milestone/m1` pada `ab574d58`.
Kartu `legend-10nex` dan `legend-09sxa`. Cabang lama freshness (`f3be4e16`)
dan promo streams (`6303c34d`) sudah seluruhnya tergabung pada basis ini.
Implementasi tidak diulang; migrasi 0414–0416 tidak diperlukan.

## Sisa yang direproduksi

Catatan 533c pada `docs/PROGRESS.md` menyebut dua pull bersamaan dapat membaca
checkpoint lengkap yang sama. Pull pertama kemudian meninggalkan snapshot
parsial, sedangkan pull kedua gagal sebelum menerima halaman. Generation
terakhir dapat membuka gate berdasarkan checkpoint lama sehingga promo pada
snapshot parsial kembali memberi diskon.

Test memakai database edge terpisah dan fetch yang ditahan untuk membuktikan
diskon tetap Rp0 setelah kedua pull selesai. Kegagalan membaca checkpoint juga
harus menutup gate selama kelengkapannya tidak terbukti. Snapshot parsial hanya
boleh dibuka oleh pull lengkap berikutnya. Setelah gangguan baca sementara,
pembacaan checkpoint yang kembali membuktikan snapshot lengkap tetap mengikuti
aturan 533 B2: promo tanpa kuota boleh hidup offline sampai batas kesegaran.

## Batas perubahan

Antrekan pull dalam satu proses sebelum generation dan checkpoint dibaca.
Gate promo memang global dalam proses; antrean tidak memegang koneksi atau
transaksi DB selama menunggu jaringan, dan harus dilepas dalam `finally`.
Test lama untuk rewind/txid dan pull parsial tetap berlaku.

Q57/Q61 tetap: katalog kritis lewat 24 jam menahan penjualan sampai izin owner
tercatat. Promo basi tidak mendapat izin lewat override penjualan. Q66 tetap:
promo otomatis tanpa kuota/anggaran bersama dapat dipakai selama segar;
kode promo/voucher tetap memerlukan kasir cloud online. Stream tidak membawa
hash kode yang dapat ditebus. Tidak membuka penebusan kode di edge.

## Bukti yang diminta

Test gagal-dulu, test terarah freshness/offline/uang/stream/puller, typecheck
API (termasuk `src/edge`) dan shared melalui satu pemegang `heavy`, ESLint dan
Prettier file berubah, serta satu subagent architect effort xhigh dengan
konteks segar. Tidak menjalankan `pnpm check` penuh, merge, push, atau deploy.

## Hasil test dan review

Gagal-dulu: `LEGEND_TEST_FILES="src/test/edge-promo-stream-offline.test.ts" heavy pnpm test`
exit 1, 1 gagal/15 lulus. Race memberi diskon Rp20.000 alih-alih Rp0;
diagnostik membuktikan retry membaca checkpoint sebelum partial commit.
Log `/tmp/edge-catalog-fresh-red.log`.

Setelah patch, perintah berikut exit 0: 15 berkas/224 test lulus
(`/tmp/edge-catalog-fresh-green.log`).

```sh
LEGEND_TEST_FILES="src/test/edge-promo-stream-offline.test.ts src/test/edge-promo-stream-money.test.ts src/test/edge-promo-stream-sync.test.ts src/test/edge-promo-stream-secrets.test.ts src/test/edge-promo-unproven-clock.test.ts src/test/edge-promo-gate.test.ts src/edge/catalog-puller.test.ts src/edge/catalog-freshness.test.ts src/edge/catalog-freshness-block.test.ts src/test/edge-catalog-gate-boot-dbdown.test.ts src/test/edge-catalog-stale-alert.test.ts src/test/edge-catalog-sales-gate-pos.test.ts src/test/edge-catalog-loop.test.ts src/test/edge-catalog-txid.test.ts src/test/edge-catalog-rewind.test.ts" heavy pnpm test
```

Satu subagent architect native Codex effort xhigh, konteks segar, memeriksa
diff uang dan dependensi sempit: tidak ada temuan nyata. Klarifikasi dokumen:
gangguan baca checkpoint yang pulih dan membuktikan snapshot lengkap bukan
snapshot parsial; aturan offline 533 B2 tetap berlaku.

## Kelanjutan verifikasi

Checkpoint lokal `07e868cc` menyimpan patch, test dan bukti di atas.
Antrean typecheck awal mencapai batas tunggu `heavy` 1.800 detik (exit 75)
sebelum compiler berjalan. Setelah akun #5 habis kuota, sesi dilanjutkan di
akun #6 dan runner verifikasi dibuat kembali pada worktree yang sama.
Timeout antrean bukan kegagalan typecheck dan tidak mengubah hasil test.

Gerbang paket final (20:08 WIB), semuanya exit 0:

- `heavy pnpm --filter @starter/api typecheck` (mencakup `src/edge`), log `/tmp/edge-catalog-fresh-api-typecheck.log`.
- `heavy pnpm --filter @starter/shared typecheck`, log `/tmp/edge-catalog-fresh-shared-typecheck.log`.
- `heavy pnpm --filter @starter/api build`, log `/tmp/edge-catalog-fresh-api-build.log`.
- `heavy pnpm db:generate`: `No schema changes, nothing to migrate`, log `/tmp/edge-catalog-fresh-db-generate.log`.
- `heavy pnpm exec eslint apps/api/src/edge/catalog-puller.ts apps/api/src/test/edge-promo-stream-offline.test.ts`, log `/tmp/edge-catalog-fresh-eslint.log`.

Pemeriksaan format terakhir mencakup kedua berkas TypeScript di atas, dokumen
ini dan `docs/PROGRESS.md`; log `/tmp/edge-catalog-fresh-prettier.log`.
Suite penuh, build web, e2e/browser, migrasi/deploy production tidak dijalankan.
Kedua kartu tetap terbuka untuk CTO sesuai aturan pencatatan tim Codex;
tidak ada perubahan milestone/main, push, merge atau deploy.
