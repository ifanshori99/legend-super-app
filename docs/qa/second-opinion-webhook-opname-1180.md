# Second opinion webhook/secret dan opname buta — 1180

Tanggal: 19 November 2026. Peran: second-opinion. Pemeriksaan statis dengan tiga subagent per area, lalu verifikasi silang oleh parent.

## Cakupan dan hasil

- `git fetch origin` berhasil.
- Rentang: `git diff origin/ws/1144-refund-hold-echo...4fdcaaec1`.
- Merge-base: `d217d439dba9b6e7030f27f6dce9076b3c432343`; target mencakup `1014c8963` (ws/1167) dan `4fdcaaec1` (ws/1176).
- Seluruh nomor baris kode di laporan ini merujuk target `4fdcaaec1`, bukan checkout folder utama.
- Hasil: **P0: 0, P1: 1, P2: 0, P3: 0**. Temuan P1 perlu diperbaiki sebelum gerbang rilis.

## Temuan

| ID | Tingkat | Berkas:baris | Masalah, skenario gagal, dan perbaikan |
| --- | --- | --- | --- |
| P1-1 | P1 | `apps/api/src/services/payment-webhook.service.ts:4038` | Pemulihan MALFORMED memakai objek `row` lama sesudah fill menyimpan binding integrasi baru. T dan O berbagi secret; event `invoice.paid` langganan O tersimpan MALFORMED atas T; T dinonaktifkan; retry sah diarahkan kembali ke T oleh `storedEventOwner`. UPDATE menyimpan `[T,O]`, tetapi pemrosesan langsung memakai fallback `[T]`, menghasilkan `INTEGRATION_MISMATCH` dan status `ignored` permanen. Pembayaran perpanjangan tidak tercatat, pengiriman berikutnya menjadi duplicate, dan worker melewati event. Gunakan seluruh row hasil `UPDATE ... RETURNING` untuk pemrosesan, termasuk `verifiedIntegrationIds`, payload, status, dan waktu claim yang baru. |

### Bukti alur P1-1

1. `storedEventOwner` dipanggil di `payment-webhook.service.ts:3848`; secret yang sama masih dimiliki T sehingga retry yang mula-mula terverifikasi sebagai O diatribusikan ke baris T.
2. Baris MALFORMED dibuat tanpa `verifiedIntegrationIds` (`:3945–3956`). Retry menghitung binding bersama (`:3971–3974`) dan menyimpannya saat fill (`:4022`).
3. UPDATE hanya mengembalikan `id` (`:4036`); cabang sukses hanya mengubah `useStored` (`:4038`). Objek `row` tetap hasil pembacaan sebelum fill dan diteruskan ke `processStoredEvent` (`:4087–4093`).
4. `processInvoiceEvent` membaca binding dari objek lama: `row.verifiedIntegrationIds ?? [row.integrationId]` (`:3471–3473`), sehingga yang diterima hanya T.
5. Langganan terikat O ditolak oleh `apps/api/src/services/payment-recurring.service.ts:1788–1793`; webhook ditandai `ignored` (`payment-webhook.service.ts:3501–3509`). Resend berhenti sebagai duplicate (`:4001–4002`); kedua worker hanya mengambil baris unfinished.

Ini regresi pada jalur pemulihan baru f03o: di base, setelah T dinonaktifkan, retry memilih O dan memasukkan baris baru dengan binding O sehingga pembayaran langganan O dapat diterima. Target menyatukannya kembali ke T, tetapi belum membawa binding hasil fill ke pemrosesan langsung. Mekanisme objek stale sudah ada di base; atribusi ulang baru membuat skenario ini kehilangan pembayaran.

### Usul test regresi P1-1

- Buat T dan O dengan secret sama; siapkan langganan O dan invoice terbuka dengan amount/periode yang sah.
- Simpan event `invoice.paid` sebagai MALFORMED milik T (`payload = NULL`, `verified_integration_ids = NULL`), lalu nonaktifkan T dan bersihkan cache secret.
- Kirim ulang event ID yang sama dengan payload valid dan tanda tangan secret bersama.
- Harapkan hanya satu baris event, tetap milik T, binding mencakup T dan O, status `processed`, serta invoice dan bukti pembayaran tercatat tepat sekali. Status `ignored`/`INTEGRATION_MISMATCH` harus menggagalkan test.
- Jalankan kedua sweep dan resend lagi; pastikan tidak ada pembayaran, bukti, ataupun jurnal tambahan. Ulangi dengan secret T sebagai previous secret yang masih dalam grace.

## Area tanpa temuan tambahan konkret

- **Secret dan isolasi:** Pencarian pemilik event dibatasi tenant/provider; atribusi ulang mensyaratkan secret pemilik saat ini atau previous secret dalam grace. Payload tersimpan tetap dipakai pada retry biasa.
- **Claim dan pemulihan:** Redelivery, worker biasa, dan recurring sweep memakai claim bersyarat; received segar tidak diambil. Backoff, batas crash tanpa outcome, STUCK_EXHAUSTED, dan rollback status ketika alert gagal diperiksa. Tidak ada skenario tambahan terbukti untuk pemrosesan pembayaran ganda atau event terparkir yang hilang.
- **Alert refund unmatched:** Identitas baru konsisten dengan switched-off: tenant, integrasi intent, intent, dan refund ID; perubahan event ID/amount tidak membuat identitas baru pada jalur yang ditinjau.
- **Opname buta:** Guard FEFO (`inventory-expiry.service.ts:302–325`) dan retur pembelian (`purchase-return.service.ts:943–990`) berada sebelum pembacaan stok. Actor dan riwayat counter diteruskan ke guard. Tidak ditemukan cabang hasil yang bergantung pada stok tersembunyi untuk counter dalam cakupan diff.
- **Akses route qi21:** Perubahan hanya menambah test template role dan isolasi tenant; tidak ditemukan perubahan implementasi yang membuka akses.

## Verifikasi dan batas

- Bukti berasal dari `git diff` dan `git show` atas target serta konteks layanan/test terkait; P1 diverifikasi silang oleh dua pemeriksa dan dibandingkan dengan base.
- Tidak menjalankan test aplikasi, build, typecheck, atau pengukuran waktu respons. Skenario P1 terbukti dari alur kode, belum direproduksi terhadap database saat review ini.
- `pnpm exec prettier --check docs/qa/second-opinion-webhook-opname-1180.md` tidak dapat berjalan: modul lokal `prettier/bin/prettier.cjs` tidak tersedia (`MODULE_NOT_FOUND`). Tidak memasang dependensi dalam tugas read-only ini.
- Tidak checkout, membuat worktree, commit, atau push. Satu-satunya berkas yang ditulis oleh review ini adalah laporan ini; berkas lain yang sudah ada di folder utama dipertahankan.
