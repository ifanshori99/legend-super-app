# Review K 1270 W1b (uang + akses), konteks segar

Cabang `ws/1270-w1b` 29e15477e vs 0e6d570b3 (int/rc2). Reviewer: architect subagent, 26 Nov. Test tidak dijalankan reviewer (baca kode dan test saja).

## Putusan
**Belum lolos.** Satu temuan tinggi (lantai bisa ditembus lewat pajak di porsi kredit) wajib dibetulkan sebelum merge. Dua temuan sedang dibetulkan di cabang ini atau dicatat sebagai syarat W2. Penjualan tetap mati, jadi belum ada uang yang hilang.

## Temuan
1. **TINGGI: pajak pesanan yang dibayar kredit tidak dikurangkan.** `packages/shared/src/wfc/pricing.ts`, `wfcContributionIdr`: `creditMargin = credit × (1 − c)`. Brief §1: pesanan yang dibayar `wfc_credit` "dipajaki harga penuh", jadi PB1 (dan service charge bila ada) disetor dari uang kredit. Contoh: kredit 50 rb, c 35%. Kode memberi 32.500, padahal setelah pajak 12% di dalam yang tersisa ±27.142. Lantai tembus ±Rp5,4 rb per pass. Perbaikan: `credit − ceil(credit×c/BP) − ceil(credit×t/(BP+t))`, dengan t minimal `WFC_FLOOR_SEAT_TAX_BP` ditambah service charge F&B outlet bila aktif (service charge umumnya hak staf). Pembulatan tetap merugikan outlet, bukan tamu. Test: kurang Rp1 ditolak dengan kredit > 0, ditambah kasus kredit besar dengan biaya kursi kecil.
2. **SEDANG: biaya gateway 1% hanya benar untuk QRIS.** `paymentMethodSchema` juga memuat `va` (biaya tetap ±Rp4 rb), `card`, `ewallet`, dan `paylater` (1,5-3% atau lebih). Bila checkout pass mengizinkan metode itu, kontribusi dihitung terlalu besar. Pilih satu: (a) W2/W8 membatasi checkout pass ke `qris`/`bank_transfer` dan memasang test penjaganya, atau (b) biaya = maksimum (bp + biaya tetap) dari metode yang diizinkan. Rekomendasi: (a), dicatat sebagai syarat W2.
3. **SEDANG: usulan lama yang sudah disetujui bisa diterapkan terlambat.** `applyApprovedWfcSettings` (`apps/api/src/services/wfc-settings.service.ts`) tidak mengecek ulang `effectiveFrom >= hari ini` dan `>= effectiveFrom versi terakhir`. Rantai yang dulu gagal diterapkan (misalnya kuota naik) bisa diterapkan berhari-hari kemudian lewat route apply. Hasilnya versi bertanggal mundur, atau versi yang tertutup versi bertanggal lebih baru padahal route melapor sukses. Perbaikan: kembalikan null (409) untuk kedua kasus itu. Test: setujui, tunggu lewat tanggal berlaku, apply → 409.
4. **RENDAH: lantai day pass tidak dicek ulang saat jam buka fasilitas bertambah panjang** (menit day pass naik), dan produk tetap aktif. Syarat W2: hold memanggil `checkWfcSlotFloor` dengan menit slot nyata dari versi yang dibaca ulang. Catatan W4: pass bulanan butuh pengali jumlah kunjungan di `pricing.ts`.
5. **RENDAH: default pertanyaan founder no. 4 (GM/Owner silang) belum ditegakkan.** Penyetuju = siapa saja yang lain dan memegang `wfc.policy.manage` serta ada di kebijakan `price_change`. Kebijakan itu dipakai bersama perubahan harga menu (TL-17). Cukup untuk rilis 1 (tetap dua orang). Catat sebagai kartu kecil bila founder ingin aturan silang.

## Sudah benar
- Rumus BigInt cocok dengan brief (M, B1, B2, B2×o). Pembulatan selalu merugikan outlet: lantai per jam naik ke Rp1.000, slot naik ke Rp1, biaya kursi bersih turun, margin kredit turun, gateway naik. Pajak 12% di dalam biaya kursi sudah konservatif (PB1 10%, PPN efektif 11%). Ada test kurang Rp1 ditolak.
- Dua orang: dicek di app (`decidedBy ≠ requestedBy`, penyetuju memegang `wfc.policy.manage`). Di DB: CHECK distinct actor per level (0247, tanpa pengecualian `price_change`), dan trigger `wfc_settings_approval_guard` mengikat setiap angka, outlet, dan kedua orang. Gagal tertutup tanpa kebijakan (`APPROVAL_POLICY_MISSING`).
- AI: belum ada eksekutor. Consumer AI menyaring `sourceModule` ai/mcp. Request inbox buatan tangan dipaksa ke modul inbox, jadi tidak bisa menyamar `wfc`.
- Pass terjual: apply hanya mematikan produk aktif yang di bawah lantai, baris klaim tidak disentuh. Editor produk umum diblok (`WFC_PRODUCT_MANAGED`). Ubah split selalu mematikan produk.
- Tanpa angka lengkap: menyalakan produk butuh versi yang berlaku (409 `WFC_CONFIG_INCOMPLETE`). Skema mewajibkan semua angka tanpa default.
- Balapan: aktivasi dan apply diserialkan lewat lock outlet lalu lock produk. Usulan yang menunggu ikut membatasi kuota. Hanya satu usulan terbuka per outlet.

## Asumsi agent
- **S = total kursi: diterima.** B1 adalah bagian biaya tetap + laba per kursi-jam di seluruh kafe. Contoh brief (S 60) memakai angka total. Memakai kursi WFC akan membebankan seluruh biaya kafe ke kursi WFC.
- **Day pass = hari buka terpanjang: diterima.** Ini kasus terburuk "semua jam dipakai": dihitung dari jam hari ini dan semua versi mendatang (cadangan: jam fasilitas), maksimal 24 jam, semua menit dianggap ramai kecuali produk `off_peak`. Jendela jam yang bertumpuk terhitung dua kali, arahnya konservatif.

## Langkah perbaikan (engineer Sonnet)
1. `packages/shared/src/wfc/pricing.ts`: kurangkan pajak (dan service charge) dari porsi kredit (temuan 1). Tambah test di `apps/api/src/test/wfc-pricing.test.ts`.
2. `apps/api/src/services/wfc-settings.service.ts` `applyApprovedWfcSettings`: tolak tanggal berlaku yang sudah lewat atau mundur (temuan 3). Tambah test di `apps/api/src/test/wfc-settings.test.ts`.
3. Tulis syarat W2 di brief 1270: checkout pass hanya QRIS/transfer (temuan 2) dan cek lantai per slot saat hold (temuan 4).
4. Review ulang delta oleh satu architect.

## Keputusan CTO 26 Nov
- No. 1 dan 3: perbaiki + test, lalu re-review architect yang sama.
- No. 2: rilis 1, pass WFC online hanya QRIS (fee persen); di outlet tunai/EDC lewat kasir. VA/kartu/e-wallet/paylater untuk pass dibuka sesudah fee per metode dihitung di lantai harga. Syarat W2 WFC.
- No. 4: catat ke W2 WFC.
