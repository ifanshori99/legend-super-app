# Perbaikan putaran 1 (temuan architect + gate)

Aturan umum dan kontrak: `docs/briefs/sub-storage-scanner-pdf.md`. Jangan sentuh payout (`payroll-payout-*`), HRIS, panik, edge, DOIT. Satu perintah per Bash. JANGAN jalankan tsc/build (pemimpin yang memegang token). Test terarah lewat `LEGEND_TEST_FILES=... heavy pnpm test` dari root.

## A. implementer-pdf (`apps/api/src/services/pdf-safety.worker.ts`, `pdf-safety.ts`)
1. Hex huruf kecil: pdf-lib 1.17.1 hanya mendekode `#XX` huruf besar. Normalisasi tiap kunci dan nilai nama: `s.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))` sebelum dibandingkan.
2. Parse berurutan vs xref pembaca:
   - Kumpulkan SEMUA objek yang pernah di-assign (bungkus `PDFContext.prototype.assign` di worker sebelum load), termasuk salinan yang ditimpa dan objek 0; telusuri daftar itu (plus trailer/catalog), bukan hanya `enumerateIndirectObjects()`.
   - Catat offset awal tiap objek yang di-parse (bungkus `PDFParser.prototype.parseIndirectObject` atau setara). Regex byte mentah `\d+(?:\s|%[^\r\n]*[\r\n])+\d+(?:\s|%[^\r\n]*[\r\n])*obj\b`; tolak bila ada header objek yang tidak di-parse pdf-lib (tersembunyi di komentar atau data stream).
   - Tolak stream dengan `/N` dan `/First` yang bukan `/Type /ObjStm` langsung.
3. `/S`, `/Type`, `/Subtype` berupa referensi: lookup dulu, baru bandingkan.
4. Tambah nama terlarang: `GoToR, Rendition, Movie, Sound, Screen, 3D, OnInstantiate, EF, Win, Mac, Unix` (pertahankan yang ada).
5. Bom dekompresi (ArrayBuffer tidak dibatasi `maxOldGenerationSizeMb`): batasi total byte hasil dekode di worker ke 64 MiB (patch `DecodeStream.prototype.ensureBuffer` atau setara). Patch harus mengenai instance modul yang SAMA dengan yang dipakai `PDFDocument` di dev/vitest (Node resolve `pdf-lib` ke `cjs/`) DAN di bundle tsup (esbuild bisa memilih `es/`). Cara aman: import pdf-lib dan DecodeStream dari path build yang sama secara eksplisit (mis. `pdf-lib/cjs/index.js` + `pdf-lib/cjs/core/streams/DecodeStream.js`), cek tipe tersedia. Lewat batas -> verdict `invalid` (422).
6. Patch prototipe hanya di worker (thread terpisah), tidak di thread utama.

## B. implementer-misc (`clamd-scanner.ts`, `shareholder-documents.service.ts` (+ route bila perlu), test shareholder lama, `docs/deployment.md`)
1. `clamd-scanner.ts`: batasi buffer jawaban 4 KiB; lewat itu -> gagal (503).
2. Shareholder: panggil `assertSafePdf(bytes, { maxBytes })` sebelum pemindaian/penyimpanan PDF di `shareholder-documents.service.ts` (sekitar baris 176-190). Ganti PDF palsu di test shareholder yang terkena (`shareholder-documents-wire.test.ts:151`, `shareholder-membership-latest-version.test.ts:175`, `shareholder-documents.test.ts:240`; `:515` uji ukuran 10 MiB, pastikan tetap menguji batas ukuran) dengan `validPdfBytes()` dari `src/test/helpers/pdf-fixtures.ts`. Jalankan test shareholder itu.
3. `docs/deployment.md` bagian ClamAV: `AlertExceedsMax yes`, `MaxFileSize 100M`, `MaxScanSize 200M`, `StreamMaxLength 12M` (alasan: tanpa AlertExceedsMax berkas di atas batas dijawab `stream: OK` tanpa dipindai). Tambah peringatan: jangan isi `CLAMD_HOST` di produksi sebelum kartu M6 (legend-egrrp) masuk, karena bukti payout PDF belum lewat `assertSafePdf`. Lalu `pnpm exec prettier --write docs/deployment.md`.

## C. test-writer-pdf (`apps/api/src/test/pdf-safety.test.ts`, test M4 yang prettier-merah)
1. Betulkan typecheck: `pdf-safety.test.ts:31` TS2352 (PDFArray -> PDFDict) dan `:358` TS2353 (`timeoutMs` tidak ada di tipe `{ maxBytes }`). Pakai tipe `PdfSafetyOptions`.
2. Fixture baru (gagal-dulu terhadap kode sekarang): `/#4aS` dan `/#4aavaScript` huruf kecil; objek ganda nomor sama (salinan awal berisi JS, salinan akhir bersih); header objek JS di dalam komentar `%`; ObjStm tanpa `/Type`; `/S` sebagai referensi ke `/Launch`; `GoToR`; bom Flate (mis. 200 MB nol di-deflate di dalam object stream atau xref stream) -> 422 dalam waktu wajar dan tidak crash. PDF sah dengan pembaruan inkremental bersih (objek sama ditulis ulang tanpa isi aktif) tetap DITERIMA.
3. `pnpm exec prettier --write apps/api/src/test/clamd-scanner.test.ts apps/api/src/test/core-image-scanner-fail-open.test.ts apps/api/src/test/pdf-safety.test.ts`.
4. Jalankan `pdf-safety.test.ts` sekali, laporkan mana yang gagal (diharapkan: fixture baru, sampai A selesai).
