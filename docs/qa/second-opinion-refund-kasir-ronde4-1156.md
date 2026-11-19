# Second opinion refund kasir ronde 4 — brief 1156

Tanggal: 19 November 2026. Hasil: **1 temuan P2; tidak ada P0/P1 baru yang terkonfirmasi dalam cakupan pemeriksaan.**

## Cakupan dan bukti

- `git fetch origin` selesai, exit 0. Rentang diperiksa: `3bf621e86..origin/ws/1095-void-refund-ganda-voucher`; head remote cocok dengan brief, `7fba91ddb6e5f79012b83369372d6a8ffca39798`. Nomor baris di bawah merujuk head tersebut.
- Tiga subagent dimulai paralel: refund finance/urutan kunci; anggaran chain swap; interaksi kasir/gateway/webhook/void/payout dan isolasi akses. Parent memeriksa ulang kandidat, jalur pemanggil, dan aritmetikanya.
- Pemeriksaan memakai `git diff`, `git show`, pencarian statis, dan perhitungan BigInt. Tidak checkout, membuat worktree, menjalankan layanan, atau mengubah kode. Hanya laporan ini ditulis di checkout utama `ux/customer-order-benchmark`; tanpa commit, push, merge, atau mutasi Beads.

## Temuan

| Lokasi | Tingkat | Masalah dan skenario gagal | Perbaikan dan usul test |
| --- | --- | --- | --- |
| `apps/api/src/services/order-given.ts:706` | P2 | Refund ORD-09 sah setelah swap seharga sama ditolak seluruhnya karena batas `min(chain.paidIdr, chain.balanceIdr + 3)` menghapus toleransi pembulatan pada refund pertama. QR open bill lunas, belum completed: A Rp10.000 + B Rp20.001; subtotal Rp30.001, service Rp1.500, PBJT Rp3.150, total Rp34.651; tanpa diskon, DP, pembulatan kas, atau pengembalian sebelumnya. Refund A menurut pembulatan komponen ORD-09 adalah Rp11.550, tetapi bagian baris yang dihitung turun hanya Rp11.549. Tanpa swap refund diterima; setelah A ditukar ke barang lain seharga Rp10.000 dan barang pengganti gagal, resolve `manual_refund` mengembalikan 422 `REFUND_OVER_ORDER_ROOM` untuk nominal yang sama. | Selaraskan alokasi pembayaran chain dengan pembulatan komponen ORD-09 atau buat toleransi ORD-09 benar-benar berlaku pada refund pertama, sambil mempertahankan batas seluruh order dan toleransi nol untuk refund charge. Tambahkan test pasangan order identik tanpa swap dan dengan swap seharga sama: keduanya harus mengajukan Rp11.550 tanpa dipotong, dan total pengembalian tetap ≤ Rp34.651. |

## Jejak pembuktian P2

- Swap dengan selisih nol diperbolehkan: `order-recovery.service.ts:1197–1203` hanya meminta approval tambahan bila selisih positif. Pada order belum completed, replacement mempertahankan harga snapshot (`order-recovery-swap-kitchen.ts:245–262`), dan `:370` menghubungkannya melalui `replacementOrderItemId`.
- `order-given.ts:327–336` memetakan replacement ke original dan menandai chain sebagai swapped. Tidak perlu charge tambahan untuk masuk cabang pemeriksaan swap.
- `order-recovery.service.ts:976–981` meneruskan nominal baris dan ID replacement ke `lockOrderAndAssertManualRefundFits`. `order-recovery-refund.ts:149–155` menghitung refund komponen, lalu `:169` memanggil `assertLineFits`.
- Pembulatan half-up kumulatif di `order-recovery-refund-amount.ts:124–153`, dengan prior nol, menghasilkan `10.000 + round(1.500 × 10.000 / 30.001) + round(3.150 × 10.000 / 30.001) = 10.000 + 500 + 1.050 = 11.550`. Identitas total exclusive sah: `30.001 + 1.500 + 3.150 = 34.651`.
- `order-given.ts:439–440` menggunakan `floor(10.000 × 34.651 / 30.001) = 11.549`. Tanpa pengembalian sebelumnya dan tanpa charge, paid dan balance chain sama-sama Rp11.549. Kondisi baru di `:706` menjadi `11.550 <= min(11.549, 11.552)`, yaitu false. Kontrol tanpa swap lolos melalui `:710` karena balance sama dengan paid.
- Ini penolakan seluruh permintaan refund akibat selisih Rp1, bukan permintaan melonggarkan batas refund charge. Aritmetika dihitung ulang dengan BigInt oleh parent; jalur API/DB belum direproduksi langsung.

## Hasil pemeriksaan lainnya

- Dua skenario P1 ronde 3 tertutup secara statis: finance kini mengunci order berurutan menurut ID sebelum intent dan membaca ulang ruang (`payment-admin.service.ts:587–659`); refund charge online/manual menjalankan pemeriksaan order dan chain, termasuk pemeriksaan ulang saat approval manual. Ini bukan klaim test regresi sudah dijalankan.
- Hipotesis refund finance generik melewati batas charge tidak terbukti: intent dokumen ditolak pada `payment-admin.service.ts:634`, sedangkan charge paid/voided tetap ditahan oleh `chargeInUseOfIntent` (`:167–193`). Pelepasan hold lewat refund charge sudah diimbangi reservasi refund yang sama.
- Tidak ditemukan siklus kunci baru yang konkret antara finance `orders → intent`, refund charge `issue → order → charge → intent`, settlement `orders → link → intent`, dan payout/webhook. Jalur payout/webhook yang ditelusuri tidak mengambil kunci `orders` sesudah intent. Pemeriksaan tidak membuktikan ketiadaan seluruh kemungkinan deadlock.
- Tidak ada temuan baru lintas tenant/outlet yang terkonfirmasi pada perubahan yang diperiksa.
- Sesuai brief, tidak melaporkan ulang promo ORD-09 baris biasa (`legend-wpn5v`), void lewat kas sesudah ORD-09 (`legend-4yez0`), atau kode 409 lama di layar finance.

## Batas verifikasi

- Tidak menjalankan test database, barrier konkurensi, build, atau typecheck. Bukti berupa penelusuran statis dan perhitungan nominal; tidak ada klaim test hijau atau seluruh area refund sudah aman. Test pasangan P2 perlu dibuktikan engineer melalui `heavy` pada cabang target.
- `pnpm exec prettier --check docs/qa/second-opinion-refund-kasir-ronde4-1156.md` dan `pnpm exec eslint docs/qa/second-opinion-refund-kasir-ronde4-1156.md` dicoba; keduanya exit 1, `MODULE_NOT_FOUND`, karena executable dependency lokal Prettier/ESLint tidak tersedia. Format/lint belum terverifikasi; tidak memasang dependency atau mengubah lingkungan untuk audit ini.
