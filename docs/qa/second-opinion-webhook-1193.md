# Second opinion webhook ronde 2 — 1193

Tanggal: 19 November 2026. Peran: second-opinion. Review delta dengan tiga subagent read-only (penutupan 1180, malformed/signature/tenant, serta replay/race), lalu verifikasi silang oleh parent.

## Cakupan dan hasil

- `git fetch origin` berhasil; kedua nama cabang tersedia, sehingga fallback merge-base milestone tidak diperlukan.
- Rentang yang diperiksa: `git diff origin/ws/1176-webhook-opname-p3...origin/ws/1182-webhook-malformed-so1180 -- apps/api`.
- Base: `4fdcaaec10aa28a1c9c423ac91578202b8a39521`; head: `9db6edfff896add6955463b8b372b58a9842618f`. Base merupakan parent langsung head.
- Delta: dua berkas, 628 penambahan dan tiga penghapusan; implementasi hanya berubah pada recovery MALFORMED di `payment-webhook.service.ts`, disertai satu berkas berisi lima test baru.
- Nomor baris kode dan test di laporan ini merujuk head tersebut, bukan checkout folder utama.
- **Temuan baru: P0: 0, P1: 0, P2: 0, P3: 0.** Tidak ditemukan skenario gagal konkret tambahan pada delta yang ditinjau.

## Status seluruh temuan 1180

Laporan `docs/qa/second-opinion-webhook-opname-1180.md` memuat satu temuan, P1-1.

| ID 1180 | Status ronde 2 | Bukti dan skenario |
| --- | --- | --- |
| P1-1 — Row lama setelah fill MALFORMED menghilangkan binding bersama | **Tertutup secara statis; belum diverifikasi lewat eksekusi test pada review ini.** | `apps/api/src/services/payment-webhook.service.ts:4036` kini mengembalikan seluruh row hasil UPDATE, lalu `:4044` memakai `row = filled`. Pemrosesan di `:4093` menerima binding `[T,O]` hasil fill; pembacaan binding recurring di `:3471` tidak lagi memakai fallback `[T]` dari objek lama. Skenario T/O berbagi secret, row MALFORMED milik T, T nonaktif, dan invoice langganan O dibayar telah dicakup oleh test baru. |

Usul test regresi 1180 sudah diwujudkan dalam `apps/api/src/test/payment-doit-webhook-malformed-recovery-binding.test.ts`:

- `:490`: Recovery pada row T setelah T dinonaktifkan; satu event tetap milik T, binding T/O, invoice berbayar, dan langganan aktif.
- `:503`: Sweep dan resend berikutnya tidak menambah invoice, mengubah waktu pembayaran/aktivasi, atau menambah outbox; resend menjadi duplicate.
- `:541`: Secret bersama merupakan previous secret T yang masih dalam grace; recovery dan resend tetap memakai binding yang benar.
- `:563`: Langganan integrasi X yang tidak memverifikasi event tidak boleh dibayar.
- `:597`: Nominal event berbeda dari invoice tidak boleh melunasi invoice atau mengaktifkan langganan.

Test ini memakai status invoice, `paid_at`, status/masa aktif langganan, dan outbox sebagai bukti perubahan. Assertion outbox tidak menggantikan verifikasi jurnal keuangan; test ini tidak memeriksa saldo atau jurnal dana.

## Pemeriksaan risiko delta

| Area | Bukti alur pada head | Penilaian |
| --- | --- | --- |
| Malformed mengubah status bayar | Signature diverifikasi di `apps/api/src/services/payment-webhook.service.ts:3805`; kegagalan verifikasi berhenti di `:3840`. Parsing yang gagal disimpan sebagai MALFORMED tanpa payload dan melempar 500 di `:3944`. Fill hanya dicapai setelah parsing berhasil. | Tidak ditemukan jalur baru untuk membayar dari payload malformed. |
| Bypass signature dan binding | Perubahan di `:4036` tidak mengubah pemeriksaan signature atau pembentukan `verifiedIntegrationIdsOf` (`:520`). Recurring menerima binding tersimpan di `:3471`. | Tidak ditemukan bypass baru; test integrasi X dan nominal berbeda memberi guard tambahan. |
| Lintas tenant/integrasi | Fill di `:4027` membatasi tenant, ID row, integrasi, status claimable, dan payload NULL. Lookup row di `:3624` juga membatasi tenant/provider/integrasi/signature-valid. | Row hasil RETURNING tetap row yang lolos batas tersebut; tidak ditemukan perluasan akses. |
| Replay, event ganda, atau hilang | Dedupe insert di `:3544`; row terminal menjadi duplicate di `:4001`. Pemenang fill memakai row baru di `:4044`; yang kalah tidak memperoleh klaim baru hanya karena membaca ulang row. | Fix membawa binding baru ke pemrosesan langsung dan menutup kehilangan pembayaran pada P1-1; tidak ditemukan regresi idempotensi konkret. |
| Race callback versus sweep/polling | Fill mensyaratkan `claimableStatus(now)` dan payload NULL (`:4031`); fill menetapkan received/waktu claim (`:4023`). Retry biasa mengklaim terhadap `loadedRow` lama (`:4009`, `:4062`) melalui status dan `untouchedSince` (`:3763`). Recurring juga mengunci langganan (`apps/api/src/services/payment-recurring.service.ts:1773`) dan mempunyai guard invoice paid (`:2122`). | Predikat claim tidak berubah. Tidak ditemukan race baru akibat penggantian objek row; interleaving nyata belum diuji pada review ini. |

## Usul test tambahan dan batas bukti

- Tambahkan test interleaving dua callback pemulihan dan worker dengan barrier: keduanya membaca row MALFORMED yang sama, hanya satu fill menang, pihak lain tidak memproses received segar, dan sweep/resend akhir tidak menambah pembayaran atau outbox. Test `:503` saat ini menjalankan sweep dan resend berurutan.
- Untuk jalur pembayaran yang mempunyai polling, jalankan callback recovery bersamaan dengan hasil polling paid untuk intent sama; pastikan bukti bayar dan jurnal tetap satu serta nominal tidak melebihi tagihan. Delta ini tidak mengubah implementasi polling dan lima test baru berfokus pada recurring.
- Usul di atas adalah tambahan pembuktian, bukan temuan P0–P3: review tidak membuktikan skenario kegagalan baru.

## Verifikasi dan batas pelaksanaan

- Pembacaan `git diff`/`git show` pada SHA tetap, laporan 1180, serta konteks layanan dan test terkait; tiga pemeriksa read-only dan parent tidak menemukan temuan tambahan konkret.
- `git diff --check origin/ws/1176-webhook-opname-p3...9db6edfff -- apps/api` lulus.
- `pnpm exec prettier --check docs/qa/second-opinion-webhook-1193.md` tidak dapat dijalankan: modul lokal `node_modules/prettier/bin/prettier.cjs` tidak tersedia (`MODULE_NOT_FOUND`). Tidak memasang dependensi untuk review ini.
- Tidak menjalankan test aplikasi/database, typecheck, build, atau simulasi konkurensi. Keberadaan test bukan klaim bahwa test lulus; penutupan P1-1 di atas adalah penilaian statis.
- Tidak checkout, membuat worktree, commit, push, menjalankan setup, atau mengubah kode. Satu-satunya berkas yang ditulis oleh tugas ini adalah laporan ini; berkas lain yang sudah ada dipertahankan.
