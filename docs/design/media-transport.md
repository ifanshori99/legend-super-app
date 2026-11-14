# Transport media dan pemindai dokumen

Kartu: `legend-0una` (foto penerimaan barang dan pembelian kas kecil) dan `legend-2t69x` (pemindai PDF produksi). Penulis: architect, 14 Nov 2026. Basis: `origin/milestone/m1` @ `ec4f7dfc6`, plus cabang payout `ws/payout-api-gaps`, `ws/payout-evidence-hardening`, dan `ws/payout-followups` (batch 64c).

## Ringkasan

1. Transport media umum sudah ada di m1. `POST /api/storage/uploads` (multipart, pindai, buang EXIF, WebP) dan `POST /api/storage/objects/:objectId/signed-url` (300 detik) sudah dipasang lewat `createCoreStorageRouterWithAccess`. Tabel `core_storage_objects` dan izin per jenis sumber (`goods_receipt`, `petty_purchase`, `waste_log`) juga sudah ada. Tidak perlu endpoint baru, adapter kedua, atau migrasi.
2. Yang kurang untuk `legend-0una` ada tiga:
   - Web belum mengunggah. Layar membuat id lokal dengan `newIdempotencyKey()`.
   - Belum ada hook web untuk signed URL.
   - Penerimaan barang tidak menautkan foto lewat `linkStorageObjectSource`, jadi foto milik orang lain di outlet yang sama bisa ditempel. Kas kecil sudah menautkan.
3. Untuk `legend-2t69x`, PDF (bukti payout, dokumen karyawan, dokumen pemegang saham nanti) melewati satu pipa bersama:
   - Ukuran, lalu magic byte.
   - Validasi struktur PDF (`assertSafePdf`, pdf-lib di worker).
   - Pemindaian ClamAV (`clamd`, perintah INSTREAM).
   - Simpan.
   Gambar tetap di-encode ulang oleh sharp. Fail-closed berarti tanpa `clamd` yang sehat, PDF dijawab 503 dan gambar tetap jalan.
4. Bukti payout tetap memakai routernya sendiri dari 64c (kunci disimpan di kolom payout). Yang disatukan adalah pemindai dan validator PDF-nya, bukan tabelnya. Jalur penyimpanan kedua tidak dibuat.
5. Keputusan founder: RAM VPS. ClamAV butuh sekitar 1,2 sampai 1,5 GiB tetap. Rekomendasi: VPS 8 GB. Bila tidak, PDF tetap ditolak di produksi dan finance mengunggah foto atau screenshot (keputusan CTO 14 Nov tetap berlaku).

## Apa yang sudah ada (jangan dibuat ulang)

| Bagian | Lokasi (m1) | Catatan |
|---|---|---|
| Adapter | `packages/shared/src/adapters/providers.ts:333` `ObjectStorage` (`put/get/delete/signedGetUrl/publicUrl`), satu implementasi `S3ObjectStorage` (`apps/api/src/services/core-storage-provider.ts`) | Env `STORAGE_S3_*`, `STORAGE_PUBLIC_BASE_URL`. Kosong: upload 503. |
| Kontrak | `packages/shared/src/storage/index.ts`: `uploadStorageObject`, `createStorageSignedUrl`, `storagePurposePolicy`, `storageSourceKindSchema`, `uploadStorageMetadataSchema` | `receipt` privat, maks 10 MiB. |
| Router | `apps/api/src/routes/core-storage.routes.ts` (multer memory, 10 MiB, 1 berkas), dipasang di `routes/storage-api.routes.ts` | |
| Upload | `apps/api/src/services/core-storage.ts:49` `uploadStorage`: cek `maxBytes` (413), magic byte, `%PDF-` dianggap dokumen | |
| Gambar | `apps/api/src/services/core-image.ts`: `processImage` (sharp, cek format sesuai magic, satu halaman), `MalwareScanner`, `NoopMalwareScanner`, `assertScannerAcceptsDocuments` | |
| Pemindai produksi | `core-storage-runtime.ts:175`: `new NoopMalwareScanner({ acceptsDocuments: NODE_ENV !== "production" })` | Sumber 503 untuk PDF di produksi. |
| Akses | `apps/api/src/services/core-storage-access.ts` `storageSourcePermissionMap` | `goods_receipt`: unggah `inventory.stock.receive`; baca `purchasing.invoice.match` atau `inventory.stock.receive`. `petty_purchase`: unggah `purchasing.petty.record`; baca `accounting.reconcile` atau `purchasing.petty_policy.manage`. Pemilik selalu boleh membaca. |
| Tautan | `core-storage.ts:239` `linkStorageObjectSource` | Sekali tautan, purpose sesuai kind, outlet sama, hanya oleh pengunggah. |
| Tabel | `core_storage_objects`, `goods_receipt_media` (FK ke objek, posisi 0..9), `petty_purchases.photo_object_id` (FK, unik) | Tidak perlu migrasi. |
| Web | `apps/web/src/features/ws10-hris-employee/selfie.ts:99-141` | Satu-satunya pemanggil upload. Pakai `fetch` mentah dan `FormData`, mock `mockRef`. |
| Payout 64c | `payroll-payout-evidence-upload.service.ts` (`uploadPayoutEvidence`, `sniffContentType`, `reencodeImage`), `payroll-payout-evidence.routes.ts`, `payroll-payout-evidence-read.service.ts` (signed URL 60 detik, izin `payroll.disburse.approve`) | Memakai `ObjectStorage` dan `MalwareScanner` yang sama. PDF memanggil `assertScannerAcceptsDocuments`, jadi 503. |

## Keputusan

### D-1. Pakai ulang `POST /api/storage/uploads`, tanpa `POST /api/media` baru

- **Keputusan:** Layar penerimaan, kas kecil, dan catatan buang (waste) mengunggah ke endpoint umum dengan field berikut:
  - `purpose: "receipt"`.
  - `sourceKind`: `goods_receipt`, `petty_purchase`, atau `waste_log`.
  - `outletId`.
  Respons memberi `id` objek, lalu id itu dikirim di `mediaIds` atau `photoMediaId` seperti sekarang.
- **Alasan:** Pemindaian, batas ukuran, izin per outlet, dan audit pengunggah sudah teruji. Endpoint kedua berarti dua tempat yang harus dijaga.
- **Risiko:** Kalau berkas diunggah lalu formulirnya ditinggal, objek yatim tertinggal (`source_id` null).
- **Cadangan:** Sapu objek `receipt` yang belum tertaut dan berumur lebih dari 24 jam. Bila belum ada penyapu, cukup tugas kecil di kartu M2. Biayanya hanya ruang storage, tidak ada risiko data.

### D-2. Penerimaan barang wajib menautkan foto

- **Keputusan:** `inventory-receiving.service.ts` memanggil `linkStorageObjectSource` di dalam transaksi pembuatan, untuk tiap `mediaIds`, dengan:
  - `sourceKind: "goods_receipt"`.
  - `sourceId` = id penerimaan.
  - `actorUserId` = penerima.
  - `outletId` = outlet penerimaan.
  `assertPhotos` dipertahankan untuk pesan galat yang jelas, tetapi aturan sebenarnya ada di tautan.
  Jalur ulang idempoten (replay) mengembalikan penerimaan yang tersimpan tanpa menautkan ulang.
- **Alasan:** Sekarang `assertPhotos` hanya memeriksa tenant, outlet, dan purpose. Akibatnya:
  - Foto yang diunggah orang lain bisa ditempel ke penerimaan kita.
  - Foto berjenis `cash_deposit` bisa ditempel.
  - `source_id` tetap kosong, sehingga audit "foto ini bukti dokumen apa" hilang.
  Kas kecil sudah benar (`petty-purchase.service.ts:278`).
- **Risiko:** Penerimaan lama yang fotonya tidak tertaut tetap dapat dibaca oleh pembaca kind `goods_receipt`, karena kind diisi saat unggah. Tidak ada migrasi data.
- **Cadangan:** Bila jalur replay bermasalah, tautkan sebelum insert `goods_receipt_media` dan biarkan replay membaca baris tersimpan.

### D-3. Signed URL lewat POST yang ada, cache di TanStack Query

- **Keputusan:** Hook web baru `useStorageObjectUrl(objectId, variant)` memanggil `createStorageSignedUrl`. Aturannya:
  - Cache per `[storage, objectId, variant]`.
  - `staleTime` = `expiresAt - now - 30 s`, dan dimuat ulang saat `<img onError>`.
  - Masa berlaku tetap 300 detik untuk foto stok dan 60 detik untuk bukti payout (64c, tidak diubah).
  - Untuk gambar, thumbnail (`variant: "thumbnail"`) dipakai di daftar, sedangkan original dipakai saat dibuka.
  - Read model penerimaan dan kas kecil tetap mengembalikan id, bukan URL. URL dibuat saat dilihat.
- **Alasan:**
  - URL bertanda tangan yang tersimpan di respons daftar akan kedaluwarsa di cache.
  - Mencetak URL per baris di server membuat daftar lambat.
  - Izin baca diperiksa per objek di endpoint signed URL.
- **Risiko:** Daftar dengan banyak foto memicu banyak permintaan signed URL.
- **Cadangan:** Endpoint batch `POST /api/storage/signed-urls` (maks 50 id) dibuat hanya bila daftar terbukti lambat. Bukan kartu sekarang.

### D-4. Batas ukuran dan tipe

| Jalur | Tipe diterima | Batas klien | Batas server | Pengolahan |
|---|---|---|---|---|
| Foto stok (`receipt`: penerimaan, kas kecil, waste) | JPEG, PNG, WebP | 5 MiB setelah normalisasi | 10 MiB (`storagePurposePolicy.receipt`) | Klien: normalisasi lewat canvas ke JPEG 0,85, sisi terpanjang maks 2560 px (memakai pola `normalizeSelfieFile`; HEIC dari galeri iPhone juga jadi JPEG). Server: sharp ke WebP, EXIF dan GPS dibuang. |
| Dokumen (`document`) dan bukti payout | PDF, JPEG, PNG | 10 MiB | 10 MiB (`document`); payout sesuai konstanta 64c | Gambar: sharp. PDF: D-5 lalu D-6. Byte asli disimpan apa adanya. |

- **Byte asli PDF disimpan, bukan dibangun ulang:** Bukti transfer dan dokumen legal harus sama dengan aslinya untuk audit. Isi aktif ditolak (D-5), bukan dibuang diam-diam.
- **Normalisasi di klien:** Foto kamera HP outlet 3 sampai 8 MB. Mengecilkannya menghemat kuota data outlet dan waktu unggah.

### D-5. Validasi struktur PDF (`assertSafePdf`)

Modul baru `apps/api/src/services/pdf-safety.ts` dipakai oleh `uploadStorage` (purpose `document`) dan `uploadPayoutEvidence` (64c). Modul berjalan sebelum pemindai dan sebelum `put`. Urutannya:

1. **Byte:**
   - `%PDF-1.` atau `%PDF-2.` tepat di offset 0. Awalan di tengah berkas (polyglot) ditolak.
   - `%%EOF` ada di 1024 byte terakhir.
   - Ukuran sesuai batas.
2. **Parse:** `PDFDocument.load(bytes, { throwOnInvalidObject: true, updateMetadata: false })` (pdf-lib 1.17.1, sudah menjadi dependensi API). Parse berjalan di `node:worker_threads` dengan batas waktu 5 detik dan `resourceLimits.maxOldGenerationSizeMb: 256`. Gagal parse, lewat waktu, atau kehabisan memori dijawab 422 `UPLOAD_REJECTED`, sehingga PDF bom tidak membekukan API.
3. **Enkripsi:** `EncryptedPDFError` atau `isEncrypted` dijawab 422 ("PDF berkata sandi tidak diterima; simpan ulang tanpa sandi"). Isi PDF terenkripsi tidak bisa diperiksa.
4. **Halaman:** jumlah halaman 1 sampai 50.
5. **Isi aktif:** telusuri semua objek lewat `pdf.context.enumerateIndirectObjects()`, termasuk object stream, karena pdf-lib membongkarnya. Nama sudah didekode, jadi `/J#61vaScript` ikut tertangkap. Tolak (422) bila ada kunci dict atau nilai `/S` berikut:
   - `/JavaScript`, `/JS`, `/Launch`, `/EmbeddedFile`, `/EmbeddedFiles`, `/RichMedia`, `/XFA`, `/SubmitForm`, `/ImportData`, `/GoToE`.
   - `/AA` di mana pun.
   - `/OpenAction` yang menunjuk aksi selain `/GoTo`.
   Tautan biasa (`/URI`) dibiarkan karena kop surat bank sering punya link.
6. **Hasil:** `{ pageCount }` untuk log. Isi berkas tidak dicatat di log.

Tes memakai fixture yang dibuat pdf-lib di dalam tes (tanpa berkas biner di repo):
- PDF sah.
- PDF terenkripsi.
- PDF dengan `/OpenAction` JavaScript.
- PDF dengan `/EmbeddedFiles`.
- PDF terpotong (tanpa `%%EOF`).
- `%PDF-` di offset 100 (polyglot).
- Nama ber-hex `/J#61vaScript`.
- 51 halaman.

### D-6. Pemindai `ClamdMalwareScanner`, fail-closed untuk dokumen

- **Keputusan:** Implementasi `MalwareScanner` baru di `apps/api/src/services/clamd-scanner.ts`:
  - **Protokol:** `node:net` ke `clamd` dengan `zINSTREAM`, potongan 64 KiB (panjang 4 byte big-endian), diakhiri potongan nol. Sekitar 80 baris, tanpa dependensi baru, karena protokolnya kecil dan library npm-nya jarang dirawat.
  - **Jawaban:** `stream: OK` berarti lolos. `... FOUND` dijawab 422 `UPLOAD_REJECTED`; nama virus dicatat di log server saja, tidak di respons. Respons lain, `INSTREAM size limit exceeded`, `ECONNREFUSED`, atau lewat waktu 15 detik dijawab 503 `SCANNER_UNAVAILABLE`.
  - **Penanda:** `acceptsDocuments: true`.
  - **Env baru** (divalidasi di `apps/api/src/config/env.ts`, ditulis di `.env.example`): `CLAMD_HOST`, `CLAMD_PORT` (bawaan 3310), `CLAMD_TIMEOUT_MS` (bawaan 15000).
  - **Pemilihan di `core-storage-runtime.ts`:**
    - `CLAMD_HOST` terisi: `ClamdMalwareScanner`.
    - Kosong di produksi: `NoopMalwareScanner({ acceptsDocuments: false })` (perilaku sekarang, PDF 503).
    - Kosong di dev dan test: Noop yang menerima dokumen (seperti sekarang). `clamd` tidak pernah dijalankan di Mac dev (aturan RAM 16 GB). Tes memakai server TCP palsu.
  - **Ruang lingkup:**
    - Gambar: dipindai bila `clamd` ada. Bila `clamd` mati, gambar tetap diterima karena di-encode ulang sharp (keputusan CTO 14 Nov). Ini supaya penerimaan barang di outlet tidak macet saat `clamd` dimulai ulang.
    - PDF: wajib lolos `clamd`. Tanpa `clamd`, PDF dijawab 503. Bila `clamd` sementara tidak tersedia, router selfie sudah memetakan 503; jalur lain memakai kode yang sama.
  - **Kesiapan:** `GET /api/health` menambah `scanner: "ok" | "unavailable" | "disabled"` (PING ke `clamd`, cache 30 detik) tanpa mengubah status HTTP health.
- **Alasan:** ClamAV gratis, open source, berjalan di VPS sendiri, dan dokumen gaji serta rekening tidak keluar ke pihak ketiga.
- **Risiko:**
  - RAM. Menurut dokumen resmi, signature butuh lebih dari 1,2 GiB, dan saat reload harian sebentar 2,4 GiB.
  - Dengan `ConcurrentDatabaseReload no`, puncaknya tetap sekitar 1,2 sampai 1,5 GiB, tetapi pemindaian tertahan beberapa puluh detik sekali sehari. PDF yang masuk saat itu mendapat 503 dan bisa dicoba lagi.
  - ClamAV hanya menangkap malware yang dikenal. Exploit baru di pembaca PDF ditahan oleh D-5 (isi aktif ditolak), bukan oleh ClamAV.
- **Cadangan:** Bila RAM VPS tidak cukup, biarkan `CLAMD_HOST` kosong. PDF tetap 503 dan finance mengunggah foto atau screenshot.

**Deploy (ditulis di `docs/deployment.md` oleh kartu M4):**
- **Service:** `clamav/clamav` dipatok ke tag LTS yang berlaku saat deploy, di jaringan Docker internal saja (port 3310 tidak dibuka ke internet). Ini perkecualian aturan "Docker hanya DB dan Redis", yang berlaku untuk Mac dev, bukan VPS.
- **Batas:** `mem_limit: 2g`, `ConcurrentDatabaseReload no`, `StreamMaxLength 12M`, `MaxFileSize 12M`.
- **Signature:** `freshclam` bawaan image butuh akses keluar ke `database.clamav.net`.

### D-7. Bukti payout: satukan pemindai, jangan pindahkan tabel

- **Keputusan:** Setelah 64c masuk, `uploadPayoutEvidence` mengganti `assertScannerAcceptsDocuments` dengan pipa bersama `scanUploadBytes(bytes, kind, scanner)` di `core-image.ts`:
  - Gambar: sharp.
  - PDF: `assertSafePdf` lalu `scanner.scan`.
  `uploadStorage` memakai fungsi yang sama.
  - Kunci bukti tetap di kolom `payroll-payout` dan baca tetap lewat `readPayoutEvidence` (60 detik).
  - Endpoint kecil `GET /api/storage/capabilities` mengembalikan `{ documentsAccepted }`, sehingga pemilih berkas payout dan dokumen menyembunyikan opsi PDF saat pemindai tidak aktif. Pengguna tidak lagi bertemu 503 sebagai kejutan.
- **Alasan:** Satu pemindai dan satu validator berarti satu tempat yang diuji. Memindahkan bukti payout ke `core_storage_objects` menyentuh uang dan migrasi tepat setelah 64c, jadi risikonya tinggi tanpa manfaat bisnis sekarang.
- **Risiko:** Dua tempat masih menyimpan metadata berkas.
- **Cadangan:** Penyatuan tabel menjadi kartu terpisah setelah rilis bila diperlukan.

### D-8. Akses per outlet

Tidak ada kode izin baru. Matriksnya:

| Aksi | Siapa | Penegak |
|---|---|---|
| Unggah foto penerimaan | `inventory.stock.receive` di outlet itu | `storageSourcePermissionMap.goods_receipt.upload` lewat resolver |
| Unggah foto kas kecil | `purchasing.petty.record` di outlet itu | `petty_purchase.upload` |
| Tautkan ke dokumen | Hanya pengunggah, outlet sama, belum tertaut | `linkStorageObjectSource` (D-2) |
| Lihat foto penerimaan | `purchasing.invoice.match` atau `inventory.stock.receive`, atau pengunggah | Endpoint signed URL |
| Lihat foto kas kecil | `accounting.reconcile` atau `purchasing.petty_policy.manage`, atau pengunggah | Endpoint signed URL |
| Lihat bukti payout | `payroll.disburse.approve` | `readPayoutEvidence` (64c) |

Scope outlet berasal dari konteks tenant terverifikasi (`assertOutletInScope`) dan RLS (`db/tenant.ts:44`). `outletId` dari form hanya pilihan, bukan bukti akses.

### D-9. Migrasi

Tidak ada untuk kartu ini. Catatan untuk nanti:
- Dokumen pemegang saham belum punya layar atau tabel.
- Saat dibuat, dokumen itu memakai purpose `document` dan kind baru `shareholder_document`.
- Kind baru itu butuh migrasi `core_storage_objects_source_kind_check` (nomor dari CTO) dan baris di `storageSourcePermissionMap`.

## Potongan kartu

Satu berkas brief per kartu (CTO menulis brief dari bagian ini).

| Kartu | Isi | File utama | Tingkat | Model | Bergantung |
|---|---|---|---|---|---|
| **M1** Klien storage web | `features/storage/{api,queries,hooks}.ts`: `uploadStorageFile({purpose, sourceKind, outletId, file})` (multipart, `ApiError`, mock mengembalikan id dan blob URL), `normalizeImageFile` (dipindah dari selfie), `useStorageObjectUrl` (D-3). `selfie.ts` memakai helper ini. Tes unit: mapping galat 413, 415, 422, 503, staleTime, mock. | `apps/web/src/features/storage/*`, `ws10-hris-employee/selfie.ts` | S | engineer Sonnet | Tidak ada |
| **M2** Tautan foto penerimaan | D-2 di `inventory-receiving.service.ts` (link dalam transaksi, replay idempoten), plus penyapu objek `receipt` yatim berumur lebih dari 24 jam bila belum ada. Tes gagal-dulu: foto pengguna lain ditolak, foto `cash_deposit` ditolak, foto kedua kali ditolak, replay tidak gagal, outlet lain ditolak. | `apps/api/src/services/inventory-receiving.service.ts`, `apps/api/src/test/` | K (akses) | engineer Sonnet, review architect | Tidak ada |
| **M3** Wiring layar | Penerimaan, kas kecil, dan waste: pilih foto, normalisasi, unggah langsung (status unggah, galat, ulangi, kirim terkunci selama unggah), lalu kirim id dari server. Hapus `newIdempotencyKey()` untuk media. Tampilkan thumbnail di detail atau daftar lewat `useStorageObjectUrl` bila layarnya ada. Teks baru masuk katalog `tests/text-contract.test.mjs`. | `ws06-purchasing/components/receiving-form-page.tsx`, `petty-page.tsx`, `ws06-inventory/components/photo-field.tsx`, `waste-form-dialog.tsx` | S | ui-engineer Sonnet (kecil) | M1; M2 sebelum merge |
| **M4** `ClamdMalwareScanner` | D-6: klien INSTREAM, env, pemilihan runtime, `scanner` di health, bagian deploy di `docs/deployment.md`. Tes dengan server TCP palsu: OK, FOUND (422), ERROR, timeout, ECONNREFUSED, size limit (503). | `apps/api/src/services/clamd-scanner.ts`, `core-storage-runtime.ts`, `config/env.ts`, `.env.example`, `docs/deployment.md` | K (keamanan upload) | engineer Sonnet, review architect | Setelah 64c masuk |
| **M5** `assertSafePdf` | D-5 di worker dengan batas waktu dan memori. Fixture dibuat di tes. Dipasang di `uploadStorage` jalur dokumen. | `apps/api/src/services/pdf-safety.ts` (+ berkas worker), `core-storage.ts` | K | engineer Opus (desain baru keamanan), review architect | Setelah 64c; paralel dengan M4 |
| **M6** Satukan jalur payout | D-7: `scanUploadBytes` bersama, `uploadPayoutEvidence` memakainya, `GET /api/storage/capabilities` dan kontrak zod di `packages/shared/src/storage`, pemilih berkas payout dan dokumen membaca capability. Tes: PDF payout diterima dengan scanner palsu OK, 503 tanpa scanner, 422 untuk PDF ber-JavaScript, dan gambar tetap jalan saat scanner mati. | `core-image.ts`, `payroll-payout-evidence-upload.service.ts`, `packages/shared/src/storage/index.ts`, picker payout web | K (uang: bukti payout) | engineer Sonnet, review architect | M4 dan M5 |

**Urutan terhadap batch 64c:**
- **M1, M2, M3 boleh mulai sekarang:** tidak menyentuh file payout, `core-image.ts`, atau `core-storage-runtime.ts`. M1 dan M2 paralel, M3 setelah M1.
- **M4 dan M5 setelah 64c masuk ke m1:** 64c memakai `assertScannerAcceptsDocuments` dari `core-image.ts`, jadi menunggu menghindari konflik. Keduanya paralel karena filenya terpisah.
- **M6 terakhir.**
- **Second opinion Codex:** sekali untuk area M4 sampai M6 sebelum gerbang rilis.

## Keputusan untuk founder

**Q-media-1. RAM VPS untuk pemindai PDF.** ClamAV butuh sekitar 1,2 sampai 1,5 GiB RAM tetap (puncak 2 GiB dengan batas container).

| Pilihan | Dampak | Perkiraan biaya |
|---|---|---|
| **A. VPS 8 GB dengan ClamAV (rekomendasi)** | PDF bukti transfer, dokumen karyawan, dan dokumen pemegang saham bisa diunggah dan diperiksa. Data tetap di server sendiri. | Selisih VPS 4 GB ke 8 GB di penyedia lokal sekitar Rp150 ribu sampai Rp300 ribu per bulan (perkiraan, cek saat membeli). Tanpa biaya lisensi. |
| B. Layanan pindai online berbayar | Tanpa RAM tambahan, tetapi berkas gaji dan rekening dikirim ke pihak ketiga di luar negeri (risiko UU PDP). | Sekitar US$20 sampai US$50 per bulan, atau Rp320 ribu sampai Rp800 ribu (perkiraan). Tidak direkomendasikan. |
| C. Tanpa PDF di rilis pertama | Finance mengunggah foto atau screenshot bukti (keputusan CTO 14 Nov). Dokumen PDF ditolak. | Rp0 |

Rekomendasi: A saat VPS dibeli (Q20). Sampai itu terjadi, C berlaku otomatis karena sistem sudah fail-closed. Tidak ada kode yang menunggu keputusan ini: M4 sampai M6 dibangun dan diuji dengan pemindai palsu, lalu dinyalakan cukup dengan mengisi `CLAMD_HOST`.

## Risiko tersisa

- **Unggah butuh internet:** Foto kas kecil wajib, jadi pembelian kas kecil tertahan saat outlet offline. Jalur edge (`edge-selfie` sealing upload) belum mencakup `receipt`. Ini keputusan CTO untuk kartu edge berikutnya, bukan kartu ini.
- **Provider S3 belum dipilih:** `STORAGE_S3_*` kosong berarti semua upload 503. Signed URL harus bisa diakses browser, jadi endpoint S3 (MinIO di VPS atau object storage lokal) wajib publik lewat HTTPS. Ini ikut keputusan server founder (Q20).
- **Penerimaan lama tanpa tautan:** Foto penerimaan yang dibuat sebelum M2 tetap tanpa `source_id`. Data uji saja, karena layar belum pernah mengunggah sungguhan.
- **Batas ClamAV:** ClamAV tidak menangkap exploit baru. Pertahanan utamanya penolakan isi aktif (D-5) dan PDF yang dibuka di browser pengguna, bukan di server.
