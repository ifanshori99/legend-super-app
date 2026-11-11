# Brief: second-opinion Codex — area WFC produk, reservasi, day pass, bundel (legend-bz9h)

Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti. Read-only. Effort xhigh (uang).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Basis `origin/milestone/m1` (3c7217b2).

## Cabang
- `origin/ws/bz9h-wfc-products` 74fad85f: pembayaran WFC hanya sah bila cocok tender POS captured outlet itu; durasi reservasi = durasi produk; bundel min 50% jumlah komponen (saat buat + beli); day pass/bundel idempoten per referensi; FK customer (migrasi 0251 sementara). Architect xhigh 3 ronde.

## Aturan founder
Jangan sampai rugi. Order berdiskon sengaja ditolak sebagai pembayaran WFC.

## Fokus
Satu tender membiayai lebih dari nilainya (beberapa penjualan WFC, baris campur makanan, split bill, void/refund POS sebelum dan sesudah), idempotensi dan balapan, bundel di bawah 50% lewat jalur lain (ubah harga komponen setelah dibuat), durasi melewati batas, akses lintas outlet/tenant, FK outlet yang dicek di service saja. Sudah diketahui, cukup konfirmasi: refund setelah penjualan WFC belum mencabut pass (legend-tz4dg); EDC referensi kembar 409; menu_item_id bundel tanpa FK.

## Laporan
Temuan P0..P3: file:baris, skenario (input -> hasil salah), saran. Sebut yang bersih. Angka subagent.
