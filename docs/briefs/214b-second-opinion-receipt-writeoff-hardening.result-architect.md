# 214b result, architect 1 (review ganda Claude, brief 225)

Kartu: legend-l56xd, legend-xlvvl (legend-7vsby sudah diperbaiki di 16435142). Catatan: kode write-off belum ada di `milestone/m1` (94d769c6). Kode ini masuk lewat `integ/m1-batch29` (efe54656), jadi dibaca di `integ/m1-batch31` (6fad1401).

Hasil: Bersih untuk P1/P2. Ada dua catatan P3.

## Per pertanyaan

1. Hanya owner: OK.
   - `pos-receipt-writeoff.routes.ts:45-53` memanggil `allowsVia("owner")` (`permission-resolver.ts:346-367`). Fungsi ini menyaring assignment ke role template owner, lalu `authorize` mengecek masa aktif, pencabutan, dan jangkauan outlet. Assignment kedaluwarsa atau dicabut tidak lolos.
   - Template owner di scope outlet hanya berlaku untuk outlet itu. Itu pilihan owner.
   - Super admin platform tidak punya assignment, jadi ditolak. Sesi impersonate tidak punya `mfa_verified_at` dan rute MFA tertutup oleh guard support, jadi hasilnya 403 MFA_REQUIRED.
   - Snapshot dimuat sekali per request dan dipakai bersama oleh `owner` dan `ownerTemplateOnly`. Pencabutan di tengah request hanya berlaku mulai request berikutnya. Ini P3 dan sama dengan semua rute lain.
2. Re-auth: OK. `mfa_verified_at` dicap dengan jam API (`identity-mfa.service.ts:278`), lalu dibandingkan dengan `Date.now()` lewat rumus yang sama seperti `grants.ts:129`. `age >= 0` menolak cap dari masa depan. Selisih jam antar instance bisa memicu REAUTH_REQUIRED palsu. Akibatnya gagal tertutup, sama seperti jalur role-grant. Sesi yang dicabut atau kedaluwarsa ditolak (`:64-68`). Jika sesi tidak ditemukan, hasilnya MFA_REQUIRED.
3. Race: OK.
   - Bug lama: `writeoffOrdinalsBySequence` memakai NOT EXISTS receipt. Bila receipt dibaca dulu lalu write-off dibaca, receipt telat di antara keduanya membuat celah palsu.
   - Perbaikan: `UNION ALL` dalam satu statement (`pos-receipt.service.ts:1851`) memberi satu snapshot READ COMMITTED.
   - Test `pos-receipt-writeoff.test.ts:1254` menyisipkan receipt sesudah statement receipt pertama. Test ini gagal pada urutan dua statement yang lama.
   - Jalur cepat (`receiptGapsForOutletFast`, `receiptGapsOfRun`) membaca hitungan, lalu write-off, lalu receipt lagi. Receipt bersifat append-only, jadi urutan ini tidak bisa menyembunyikan celah.
4. Runbook: OK.
   - Preflight dijalankan dengan BYPASSRLS, dan FORCE RLS tidak berlaku untuk role itu.
   - Rollback (a) men-set `app.tenant_id` per tenant, dan `tenants` tidak memakai RLS. Kolom `permissions` bertipe jsonb, jadi operator `-` dan `?` benar.
   - Jendela kompatibilitas ditulis dengan benar.
   - P3: penjaga rollback (b) (`runbook:179`) membatalkan proses bila ada migrasi sesudah 0156. Di batch31 sudah ada 0157-0162, jadi rollback (b) tidak bisa dipakai lagi dan runbook tidak memberi jalan lain. Tulis bahwa sesudah 0157 jalannya fix forward.
5. Sisa 201b: tidak ada P1/P2 baru. Sudah ada kartu untuk alarm struk telat (legend-refx7), UI (legend-vsw4q), dan status puller edge (legend-mqh2m).

## Temuan P1/P2

Tidak ada.
