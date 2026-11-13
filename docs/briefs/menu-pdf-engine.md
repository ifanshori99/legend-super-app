# Brief: mesin PDF cetak menu (legend-hspr8, legend-iuvq)

Tingkat S. Cabang kerja: worktree ini, push ke `origin` sebagai `ws/menu-pdf`. Tanpa dependency baru (pdf-lib 1.17.1 + @pdf-lib/fontkit 1.1.1 sudah ada). Semua path di `apps/api/`.

## Keputusan desain (final, jangan ubah kontrak)

Port berubah dari `render(html: string)` menjadi `render(model: PrintableMenu)` di `src/services/menu-print.service.ts:66`.
`PrintableMenu` = `{ brandName, outletName, date, categories: { name, items: { name, description, priceIdr }[] }[] }` (sudah ada, `:85`). `PRINT_TAX_NOTE` = teks footer tetap.

### File baru A (generik, dipakai ulang slip gaji/struk nanti, JANGAN bangun slip/struk)

`src/services/pdf/pdf-fonts.ts`
- `loadPdfFonts(): { regular: Uint8Array; bold: Uint8Array }` memakai pola `fontBytes` di `src/services/purchasing-po-pdf.ts:41` (cek `./fonts/` dulu untuk bundle dist, lalu `../../assets/fonts/`, cache). Jangan ubah purchasing-po-pdf.ts.

`src/services/pdf/pdf-document.ts` — mesin generik, ASCII-only API:
```ts
export type PdfBlock =
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { type: "text"; text: string; bold?: boolean; muted?: boolean; size?: number; align?: "left" | "right" | "center" }
  | { type: "table"; columns: { header: string; width: number /* pecahan, jumlah ~1 */; align?: "left" | "right" }[]; rows: string[][] }
  | { type: "rule" }
  | { type: "spacer"; height?: number };
export interface PdfDocumentSpec {
  title: string;                       // metadata PDF
  header?: { title: string; subtitle?: string; logo?: { bytes: Uint8Array; kind: "png" | "jpg" } };
  blocks: PdfBlock[];
  footer?: string;                     // di tiap halaman + "Halaman n/N"
  page?: { size?: "A4"; margin?: number };   // default A4, margin 48
}
export interface PdfLayoutText { page: number; x: number; y: number; text: string; bold: boolean; size: number }
export function layoutPdfDocument(spec: PdfDocumentSpec, measure: (text: string, bold: boolean, size: number) => number): { pages: PdfLayoutText[][] } // fungsi murni, untuk test
export async function renderPdfDocument(spec: PdfDocumentSpec): Promise<Uint8Array>
```
Aturan: teks panjang dibungkus per kata (kata lebih panjang dari kolom dipecah per karakter); sel tabel dibungkus dalam kolomnya; blok tidak memotong baris tabel di tengah (baris pindah halaman utuh); heading tidak ditinggal sendirian di dasar halaman (keep-with-next); banyak halaman otomatis; header tabel diulang di halaman lanjutan. Karakter yang tidak ada di font (emoji, CJK; cek `font.hasGlyphForCodePoint` via fontkit) diganti `?` supaya tidak muncul kotak .notdef. Font Noto Sans subset sudah mencakup Latin+, `Rp`, simbol mata uang; Rupiah ditulis `Rp 12.500`. `renderPdfDocument` = `layoutPdfDocument` + gambar via pdf-lib (`registerFontkit`, `embedFont(..., {subset:true})`). Hasil dimuat ulang `PDFDocument.load` harus valid.

### File baru B

`src/services/menu-pdf-renderer.ts`
```ts
export function buildMenuPdfSpec(menu: PrintableMenu): PdfDocumentSpec   // murni
export function createMenuPdfRenderer(): MenuPdfRenderer                 // render(menu) => renderPdfDocument(buildMenuPdfSpec(menu))
```
Header: brandName + "outletName · tanggal"; tiap kategori = heading level 2 + tabel 2 kolom (Nama+deskripsi [lebar 0,75] | Harga [0,25, rata kanan]); item tanpa deskripsi tidak punya baris kosong; footer `PRINT_TAX_NOTE`. Format harga memakai `formatRupiah` yang sudah ada di menu-print.service.ts (ekspor bila perlu). Hindari impor sirkuler: service mengimpor tipe saja; wiring pakai `createMenuPdfRenderer` di worker/route.

### Wiring (implementer 2)

- `menu-print.service.ts`: ubah port, `regenerateMenuPrint` memanggil `deps.renderer.render(menu)`. `renderMenuPrintHtml` dihapus bila hanya dipakai port; pindahkan asersi `menu-print-pure.test.ts` ke model/`buildMenuPdfSpec` (jangan melemahkan: semua perilaku yang diuji tetap diuji: footer pajak, tanpa sumber eksternal tidak relevan lagi, urutan, escaping tidak relevan lagi).
- `worker-main.ts:924`: `renderer: createMenuPdfRenderer()` (sweep 30 detik hidup via `shouldStartMenuPrintSweep`).
- `routes/menu-import.routes.ts`: default `renderer ?? createMenuPdfRenderer()` agar `POST /print/refresh` tidak 503 (cek `app.ts:467-479` dan test `menu-import-storage-wire.test.ts`; sesuaikan test yang mengharap 503 bila ada, dan laporkan).
- Update `CountingRenderer` di `menu-print-db.test.ts:56` dan `menu-import-storage-wire.test.ts:31` ke `render(menu)`.

### Test (test-writer, gagal-dulu)

- `src/test/pdf-document.test.ts` (murni): `layoutPdfDocument` dengan `measure` palsu: teks panjang terbungkus, banyak halaman, header tabel diulang, baris tabel tidak terpotong, heading tidak sendirian, karakter di luar font -> `?`; `renderPdfDocument` -> `PDFDocument.load` valid, `getPageCount() >= 1`, dan isi teks lewat layout (`layoutPdfDocument` dengan ukur font asli dari fontkit).
- `src/test/menu-pdf-renderer.test.ts`: model 3 kategori -> PDF valid, layout memuat nama item dan harga `Rp ...`; menu panjang (mis. 120 item) -> `pageCount > 1`; tulisan Indonesia (é, ñ, "Rp 12.500", deskripsi panjang) tidak kehilangan karakter.
- Tambah di `menu-print-db.test.ts` (renderer asli): `regenerateMenuPrint` menyimpan PDF di storage tenant; tenant lain tidak bisa membaca PDF-nya (pakai pola isolasi tenant yang sudah ada di file itu).
- Contoh PDF: skrip/test `LEGEND_MENU_PDF_SAMPLE_DIR` menulis `docs/screenshots/menu-pdf/menu-sample.pdf` (menu realistis 3 kategori, satu kategori panjang sampai >1 halaman); PNG per halaman dirender dengan `sips`/`qlmanage` (macOS) dan disimpan di folder yang sama.

## Batas
Hanya file di atas. Tidak ada dependency baru. Satu token heavy: hanya `test-runner` menjalankan vitest/tsc. Implementer tidak menjalankan tsc/vitest. Jangan commit (engineer yang commit). Tanpa `pkill`.
