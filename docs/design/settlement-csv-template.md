# Template CSV settlement gateway (`legend_template_v1`)

Dipakai layar Kelola > Pembayaran > Impor settlement Duitku (C4b, legend-osqou.8). Server membaca berkas ini dan menghitung semua total sendiri; browser tidak pernah mengirim angka.

## Kolom

Baris pertama yang tidak kosong adalah header. Header harus tepat tiga kolom ini (urutan bebas, huruf besar/kecil bebas, masing-masing sekali, tanpa kolom lain):

| Kolom        | Isi                                                                  | Aturan                                                |
| ------------ | -------------------------------------------------------------------- | ----------------------------------------------------- |
| `reference`  | Referensi pembayaran Duitku (sama dengan referensi di transaksi POS) | 1-100 karakter, unik dalam berkas                     |
| `amount_idr` | Nominal transaksi, rupiah utuh                                       | Angka saja, tanpa titik/koma/Rp, lebih dari 0         |
| `fee_idr`    | Biaya MDR Duitku untuk transaksi itu, rupiah utuh                    | Angka saja, 0 atau lebih, tidak melebihi `amount_idr` |

Pemisah koma, titik koma, atau tab. Baris kosong dilewati. Maksimal 1000 baris data dan 90.000 karakter.

Contoh:

```csv
reference,amount_idr,fee_idr
DK-20261101-0001,55000,385
DK-20261101-0002,30000,210
```

## Data di luar berkas

Outlet, nomor laporan settlement Duitku (`reference` laporan), dan periode (maks 31 hari) diisi di formulir.

## Galat

Satu baris rusak menolak seluruh berkas (422). Server mengirim nomor baris (header = baris 1) dan kode alasan, bukan isinya: `columns` (jumlah sel salah), `reference`, `amount`, `fee`, `duplicate`. Maksimal 20 baris dicantumkan.

## Format asli Duitku

Belum didukung: belum ada contoh berkas ekspor asli Duitku. Format itu akan ditambahkan sebagai nilai `format` baru setelah contoh dari founder diverifikasi (bead terpisah).
