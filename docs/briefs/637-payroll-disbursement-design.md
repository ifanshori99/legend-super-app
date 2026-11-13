# Brief: architect — desain pembayaran gaji (disbursement Duitku/DOIT + transfer manual per bank)

Baca `~/.agents/team/roles/architect.md` (Grep + Read sempit), lalu ikuti. Tingkat K (uang + akses + integrasi pihak ketiga). Effort xhigh. Tugas ini DESAIN dan riset, belum kode produk.
Langkah pertama: pecah riset dan spawn subagent paralel dalam satu giliran.

## Keputusan founder Q3 (13 Nov 2026)
Gaji bisa dibayar lewat:
1. **Disbursement API Duitku** atau **disbursement DOIT** (transfer otomatis ke rekening karyawan), atau
2. **Transfer manual** lewat bank tertentu (file transfer bank / CSV), dipilih lewat konfigurasi tenant.

## Yang dihasilkan
1. `docs/design/payroll-disbursement.md`:
   - Riset dokumen resmi disbursement Duitku dan DOIT (pakai Context7 lalu web resmi): alur (inquiry nama rekening, transfer, callback/status), auth/signature, sandbox, batas nominal dan harian, biaya per transfer, waktu proses, kode bank, idempotensi, status gagal/tertunda/reversal. Tandai yang belum pasti.
   - Model data: konfigurasi metode bayar per tenant/PT (provider, rekening sumber, bank manual), status per slip (draft -> dikirim -> berhasil/gagal/dikembalikan), log callback, rekonsiliasi dengan jurnal payroll.
   - Aturan uang: tiap slip dibayar tepat sekali (kunci idempotensi per slip), inquiry nama rekening wajib cocok sebelum kirim, persetujuan dua orang sebelum kirim batch, gagal sebagian tidak mengirim ulang yang sudah berhasil, saldo sumber kurang -> berhenti sebelum kirim.
   - Keamanan: kunci API hanya server, rahasia lewat env, tidak dicetak; callback diverifikasi tanda tangan.
   - Pembagian slice dan kartu bd (backend adapter Duitku, adapter DOIT, layar konfigurasi, layar kirim batch + status, ekspor bank manual per bank), urutan, rentang migrasi usulan.
   - Daftar keputusan bisnis untuk founder (mis. siapa menanggung biaya transfer, batas persetujuan, bank manual mana dulu), tiap butir dengan rekomendasi.
2. Kartu bd untuk tiap slice (`bd create`, tautkan ke `legend-1gtfm` bila relevan).

Lihat kode yang ada: ekspor bank payroll (`ws/payroll-followups`, aturan PAYR-04), adapter pembayaran DOIT/Duitku yang sudah ada untuk QRIS/payment link (pola signature, webhook dedupe `fix/webhook-retry-guard`).

## Pembagian paralel
Explore 2 (kode ekspor bank payroll; adapter DOIT/Duitku yang ada), web-fetch/riset 2 (dok disbursement Duitku; dok DOIT), architect sendiri menulis desain, reviewer akhir atas dokumen.

## Batas
Jangan panggil API Duitku/DOIT sungguhan, jangan minta kunci. Jangan ubah kode produk. Commit dokumen ke cabang `docs/payroll-disbursement` dari `milestone/m1`, push. Jam dari `date '+%H:%M'`.

## Laporan
Ringkas: rekomendasi utama, pertanyaan founder (maks 4, dengan rekomendasi), kartu dibuat. Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
