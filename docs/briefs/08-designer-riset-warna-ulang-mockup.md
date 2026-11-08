# Brief: designer — riset psikologi warna + ulang mockup final arah A

## Peran

Baca `~/.agents/team/roles/designer.md` dan `~/.agents/team/TEAM.md`, lalu ikuti. Aturan UI: `~/.agents/team/ui-standard.md`.

## Repo

`/Users/ifanshori99/Projects/legend super app/legend`, cabang `ux/customer-order-benchmark` (sudah aktif di folder ini). Jangan pindah cabang.

## Latar

Mockup final arah A + liquid glass (`design/mockups/final-a-*.png`, sumber `final-a-mobile.html`, `final-a-mobile.css`, `final-a-desktop.html`, README) dibuat dari brief `docs/briefs/04-designer-arah-a-liquid-glass.md`. Founder meninjau (Q6) dan minta diubah dulu. Catatan founder apa adanya:
"Coba riset warna termasuk warna button secara psikologis yang mendorong pembelian serta membuat orang memesan banyak".

## Tujuan

1. Riset psikologi warna untuk order F&B (menu digital, QR order di meja): warna tombol/CTA, warna yang mendorong nafsu makan, dan pola yang menaikkan nilai pesanan. Pakai sumber kredibel (studi, eksperimen A/B yang terdokumentasi, panduan produk besar). Pisahkan tegas bukti vs mitos (contoh: "merah bikin lapar" — seberapa kuat buktinya). Semua pasangan warna teks/latar wajib lolos WCAG AA.
2. Tulis `design/COLOR-RESEARCH.md`: temuan + sumber (link), palet usulan (token + hex + rasio kontras), aturan pemakaian (CTA utama, harga, badge promo, status), dan pola upsell yang disarankan (misal "tambah minuman?", bundling, item rekomendasi di keranjang) dengan buktinya.
3. Ulang semua `final-a-*` (10 layar, nama berkas sama, timpa) dengan palet baru. Tambahkan pola upsell di layar yang relevan (detail item, bar keranjang, checkout) tanpa membuat layar ramai. Liquid glass, arah A, dan keputusan Q3/Q5 tetap.

## Scope

- Boleh diubah: `design/mockups/**`, `design/COLOR-RESEARCH.md`.
- Jangan disentuh: kode aplikasi, `DESIGN.md` (perubahan diusulkan di README saja), `docs/`.

## Bukti selesai

- Semua gambar dibuka sendiri: teks terbaca, kontras aman di atas kaca, tidak terpotong.
- `design/mockups/README.md`: bagian baru "Revisi warna (Q6)": palet lama vs baru, alasan singkat tiap warna dengan rujukan ke COLOR-RESEARCH, usulan perubahan `DESIGN.md`.
- Commit lokal: `docs(design): riset warna dan revisi palet mockup order pelanggan`.

## Laporan

Path gambar, 3 temuan riset terkuat (dengan tingkat bukti), palet baru, pola upsell yang ditambahkan, asumsi.
