# Hapus nomor struk yang hilang (write-off) (legend-0hzqw)

Runbook ini untuk owner tenant. Write-off menandai satu nomor struk (prefix + nomor urut) sebagai hilang permanen, dengan alasan tertulis. Setelah itu nomor tersebut dihitung seperti sudah ada, sehingga Tutup Hari bisa berjalan lagi.

## Kapan dipakai

- Tutup Hari ditolak dengan pesan: `Ada nomor struk yang hilang di outlet ini: ...`.
- Nomor yang hilang berasal dari perangkat yang sudah tidak aktif, perangkat yang dicabut, atau run yang sudah pensiun. Tidak ada perangkat yang bisa mengirim ulang nomor itu.

Jangan dipakai untuk menutupi nomor yang masih mungkin dikirim perangkat. Write-off tidak bisa dibatalkan.

## Cek dulu sebelum write-off

1. Cari struk di perangkat yang bersangkutan dan di cadangan edge (jika outlet memakainya). Pastikan nomor itu benar-benar tidak ada.
2. Cek status sinkronisasi. Pastikan perangkat tidak punya data yang belum terkirim.
3. Pastikan nomor itu memang tidak pernah dipakai untuk transaksi.
4. Catat alasan. Alasan wajib 10 sampai 500 karakter dan akan ikut tercatat di audit.

## Cara menjalankan

Hanya owner tenant yang punya izin `pos.receipt.writeoff`. Endpoint hanya berjalan di cloud, tidak di edge.

Penulisan write-off wajib 2FA. Verifikasi 2FA di sesi ini dulu. Jika belum, permintaan ditolak dengan `MFA_REQUIRED`. Membaca daftar (`GET`) tidak memerlukan 2FA.

Ganti `:outletId` dengan ID outlet.

Tulis write-off (`POST`):

```
POST /outlets/:outletId/pos/receipt-writeoffs
{ "prefix": "C", "sequenceNumber": 2, "reason": "Struk fisik hilang, perangkat dicabut 3 Nov" }
```

Lihat daftar write-off outlet, terbaru di atas (`GET`):

```
GET /outlets/:outletId/pos/receipt-writeoffs
```

Respons berhasil `201` dengan `{ "data": ... }`. Setelah berhasil, jalankan lagi Tutup Hari.

Kemungkinan penolakan:

- `MFA_REQUIRED`, sesi belum terverifikasi 2FA. Verifikasi 2FA, lalu ulangi.
- `409`, nomor di luar rentang yang sudah terbit (lebih besar dari nomor terakhir).
- `409`, nomor ini sudah punya struk.
- `409`, nomor ini sudah di-write-off sebelumnya.
- `404`, prefix tidak dikenal.
- `403`, pengguna bukan owner.
- `400`, alasan kurang dari 10 karakter.

### Outlet dengan edge

Write-off tetap dibuat di cloud. Edge node menyalinnya saat sinkronisasi registri perangkat berikutnya (legend-jcby0), lalu Tutup Hari di edge menghitung nomor itu sebagai ada, sama seperti di cloud. Setelah tersalin, Tutup Hari di edge tetap berjalan walau edge sedang offline.

1. Buat write-off di cloud seperti di atas.
2. Tunggu sinkronisasi edge berikutnya (edge harus online sebentar). Write-off yang dibuat saat edge offline baru sampai setelah edge tersambung lagi.
3. Jalankan Tutup Hari di edge.

Jika Tutup Hari di edge masih ditolak:

- Edge belum sinkron sejak write-off dibuat. Cek status sinkronisasi edge, lalu ulangi.
- Edge masih versi lama (sebelum legend-jcby0) dan tidak meminta write-off. Tutup hari lewat cloud, atau perbarui edge.
- Run di edge berbeda dengan run di cloud (misalnya database edge dipulihkan dari cadangan). Edge sengaja tidak memakai write-off untuk run yang tidak cocok. Hubungi tim teknis.

## Jika struk datang terlambat

Jika struk untuk nomor yang sudah di-write-off kemudian masuk (perangkat mengirim data), nomor itu dihitung ada lewat struk tersebut. Nomor keluar dari daftar write-off. Baris audit tetap ada. Cek perangkat yang sudah mengirim struk itu.

## Yang tercatat

Setiap write-off masuk audit dengan aksi `pos.receipt.written_off`. Audit mencatat pelaku, alasan, prefix, nomor urut, dan nomor struk yang sudah diformat. Data ini disimpan 2 tahun.

Di laporan shift, nomor tersebut tampil sebagai "di-write-off", bukan sebagai celah.

## Yang perlu disampaikan ke kasir

- Nomor struk itu tidak akan muncul lagi dan tidak bisa dikembalikan.
- Transaksi baru tetap memakai nomor berikutnya seperti biasa.

---

## Untuk tim teknis: rilis dan rollback

**Urutan rilis.** Migrasi 0155 (payroll) harus ikut atau dirilis sebelum 0156. Migrator melewati `when` yang lebih lama jika sudah ada `when` yang lebih baru yang diterapkan.

**Sinkron ke edge (legend-jcby0).** Tanpa migrasi baru: edge memakai tabel `receipt_number_writeoffs` dari 0156. Rilis cloud dulu, lalu build edge. Edge baru ke cloud lama: cloud menolak parameter `receiptWriteoffs` (400), edge mengulang halaman tanpa parameter itu, dan Tutup Hari di edge tetap butuh jalan lewat cloud sampai cloud diperbarui.

**Rollback.** Utamakan perbaikan maju (fix forward). Rollback membuat Tutup Hari kembali diblokir.

Urutan wajib:

1. **Rollback API dulu** ke build sebelum legend-0hzqw. Kode saat ini mengakses `receipt_number_writeoffs` pada setiap Tutup Hari dan laporan shift. Jika tabel dihapus sebelum API diturunkan, operasi itu gagal.
2. **Ekspor** isi tabel sebagai bukti audit. Tabel memakai FORCE RLS (policy memanggil `app.require_tenant_id()`), sehingga ekspor biasa tanpa tenant akan kosong. Pakai role dengan `BYPASSRLS`, atau ulangi ekspor per tenant dengan `set_config('app.tenant_id', ...)`.
3. **Bandingkan** jumlah baris hasil ekspor dengan `count(*)`. Hapus tabel hanya jika keduanya sama.
4. **Hapus** dalam satu transaksi.

```sql
-- Sesi psql. Berhenti di error pertama.
\set ON_ERROR_STOP on

-- 2. Ekspor (bukti audit). Jalankan sebagai role BYPASSRLS.
\copy (SELECT * FROM public.receipt_number_writeoffs ORDER BY created_at, id) TO 'receipt_number_writeoffs_export.csv' CSV HEADER
SELECT count(*) AS jumlah_tabel FROM public.receipt_number_writeoffs;
-- Jumlah baris CSV (tanpa header) harus sama dengan jumlah_tabel.
-- Catatan: alasan bisa berisi baris baru, jadi hitung dengan CSV parser, bukan wc -l.

-- 3. Hapus dalam satu transaksi.
BEGIN;

DROP TRIGGER IF EXISTS receipt_number_writeoffs_check_insert_trg ON public.receipt_number_writeoffs;
DROP TRIGGER IF EXISTS receipt_number_writeoffs_append_only_trg ON public.receipt_number_writeoffs;
DROP FUNCTION IF EXISTS app.receipt_number_writeoffs_check_insert();
DROP FUNCTION IF EXISTS app.receipt_number_writeoffs_append_only();
DROP TABLE IF EXISTS public.receipt_number_writeoffs;

-- Cabut izin pos.receipt.writeoff dari template owner, per tenant.
-- Pola sama dengan loop di apps/api/drizzle/0156_receipt_number_writeoffs.sql.
DO $$
DECLARE
  target uuid;
  previous_tenant text;
BEGIN
  previous_tenant := current_setting('app.tenant_id', true);
  FOR target IN SELECT id FROM public.tenants LOOP
    PERFORM set_config('app.tenant_id', target::text, true);
    UPDATE public.roles
    SET permissions = permissions - 'pos.receipt.writeoff',
        updated_at = now()
    WHERE tenant_id = target
      AND is_template
      AND template_key = 'owner';
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous_tenant, ''), true);
END $$;

-- Hapus catatan migrasi 0156 dari riwayat drizzle (schema drizzle, tabel __drizzle_migrations).
-- Aman hanya jika 0156 adalah migrasi terbaru yang sudah diterapkan. Jika ada catatan yang
-- lebih baru, blok ini gagal dan seluruh transaksi di-rollback.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at > 1794235000000) THEN
    RAISE EXCEPTION '0156 bukan migrasi terbaru; batal, jangan lanjut';
  END IF;
  DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794235000000;
END $$;

COMMIT;
```
