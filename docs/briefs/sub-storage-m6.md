# Brief subagent: M6 pipa pindai bersama untuk bukti payout + GET /api/storage/capabilities (legend-egrrp, tingkat K uang)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend-294a6ef0`. Cabang `ws/storage-scanner-pdf` (M4 adb1b107b, M5 ec1b06495 sudah ada).
Desain: D-7 di `/private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app-legend-294a6ef0/82316c12-14fd-456b-9fa7-bbdc99a7f6db/scratchpad/media-transport.md`. Brief M4/M5 lama: `docs/briefs/sub-storage-scanner-pdf.md` (aturan umum tetap berlaku).

Aturan: jangan sentuh panik, edge, DOIT, HRIS, Node pin (legend-ubbd6). Tanpa migrasi. Satu perintah per Bash. Test lewat `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` dari root. Jangan jalankan tsc/build. Jangan log isi/nama file. Tipe brand lewat helper.

## Kontrak

### API `apps/api/src/services/core-image.ts`
```ts
export type UploadBytesKind = "image" | "pdf";
export async function scanUploadBytes(
  bytes: Uint8Array,
  options: { kind: UploadBytesKind; scanner: MalwareScanner; maxBytes: number },
): Promise<{ pageCount?: number }>;
```
- `pdf`: `assertScannerAcceptsDocuments(scanner)` (503 SERVICE_UNAVAILABLE) -> `assertSafePdf(bytes, { maxBytes })` (422 UPLOAD_REJECTED / 503) -> `scanUpload` (422 dari deteksi, 503 SCANNER_UNAVAILABLE).
- `image`: `scanUpload` dengan aturan fail-open yang sama seperti `processImageVariants` sekarang (hanya scanner `failOpenForImages === true` dan 503). `processImageVariants` memakai helper yang sama (tanpa perubahan perilaku).
- `uploadStorage` (`core-storage.ts`) memakai `scanUploadBytes(..., kind:"pdf")` di jalur PDF (pengganti tiga panggilan sekarang). Shareholder (`shareholder-documents.service.ts`) juga.

### Payout `apps/api/src/services/payroll-payout-evidence-upload.service.ts` `uploadPayoutEvidence`
- Ganti `assertScannerAcceptsDocuments` + `deps.scanner.scan` dengan `scanUploadBytes(bytes, { kind: pdf ? "pdf" : "image", scanner, maxBytes: PAYOUT_EVIDENCE_MAX_BYTES })`, tetap SEBELUM `put` dan setelah cek batch/kanal/status (urutan cek batch tidak berubah).
- Pemetaan galat: 422 apa pun dari pipa -> `HttpError(422, "PAYOUT_EVIDENCE_REJECTED", "Berkas bukti ditolak pemindai. Unggah berkas lain.")` (kode dan pesan lama dipertahankan; PDF bersandi boleh memakai pesan sandi dari pdf-safety tapi kode tetap PAYOUT_EVIDENCE_REJECTED). 503 diteruskan apa adanya (SERVICE_UNAVAILABLE bila scanner tidak menerima PDF, SCANNER_UNAVAILABLE bila pemindai mati). Catatan: sebelumnya scanner gagal -> 422; sekarang scanner tidak tersedia -> 503 (desain D-6/D-7), deteksi tetap 422.
- Gambar: tetap `reencodeImage`; bila clamd mati gambar tetap diterima (fail-open hanya untuk scanner yang opt-in).
- Semua perilaku payout lain (batch, kanal, status, kunci `tenants/<t>/payroll-payout/<batch>/<id>.<ext>`, 413 > 5 MB, signed URL 60 dtk, izin) TIDAK berubah.

### Capabilities
- Shared `packages/shared/src/storage/index.ts`: `storageCapabilitiesSchema = z.strictObject({ documentsAccepted: z.boolean() })`, type `StorageCapabilities`, `getStorageCapabilities = defineEndpoint({ method: "GET", path: "/api/storage/capabilities", ... })` mengikuti pola `uploadStorageObject`.
- API: route `GET /api/storage/capabilities` di router storage yang ada (`routes/storage-api.routes.ts` / `core-storage.routes.ts`), `requireAuth` (GET, tanpa izin tenant). `documentsAccepted = runtime !== null && runtime.scanner.acceptsDocuments !== false`. Tanpa runtime storage -> `false`. Tidak memanggil clamd (bukan health).

### Web
- `apps/web/src/features/storage/` (buat bila belum ada, pola `api.ts` -> `queries.ts` -> `hooks.ts`): `useStorageCapabilities()` (staleTime 5 menit).
- Pemilih berkas bukti payout (`apps/web/src/features/ws10-payroll-payout/...`) dan pemilih dokumen pemegang saham bila ada: saat `documentsAccepted === false`, `accept` hanya gambar dan teks bantuan menyebut PDF belum tersedia; saat loading/galat anggap `false` (aman). Teks baru masuk katalog bila proyek punya tes katalog teks (`tests/text-contract.test.mjs`).

## Test wajib (test-writer, file baru)
`apps/api/src/test/payout-evidence-shared-scanner.test.ts`:
1. PDF payout sah + scanner palsu OK (`acceptsDocuments:true`) -> 200/201, objek tersimpan.
2. PDF payout + scanner tidak menerima dokumen -> 503, `put` tidak dipanggil.
3. PDF payout ber-JavaScript (pdf-lib OpenAction JS) -> 422 PAYOUT_EVIDENCE_REJECTED, tidak tersimpan.
4. Scanner deteksi (422) -> 422 PAYOUT_EVIDENCE_REJECTED; scanner mati (503) pada PDF -> 503; pada gambar dengan scanner `failOpenForImages` -> diterima.
5. Uang: setelah unggahan ditolak (3 dan 4), batch tidak berubah status, tidak ada baris dibayar/approve, dan resolve/confirm/approve memakai kunci yang tidak tersimpan ditolak (422 PAYOUT_EVIDENCE_INVALID atau kode yang ada) — tidak ada pihak dibayar.
6. Perilaku lama: kanal salah 409, batch belum diekspor 409, > 5 MB 413 tetap.
`apps/api/src/test/storage-capabilities.test.ts`: tanpa sesi 401; Noop prod (`acceptsDocuments:false`) -> false; scanner menerima -> true; tanpa runtime -> false.
Pakai helper setup batch payout dari test payout yang ada (cari di `src/test/payroll-payout-*.test.ts`). PDF dari `src/test/helpers/pdf-fixtures.ts`.
