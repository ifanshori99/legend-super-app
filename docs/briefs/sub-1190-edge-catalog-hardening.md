# 1190 Edge catalog sync hardening: pembagian potongan

Cabang `ws/1190-edge-catalog-hardening`, base m1 2b23b324f. Tanpa migrasi. Semua path relatif `apps/api/src/`.
Aturan umum: tidak menjalankan tsc/vitest/build sendiri kecuali tugasmu menyebut (satu token heavy per thread: test terarah `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` dari root worktree hanya oleh test-runner). Jangan sentuh payment-_, reservation-_, payroll-_, refund_, vitest config. Jangan commit. Komentar kode: Inggris singkat, rujuk ID bead (`legend-xxxxx`).

Kompatibilitas wajib (rilis cloud-dulu, tapi rollback mungkin): edge lama + cloud baru, edge baru + cloud lama harus tetap heartbeat dan pull. Jangan menambah field ke `catalogSyncPageSchema` atau frame lain yang dipakai edge lama.

## Potongan A: cloud (kartu 75kly cloud + y9y8y) , milik: `services/edge-catalog-sync.ts`, `routes/edge-catalog-sync.routes.ts`

1. 75kly (cloud): saat cursor ditolak (`isCatalogSyncCursorError`), route menambah header respons `X-Edge-Error: CATALOG_CURSOR_REJECTED` lalu melempar ulang error yang sama (status 400 tetap). Ekspor konstanta nama header + nilai dari modul yang bisa diimpor edge (taruh di `services/edge-catalog-sync.ts` atau berkas konstanta kecil baru `edge/catalog-cursor-marker.ts` milik potongan A; edge mengimpor dari sana).
2. y9y8y: deteksi restore DB cloud tanpa migrasi, tanpa field baru di page.
   - Cursor baru `cat3` = `[tag, txid, epoch, ...keys]`. Cursor `cat2` lama tetap diterima (tanpa cek epoch) agar edge yang menyimpan cat2 tidak ditolak. Page berikutnya selalu mengeluarkan cat3.
   - `epoch` = identitas cluster: `SELECT system_identifier::text FROM pg_control_system()`, di-cache per proses, fail-soft (query ditolak/privilege: epoch tetap string tetap, mis. `"0"`, dan hanya cek di bawah yang berlaku). Sediakan seam test (fungsi set/reset provider epoch) agar test bisa mensimulasi restore.
   - Tolak cursor (`CoreError VALIDATION_ERROR` dengan pesan sama `CURSOR_INVALID_MESSAGE`, sehingga marker 75kly ikut) bila: (a) cat3 dengan epoch berbeda dari epoch sekarang; (b) txid cursor (cat2 atau cat3) lebih besar dari `pg_snapshot_xmax(pg_current_snapshot())` (txid mundur setelah restore). Edge lalu rewind lewat jalur yang sudah ada (`edge-catalog-rewind.test.ts`).
   - Dokumentasikan singkat di `docs/deployment.md` (restore DB cloud: edge sync ulang otomatis; tambahkan 3-5 baris di bagian yang relevan; berkas ini milik A).
   - `cat1`/cat lain tetap ditolak seperti sekarang.

## Potongan B: edge (kartu 75kly edge) , milik: `edge/cloud-http.ts`, `edge/catalog-puller.ts`

- `EdgeCloudHttpError`: `code` tetap `HTTP_<status>` (kode lain bergantung padanya). Tambah properti opsional `reason?: string` yang diisi dari header `X-Edge-Error` respons non-ok di `cloudGetJson` (nilai dibatasi: hanya string `[A-Z_]{1,64}`; body tetap tidak dibaca).
- `isRejectedCursor` di `catalog-puller.ts`: reset `sync_txid` hanya bila `isCatalogSyncCursorError` ATAU (`HTTP_400` dan `reason === "CATALOG_CURSOR_REJECTED"`). 400 lain TIDAK reset.
- 400 tanpa marker dengan `since !== null` (ambigu: cloud lama yang query-nya strict menolak `protocolVersion`, atau 400 lain): kirim satu probe `fetchPage(stream, null)` dan BUANG hasilnya (tidak diterapkan, tidak menyimpan checkpoint). Probe juga 400 `HTTP_400` -> `CatalogCloudOutdatedError` (jalur deteksi n6mkr tetap hidup). Probe sukses -> lempar error 400 aslinya (tanpa reset, tanpa sinkron ulang penuh). Probe error lain -> lempar error probe.
- Perilaku lama tetap: `since === null` + HTTP_400 -> `CatalogCloudOutdatedError`.

## Potongan C: kartu ssnf9 , milik: `edge/catalog-freshness.ts`, `services/edge-sync-conflict-alert.ts` (hanya `notifyEdgeCatalogStale`), bagian `notifyCatalogStale` di `edge/runtime.ts` (baris ~270-300 saja)

- Cloud: `notifyCatalogStale` mengumpulkan semua entri BARU (belum di `catalogStaleAlerted`) dari satu heartbeat dan mengirim SATU notifikasi per edge per heartbeat yang menyebut semua stream baru (atau stream akar + jumlah), bukan satu per stream. Id alert stabil tetap per edge + himpunan stream/episode supaya heartbeat berulang tidak membuat duplikat.
- Edge: `catalogStaleForHeartbeat` membuang entri `reason === "CATALOG_PARENT_FAILED"` bila stream induknya (akar yang gagal) ada di daftar; bila hanya anak yang tersisa, tetap kirim. Jangan ubah guard `CATALOG_CLOUD_OUTDATED`.
- Perilaku nyata ada di kode: baca dulu `notifyEdgeCatalogStale` dan `edge-catalog-stale-alert.test.ts` (test lama harus tetap hijau; ubah ekspektasi hanya bila itu memang spesifik per stream dan beri alasan di laporan).

## Potongan D: kartu n6mkr , milik: `edge/protocol.ts` (hanya skema heartbeat), `edge/link-client.ts`

- Cloud (protocol): frame `heartbeat` menjadi toleran field tak dikenal (strip, bukan strictObject); field yang dikenal tetap divalidasi ketat (`catalogStale` strict items, `version`, `occurredAt`, `auditRetentionDisabled`). Frame lain tidak berubah. Perbarui komentar release-order.
- Edge (link-client): bila koneksi ditutup dengan `LINK_CLOSE.protocol` dalam 10 detik setelah heartbeat yang membawa `catalogStale` (cloud lama menolak field), edge menahan `catalogStale` selama 1 jam (re-probe setelahnya), heartbeat berikutnya (koneksi baru) tanpa field itu sehingga link tidak putus-sambung. Tanpa heartbeat extras, tutup 1008 tidak mengubah apa pun. Gunakan seam waktu/ jam yang sudah ada di berkas bila ada; seam test baru bila perlu.
- `auditRetentionDisabled` perlakuan sama bila ditolak? Tidak: hanya `catalogStale` (tugas kartu).

## Potongan E: kartu jcgbk , milik: `test/edge-catalog-sync.test.ts`, `edge/catalog-puller.test.ts` (test-only)

- Penyebab laporan: kedua berkas menghapus tabel penuh (`DELETE FROM menu_categories`, `edge_pull_checkpoints`, dst.) di DB test bersama; bila dua proses vitest berbagi DB (`LEGEND_TEST_DB_NAME`/skrip `scripts/test.mjs`) saling menghapus. Selidiki dulu (baca `scripts/test.mjs` di root repo dan `src/config/data-import.ts` untuk `DataImportBlockedError`) dan pilih perbaikan paling kecil: isolasi per berkas (nama DB unik atau tenant unik + DELETE terbatas tenant) atau mekanisme serial yang sudah ada. Jangan ubah `vitest.config.ts` global atau `scripts/test.mjs` bila bisa dihindari; bila terpaksa, lapor dan berhenti.
- Bukti: jelaskan akar masalah di laporan dengan file:baris.

## Test baru (test-writer, gagal-dulu), berkas baru saja

- `test/edge-catalog-cursor-marker.test.ts` (A+B, 75kly): cloud route header marker pada cursor ditolak; edge: 400 tanpa marker dengan cursor tersimpan TIDAK reset (checkpoint utuh), 400 + marker reset; ambigu + probe 400 -> CatalogCloudOutdatedError; probe sukses -> error asli tanpa reset.
- `test/edge-catalog-epoch.test.ts` (A, y9y8y): cat3 epoch beda ditolak; cat2 diterima; txid > xmax ditolak; page mengeluarkan cat3; edge merewind setelah penolakan (pakai pola `edge-catalog-rewind.test.ts`).
- `test/edge-catalog-stale-coalesce.test.ts` (C, ssnf9): satu heartbeat dengan 4 stream -> satu notifikasi; heartbeat berulang tidak menambah; stream baru kemudian -> satu notifikasi tambahan; `catalogStaleForHeartbeat` membuang anak PARENT_FAILED.
- `test/edge-link-heartbeat-compat.test.ts` (D, n6mkr): cloud menerima heartbeat dengan field tak dikenal; field dikenal salah tipe tetap ditolak; edge menahan catalogStale setelah 1008 dalam 10 detik dan melanjutkan setelah 1 jam.
  Ikuti pola test lama (`edge-catalog-rewind.test.ts`, `edge-catalog-stale-alert.test.ts`, test link yang ada). Test dijalankan test-runner nanti; test-writer hanya menulis (boleh menjalankan satu berkas terarah SEKALI lewat `LEGEND_TEST_FILES=... heavy pnpm test` untuk bukti gagal-dulu bila implementasi belum ada; sertakan alasan gagal).

## Bukti selesai

Test gagal-dulu per kartu lalu hijau; test `edge-catalog-*` lama hijau; typecheck api sekali (heavy), `pnpm exec prettier --check` + `pnpm exec eslint` berkas berubah; architect (K) satu kali.

## Addendum setelah review architect (keputusan, mengalahkan teks di atas bila bertentangan)

- Tidak ada cursor cat3/epoch (merusak edge lama). y9y8y = cek xmax saja + runbook. Keputusan dicatat di laporan.
- C/ssnf9: HAPUS filter anak PARENT_FAILED di `catalogStaleForHeartbeat` (hanya 4 stream kritis masuk alarm, tidak ada yang induk; filter menyembunyikan stream yang harus dilaporkan). Penggabungan hanya di cloud. Alert id = hash SELURUH himpunan stale dari heartbeat (urut), dikirim hanya bila minimal satu entri baru; bukan hash stream baru saja.
- D/n6mkr: penahanan 1 jam hanya bila close 1008 DAN `closeReason === "Invalid frame"` (teks dari link-peer.ts:659) DAN dalam 10 detik setelah heartbeat ber-catalogStale.
- B: `edge/cloud-http.ts` mengimpor konstanta dari `edge/catalog-cursor-marker.ts` (tanpa salinan).
- A/docs: runbook restore: (1) bukan DELETE; edge_pull_checkpoints FORCE RLS: ikuti pola `apps/api/drizzle/0375_recipes_resync_edges.sql` (owner, lepas FORCE RLS, `UPDATE edge_pull_checkpoints SET watermark = NULL WHERE stream IN (<stream katalog>)`, pulihkan FORCE RLS); jangan hapus baris `catalog:init:*`, `catalog:schema-*`, `:parents`, `:fallbacks`, last_success_at. (2) setelah dump/restore, baris katalog menyimpan sync_txid lama yang tinggi: sebelum edge menarik, restamp sync_txid tabel katalog seperti butir staff_pins di runbook yang sama (baca butir itu dan tabel/trigger sync_txid yang sebenarnya; jangan mengarang).
