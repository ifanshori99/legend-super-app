# Review P2 cetak tablet (ws/1272-cetak 0608170cb)

Reviewer kode (Sonnet): LULUS, 1 P2, 3 P3. Audit UI: TIDAK LULUS (umpan balik cetak dan teks). 27 Nov.

## Wajib (keputusan CTO)
1. Cetak ulang dari `receipt-preview.tsx` (`ws04-pos-correction/api.ts:156-159`, `hooks.ts:260-275`) kirim `paperWidth` + `sendToPrinter`.
2. Sesudah kirim, tampilkan `printer.sentNote` lewat `aria-live="polite"`; jangan pindah layar otomatis tanpa jalan "Cetak ulang" (`success-panel.tsx:78`).
3. `receipt-result-notice.tsx:27`: teks sesuai penyebab (Tanpa printer / RawBT gagal), "Ubah printer" lalu "Cetak ulang".
4. `printer.description`: "Struk dikirim ke printer ini" (laporan shift disambung di P3 legend-wasr7.4).
5. Konfirmasi sesudah "Simpan printer" (live region "Printer disimpan: RawBT · 80 mm").
6. Tombol "Cetak tes" di dialog setelan.
7. `sendToPrinter` dibungkus try/catch, galat tampil terpisah (`hooks.ts:380`); `printHtmlInFrame` hapus iframe bila `contentWindow` null (`send-to-printer.ts:25-33`).
8. Kecil: label SegmentedControl tidak dibaca dua kali (`tablet-printer-settings.tsx:64-76`); tombol "Ubah printer" tidak tertutup footer di 390.

Test gagal-dulu untuk 1, 2, 7. Screenshot ulang 390/1280, terang dan gelap.
