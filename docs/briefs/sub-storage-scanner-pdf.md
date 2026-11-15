# Brief subagent: M4 ClamdMalwareScanner + M5 assertSafePdf

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-294a6ef0` (root). API: `apps/api`. Kartu legend-w9hwh (M4), legend-851ef (M5).
Desain (wajib baca bagian D-4, D-5, D-6): `/private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app-legend-294a6ef0/82316c12-14fd-456b-9fa7-bbdc99a7f6db/scratchpad/media-transport.md`.

Aturan umum:
- Jangan sentuh area panik, edge, DOIT, payout (`payroll-payout-*`), HRIS. Tanpa migrasi.
- Jangan log isi file, nama file pengguna, atau nama virus ke respons. Nama virus boleh di log server (pino `logger.warn`), tanpa nama file.
- Test lewat `cd "/Users/ifanshori99/Projects/legend super app/legend-294a6ef0" && LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` (path relatif ke apps/api). JANGAN jalankan tsc/typecheck/build/`pnpm check` (agent pemimpin yang memegang). Satu perintah per panggilan Bash.
- Tipe brand: pakai helper bertipe, bukan `as`.
- Error: `HttpError` dari `apps/api/src/lib/http-error.ts`.

## Kontrak bersama (implementer dan test-writer memakai nama yang sama)

### M4 — `apps/api/src/services/clamd-scanner.ts`
```ts
export interface ClamdScannerOptions { host: string; port: number; timeoutMs: number; }
export class ClamdMalwareScanner implements MalwareScanner {
  readonly acceptsDocuments = true;
  readonly failOpenForImages = true;
  constructor(options: ClamdScannerOptions);
  scan(bytes: Uint8Array): Promise<void>;   // zINSTREAM\0, potongan <= 64 KiB (u32 BE len), akhir 4 byte nol
  ping(): Promise<boolean>;                 // zPING\0 -> "PONG", false bila gagal/timeout, tidak pernah throw
}
export type ScannerHealth = "ok" | "unavailable" | "disabled";
export function createScannerHealthCheck(scanner: MalwareScanner | null, options?: { ttlMs?: number; now?: () => number }): () => Promise<ScannerHealth>;
// scanner null atau tanpa ping() -> "disabled". Cache hasil 30 detik (ttlMs bawaan 30_000). Panggilan bersamaan berbagi satu PING.
```
Jawaban `scan`:
- `stream: OK` (boleh diakhiri `\0`/`\n`) -> resolve.
- `stream: <Nama> FOUND` -> `HttpError(422, "UPLOAD_REJECTED", "Berkas ditolak pemindai malware.")`; nama virus hanya di log server.
- `INSTREAM size limit exceeded ... ERROR`, jawaban lain/`ERROR`, `ECONNREFUSED`, socket ditutup tanpa jawaban, timeout (`timeoutMs`, bawaan 15000) -> `HttpError(503, "SCANNER_UNAVAILABLE", "File scanning is temporarily unavailable.")`. Socket selalu di-destroy (tanpa kebocoran).
- Tanpa dependensi npm baru (`node:net`).

`core-image.ts`: `MalwareScanner` ditambah opsional `readonly failOpenForImages?: boolean` dan `ping?(): Promise<boolean>`. Di jalur gambar (`processImageVariants`), bila scanner `failOpenForImages === true` dan pemindaian gagal 503 (bukan 422), gambar tetap diproses (sharp encode ulang) dan `logger.warn` tanpa isi/nama file. Scanner tanpa flag tetap fail-closed (test `core-image.test.ts` yang ada tetap hijau). PDF selalu fail-closed.

Env (`config/env.ts`, `.env.example`): `CLAMD_HOST` (opsional, kosong = tidak ada), `CLAMD_PORT` (int 1..65535, bawaan 3310), `CLAMD_TIMEOUT_MS` (int 1000..60000, bawaan 15000).
Runtime (`core-storage-runtime.ts` `createStorageRuntimeFromEnv`): `CLAMD_HOST` terisi -> `ClamdMalwareScanner`; kosong + production -> `NoopMalwareScanner({acceptsDocuments:false})`; kosong + dev/test -> Noop menerima dokumen.
Health: `GET /api/health` -> `{ status: "ok", scanner: ScannerHealth }`, status HTTP tetap 200 apa pun nilai scanner. `disabled` bila `CLAMD_HOST` kosong.
Deploy: bagian baru di `docs/deployment.md` (D-6 "Deploy": image `clamav/clamav` tag LTS dipatok, jaringan internal saja, `mem_limit: 2g`, `ConcurrentDatabaseReload no`, `StreamMaxLength 12M`, `MaxFileSize 12M`, freshclam butuh keluar ke `database.clamav.net`, env `CLAMD_*`, cek `scanner` di `/api/health`). Bahasa Indonesia, kalimat pendek.

### M5 — `apps/api/src/services/pdf-safety.ts` (+ `pdf-safety.worker.ts`)
```ts
export interface PdfSafetyOptions { maxBytes: number; timeoutMs?: number /*5000*/; maxOldGenerationSizeMb?: number /*256*/; }
export async function assertSafePdf(bytes: Uint8Array, options: PdfSafetyOptions): Promise<{ pageCount: number }>;
```
- Di thread utama (murah, sebelum worker): ukuran 1..maxBytes, `%PDF-1.` atau `%PDF-2.` tepat di offset 0, `%%EOF` di 1024 byte terakhir.
- Di `node:worker_threads` (`resourceLimits.maxOldGenerationSizeMb`, timeout -> `worker.terminate()`): `PDFDocument.load(bytes, { throwOnInvalidObject: true, updateMetadata: false, ignoreEncryption: true })` lalu cek `isEncrypted`; halaman 1..50; telusuri `pdf.context.enumerateIndirectObjects()` (dict, stream dict, array bersarang) dan tolak kunci/nilai `/S`: `JavaScript, JS, Launch, EmbeddedFile, EmbeddedFiles, RichMedia, XFA, SubmitForm, ImportData, GoToE`, `/AA` di mana pun, `/OpenAction` yang bukan array tujuan dan bukan aksi `/S /GoTo`. `/URI` dibiarkan. Periksa juga trailer/catalog langsung.
- Semua penolakan: `HttpError(422, "UPLOAD_REJECTED", <pesan Indonesia umum>)`; terenkripsi: pesan "PDF bersandi tidak diterima; simpan ulang tanpa sandi." Parse gagal, timeout, OOM worker (`ERR_WORKER_OUT_OF_MEMORY`) -> 422. Worker tidak bisa dimulai (berkas worker hilang) -> 503 `SERVICE_UNAVAILABLE`.
- Batas paralel: maks 2 worker berjalan sekaligus, antre maks 16; lebih dari itu 503 `SERVICE_UNAVAILABLE`.
- Jalur worker harus jalan di: dev (`tsx watch`), vitest, dan produksi (tsup bundle `dist/`, `node dist/server.js`). Tambah entry worker di `apps/api/tsup.config.ts` bila perlu; cek `apps/api/Dockerfile` ikut menyalinnya.
- Dipasang di `core-storage.ts` `uploadStorage` jalur PDF: `assertScannerAcceptsDocuments` -> `assertSafePdf(bytes, { maxBytes: policy.maxBytes })` -> `scanUpload` -> put. Log `pageCount` saja.
- Fixture PDF dibuat di test dengan pdf-lib (tanpa berkas biner). Test lama yang mengirim PDF palsu (`%PDF-` minimal) ke `uploadStorage` harus diganti fixture sah; helper bersama `apps/api/src/test/helpers/pdf-fixtures.ts` (`validPdfBytes()`, dst.).

## Pembagian file
- implementer-M4: `clamd-scanner.ts`, `core-image.ts`, `core-storage-runtime.ts`, `config/env.ts`, `.env.example`, `routes/health.routes.ts` (+ titik wiring runtime ke health), `docs/deployment.md`.
- implementer-M5: `pdf-safety.ts`, `pdf-safety.worker.ts`, `core-storage.ts`, `tsup.config.ts`, `Dockerfile` (bila perlu), `src/test/helpers/pdf-fixtures.ts`, test lama yang memakai PDF palsu.
- test-writer-M4: `src/test/clamd-scanner.test.ts` (server TCP palsu `net.createServer` di port 0: OK, FOUND 422 tanpa nama virus di message, ERROR 503, size limit 503, timeout 503 dengan timeoutMs kecil, ECONNREFUSED 503, potongan > 64 KiB terbagi benar, ping, health cache 30 dtk dengan `now` palsu), `src/test/core-image-scanner-fail-open.test.ts`, `src/test/health-scanner.test.ts`.
- test-writer-M5: `src/test/pdf-safety.test.ts` (sah, terenkripsi, OpenAction JS, EmbeddedFiles, terpotong tanpa %%EOF, %PDF- di offset 100, `/J#61vaScript`, 51 halaman, `/AA`, OpenAction GoTo diterima, URI diterima, timeout kecil -> 422), `src/test/core-storage-pdf-safety.test.ts` (uploadStorage: PDF ber-JS 422 dan tidak ada `put`, PDF sah tersimpan).
