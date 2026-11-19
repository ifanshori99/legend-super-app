# Second opinion refund kasir ronde 5 — brief 1166

Tanggal: 19 November 2026. Hasil: **1 temuan P2; tidak ada P0/P1 baru yang terkonfirmasi dalam cakupan pemeriksaan.**

## Cakupan dan bukti

- `git fetch origin` selesai, exit 0. Rentang diperiksa: `7fba91ddb..origin/ws/1095-void-refund-ganda-voucher`; head cocok dengan brief, `4bfae84768764c0e01d22f485c0941d1561d2ebf`. Nomor baris di bawah merujuk head tersebut.
- Membaca laporan ronde 4 dan `docs/briefs/sub-1145b.md`. Tiga subagent berjalan paralel, puncak tiga: alokasi largest remainder; consumer ORD-09; void/chain/finance dan isolasi akses. Parent memeriksa ulang kandidat melalui jalur POS dan voucher; subagent consumer menguji balik keterjangkauan kandidat secara independen.
- Pemeriksaan memakai `git diff`, `git show`, pencarian statis, dan aritmetika BigInt terpisah. Tidak checkout, membuat worktree, menjalankan layanan, atau mengubah kode. Hanya laporan ini ditulis di folder utama pada cabang `ux/customer-order-benchmark`; tanpa commit, push, merge, atau mutasi Beads.

## Temuan

| Lokasi | Tingkat | Masalah dan skenario gagal | Perbaikan dan usul test |
| --- | --- | --- | --- |
| `apps/api/src/services/order-given.ts:488` (pembagian riwayat pada `:473–480`) | P2 | Alokasi largest remainder baru tidak selaras dengan pembagian refund POS terdahulu, yang masih memakai floor lalu seluruh sisa ke item terakhir. Order POS lunas tanpa promo/DP/pembulatan: A Rp10.000, B Rp20.001, C Rp30.000; subtotal Rp60.001, service Rp3.000, PBJT Rp6.300, dibayar Rp69.301; bagian LR A/B/C = Rp11.550/Rp23.101/Rp34.650. Voucher C Rp1, lalu refund kasir `[A,B]` Rp34.651 diterima. Pembacaan riwayat mendebit A Rp11.549 dan B Rp23.102: B melampaui bagiannya Rp1, A mempunyai ruang semu Rp1. Voucher A Rp1 sesudahnya dapat diterbitkan, sehingga A+B menerima Rp34.652 dan mengambil Rp1 bagian C. | Gunakan alokasi refund yang konsisten saat menentukan batas dan membaca riwayat: jumlah debit harus sama dengan payout, setiap debit dibatasi sisa bagian baris, dan hasil tidak bergantung urutan item. Simpan alokasi per baris atau rekonstruksi berurutan dengan batas tersebut. Tambahkan regresi voucher C Rp1 → refund `[A,B]` Rp34.651 → voucher A Rp1: payout pertama tetap Rp34.651, ruang A/B sama-sama nol, voucher tambahan ditolak 422 `APOLOGY_VOUCHER_NOTHING_DUE`. Ulangi urutan `[B,A]`, beberapa pasangan baris, serta voucher/refund bersamaan dengan barrier. |

## Jejak pembuktian P2

- Perhitungan LR pada `order-given.ts:414–446`: floor A/B/C = `[11.549, 23.101, 34.649]`, remainder = `[58.451, 6.200, 55.351]` dengan pembagi 60.001. Dua rupiah tersisa diberikan kepada A dan C. Jumlah bagian baru tepat Rp69.301.
- Voucher C Rp1 membuat `recoveryGivenIdr > 0`. `pos-order-corrections.ts:1286–1312` kemudian membatasi refund yang menyebut item memakai jumlah ruang LR A+B, yaitu Rp34.651. Tidak ada promo, DP, charge, refund lain, atau ORD-09 aktif pada skenario ini.
- `pos-order-corrections.ts:1427–1438` menyimpan nominal Rp34.651 dan daftar item `[A,B]` tanpa alokasi nominal per baris. Pembacaan ulang pada `order-given.ts:473–480` memberi A `floor(34.651 × 10.000 / 30.001) = 11.549`; B menerima sisanya, Rp23.102. `:491–494` menghasilkan saldo A `+1` dan B `−1`; `lineRoomIdr` menjepit saldo negatif menjadi nol secara terpisah.
- Voucher setelah refund POS tetap diperbolehkan: `order-voucher-room.ts:37–40` menerima lane `pos_refunded`, dan `:88–98` mengembalikan ruang A Rp1. `order-issue-manual-refund.ts:417–445` hanya menolak isu `manual_refund`, bukan refund POS. Pelaporan pada `order-recovery.service.ts:607–695` memeriksa paid/void tanpa menolak kuantitas yang sudah direfund POS; refund POS tidak mengubah status baris. Penerbitan voucher pada `apology-voucher.service.ts:875–907` menerima isu terbuka dan nominal yang muat di ruang itu.
- Pada base `7fba91ddb`, input refund yang sama dibatasi bagian floor A+B, Rp34.650, dan riwayat dibagi `[11.549, 23.101]`; ruang A nol. Peralihan ke LR menambahkan rupiah ke batas agregat tanpa menyelaraskan pembagian riwayat.
- Membalik daftar menjadi `[B,A]` membagi refund Rp34.651 menjadi B Rp23.101 dan A Rp11.550, tanpa ruang semu. Besarnya ruang sisa kini bergantung urutan item dalam request. Kombinasi serupa pada pasangan baris lain dapat menambah selisih; ini bukan replay issue yang sama.
- Batas seluruh order tetap menahan total keluar pada skenario ini. Invariant per baris bocor: A+B menerima Rp1 melebihi jumlah bagiannya, sehingga Rp1 dana C dapat ikut keluar. Tidak ada bukti total pengembalian seluruh order melampaui Rp69.301.

## Hasil pemeriksaan lainnya

- Consumer ORD-09 pada `order-recovery-refund.ts:678–689` menghitung ulang split dengan `releasedIdr >= total − deposit − cap`; `recoveryRefundSplit` membatasi nominal pada ruang tersebut. Tidak ditemukan skenario baru pemotongan Rp1–3 yang dapat diulang untuk menambah payout. Refund aktif dan idempotency per issue tetap menahan replay.
- Untuk daftar original lengkap yang jumlah nilainya sama dengan subtotal, algoritme LR membagikan tepat total order, dengan tie-break ID deterministik dan replacement dipetakan ke original. Kandidat P2 terjadi saat bagian itu dipakai bersama pembagian riwayat POS yang berbeda.
- Cek chain baru pada void kas berjalan setelah charge keluar dari `paid`, di dalam transaksi dan di bawah kunci order. Kegagalan melempar 422 dan menggulung void beserta movement/event. Tidak ada skenario uang berlebih baru yang terkonfirmasi pada jalur void, finance, atau gateway yang ditelusuri.
- Enam kode penolakan finance (422 `REFUND_OVER_ORDER_ROOM` dan lima kode 409) dipetakan ke katalog dan dipakai dialog create-refund. Tidak ada temuan baru lintas tenant/outlet yang terkonfirmasi dalam cakupan perubahan.

## Batas verifikasi

- Aritmetika BigInt benar-benar dijalankan terpisah dalam JavaScript V8: floor `[11549,23101,34649]`, remainder `[58451,6200,55351]`, sisa `2`, pembagian riwayat POS `[11549,23102]`. Ini bukan eksekusi fungsi repo atau reproduksi API/DB.
- Probe fungsi murni dari blob repo sempat diantrekan lewat `heavy`, lalu dibatalkan sebelum berjalan karena antrean gate lain; proses berakhir exit 143 dan tiketnya telah hilang. Tidak ada job milik audit yang masih berjalan.
- Tidak menjalankan test database, barrier konkurensi, build, atau typecheck. Tidak mengklaim test cabang hijau atau seluruh area refund sudah aman. Skenario P2 perlu dibuktikan engineer melalui test terarah di cabang target.
- Test baru `refund-1145b-strict-line.test.ts:617–655` menerima penolakan ORD-09 lama 409; test itu belum membuktikan guard chain 422 baru. Tambahkan kasus langsung yang mencapai guard setelah charge dikeluarkan dari `paid`, lalu pastikan rollback status, movement, dan event; pertahankan kontrol chain bersaldo nol yang sah. Ini batas cakupan test, bukan temuan bug tambahan.
- `pnpm exec prettier --check docs/qa/second-opinion-refund-kasir-ronde5-1166.md` dan `pnpm exec eslint docs/qa/second-opinion-refund-kasir-ronde5-1166.md` dicoba; keduanya exit 1, `MODULE_NOT_FOUND`, karena executable dependency lokal tidak tersedia. Tidak memasang dependency untuk audit ini. Pemeriksaan whitespace memakai `git diff --no-index --check` lulus.
