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

## Siapa yang boleh

Hanya owner tenant aktif, yaitu pengguna dengan role template `owner`. Role custom tidak diterima. Kode `pos.receipt.writeoff` tidak bisa dimasukkan ke role custom (ditolak dengan `PERMISSION_OWNER_ONLY`); role custom lama yang masih menyimpannya diabaikan saat dibaca. Role `owner` sendiri hanya bisa diberikan oleh owner tenant aktif (legend-7vsby).

Endpoint hanya berjalan di cloud, tidak di edge.

## Cara menjalankan

Ganti `:outletId` dengan ID outlet.

Tulis write-off (`POST`). Penulisan ini wajib verifikasi 2FA yang baru:

- Sesi belum pernah diverifikasi 2FA: ditolak `403` dengan `MFA_REQUIRED`.
- Verifikasi 2FA terakhir lebih dari 5 menit lalu: ditolak `401` dengan `REAUTH_REQUIRED`. Verifikasi 2FA lagi, lalu ulangi.

```
POST /outlets/:outletId/pos/receipt-writeoffs
{ "prefix": "C", "sequenceNumber": 2, "reason": "Struk fisik hilang, perangkat dicabut 3 Nov" }
```

Lihat daftar write-off outlet, terbaru di atas (`GET`). Membaca daftar tidak memerlukan 2FA, tetapi tetap hanya untuk owner:

```
GET /outlets/:outletId/pos/receipt-writeoffs
```

Respons berhasil `201` dengan `{ "data": ... }` untuk `POST`. Setelah berhasil, jalankan lagi Tutup Hari.

Kemungkinan penolakan:

- `403` `MFA_REQUIRED`, sesi belum pernah diverifikasi 2FA. Verifikasi 2FA, lalu ulangi.
- `401` `REAUTH_REQUIRED`, verifikasi 2FA sudah lebih dari 5 menit lalu, atau sesi sudah dicabut atau kedaluwarsa. Verifikasi 2FA lagi (atau masuk lagi), lalu ulangi.
- `409`, nomor di luar rentang yang sudah terbit (lebih besar dari nomor terakhir). Untuk run milik edge, batasnya nomor tertinggi yang sudah dilaporkan edge ke cloud (lihat "Outlet dengan edge").
- `409`, nomor ini sudah punya struk.
- `409`, nomor ini sudah di-write-off sebelumnya.
- `404`, prefix tidak dikenal.
- `403`, pengguna bukan owner (termasuk role custom yang memegang izin).
- `422`, alasan kurang dari 10 karakter.

### Outlet dengan edge

`GET` dan `POST` ke edge node ditolak dengan `409`: riwayat write-off hanya dikelola di cloud. Write-off tetap dibuat di cloud. Edge node menyalinnya saat sinkronisasi registri perangkat berikutnya (legend-jcby0), lalu Tutup Hari di edge menghitung nomor itu sebagai ada, sama seperti di cloud. Setelah tersalin, Tutup Hari di edge tetap berjalan walau edge sedang offline.

Untuk run yang dimiliki edge, cloud tidak menomori struk (edge yang menomori), jadi batas nomor write-off adalah nomor tertinggi yang sudah dilaporkan edge ke cloud saat sinkronisasi (legend-drzaf). Edge harus sudah sinkron (pull) setelah nomor itu terbit. Jika belum, write-off ditolak `409` "Nomor struk di luar rentang yang sudah terbit.": tunggu edge sinkron, lalu ulangi.

1. Buat write-off di cloud seperti di atas.
2. Tunggu sinkronisasi edge berikutnya (edge harus online sebentar). Write-off yang dibuat saat edge offline baru sampai setelah edge tersambung lagi.
3. Jalankan Tutup Hari di edge.

Jika Tutup Hari di edge masih ditolak:

- Edge belum sinkron sejak write-off dibuat. Cek status sinkronisasi edge, lalu ulangi.
- Edge masih versi lama (sebelum legend-jcby0) dan tidak meminta write-off. Tutup hari lewat cloud, atau perbarui edge.
- Cloud belum membawa legend-drzaf (migrasi 0166), atau edge masih versi sebelum legend-jcby0, sehingga write-off nomor run edge ditolak atau tidak tersalin. Jalan sementara: tutup hari lewat cloud. Gap cloud untuk run edge dihitung dari `last_number` cloud yang 0, jadi cloud tidak menahan Tutup Hari.
- Run di edge berbeda dengan run di cloud (misalnya database edge dipulihkan dari cadangan). Edge sengaja tidak memakai write-off untuk run yang tidak cocok. Hubungi tim teknis.

## Jika struk datang terlambat

Jika struk untuk nomor yang sudah di-write-off kemudian masuk (perangkat mengirim data), nomor itu dihitung ada lewat struk tersebut. Riwayat `GET` tetap menampilkan write-off itu, dan baris audit tetap ada. Yang berubah hanya daftar `writtenOff` di laporan shift, yang tidak lagi memuat nomor yang sudah punya struk. Cek perangkat yang sudah mengirim struk itu.

## Yang tercatat

Setiap write-off masuk audit dengan aksi `pos.receipt.written_off`. Audit mencatat pelaku, alasan, prefix, nomor urut, dan nomor struk yang sudah diformat. Data ini disimpan 2 tahun.

Di laporan shift, nomor tersebut tampil sebagai "di-write-off", bukan sebagai celah.

## Yang perlu disampaikan ke kasir

- Nomor struk itu tidak akan muncul lagi dan tidak bisa dikembalikan.
- Transaksi baru tetap memakai nomor berikutnya seperti biasa.

---

## Untuk tim teknis: rilis dan rollback

**Urutan rilis.** Migrasi 0155 (payroll) harus ikut atau dirilis sebelum 0156. Migrator melewati `when` yang lebih lama jika sudah ada `when` yang lebih baru yang diterapkan.

**Jendela kompatibilitas.** Migrasi 0156 menambahkan `pos.receipt.writeoff` ke baris template owner setiap tenant. API lama (sebelum legend-0hzqw) tidak mengenal kode ini. Parsing role di API lama bersifat ketat (`packages/shared/src/access/schemas.ts:39`, memakai katalog kode), sehingga role owner yang sudah memegang kode baru gagal diparsing dan daftar role rusak untuk tenant itu. Karena itu:

- Jalankan migrasi 0156 dan deploy API baru dalam satu langkah rilis, atau
- Jika migrasi sudah jalan lebih dulu, deploy API baru segera setelahnya. Selama jeda itu, daftar role tenant terdampak bisa gagal.
- Jangan pernah menyalakan API baru sebelum migrasi 0156 jalan. Tanpa tabel `receipt_number_writeoffs`, Tutup Hari dan laporan shift gagal.
- Jendela ini hanya berlaku di rilis pertama yang membawa 0156.

**Preflight.** Jalankan sebelum migrasi 0156 dan sebelum rollback. Pakai role dengan `BYPASSRLS` (tabel `roles` memakai FORCE RLS).

```sql
-- 1. Tenant tanpa baris template owner. Backfill 0156 melewatinya:
--    tenant ini tidak bisa write-off sampai baris owner ada.
SELECT t.id AS tenant_id
FROM public.tenants t
WHERE NOT EXISTS (
  SELECT 1 FROM public.roles r
  WHERE r.tenant_id = t.id AND r.is_template AND r.template_key = 'owner'
);

-- 2. Role custom yang memegang kode, per tenant (wajib dicek sebelum rollback).
SELECT tenant_id, count(*) AS role_custom_dengan_kode
FROM public.roles
WHERE NOT is_template AND permissions ? 'pos.receipt.writeoff'
GROUP BY tenant_id
ORDER BY tenant_id;
```

Tenant dari query 1 tidak bisa write-off. Laporkan daftarnya ke CTO sebelum rilis; cara perbaikannya (misalnya seed ulang template) perlu keputusan dan diuji terpisah, jangan menambah baris template dengan tangan. Role custom dari query 2 harus dicabut kodenya (lihat rollback (a)) atau dicatat sebagai keputusan.

**Sinkron ke edge (legend-jcby0).** Tanpa migrasi baru: edge memakai tabel `receipt_number_writeoffs` dari 0156. Rilis cloud dulu, lalu build edge. Edge baru ke cloud lama: cloud menolak parameter `receiptWriteoffs` (400), edge mengulang halaman tanpa parameter itu, dan Tutup Hari di edge tetap butuh jalan lewat cloud sampai cloud diperbarui.

**Write-off untuk run edge (legend-drzaf).** Migrasi 0166 hanya mengganti fungsi trigger `app.receipt_number_writeoffs_check_insert()` (batas jadi `GREATEST(last_number, edge_reported_number)`), tanpa mengubah tabel. Rilis cloud dulu (migrasi + API), lalu edge. Sebelum cloud ini terpasang, write-off nomor run edge ditolak; pakai jalan sementara di "Outlet dengan edge". Trigger di DB edge tetap ketat (`last_number` lokal).

**Rollback (a): cabut izin dari semua role.** Lakukan sebelum API lama dinyalakan. Kode ini harus dicabut dari template owner dan dari role custom, karena API lama menolak role yang memegang kode yang tidak dikenalnya. UPDATE ini tidak menulis audit atau access event, jadi catat audit manual: siapa, kapan, jumlah role per tenant (simpan hasil query preflight 2). Jangan memutar ulang access event yang memuat kode baru ke API lama; parsingnya juga ketat.

```sql
-- Per tenant, dari role dengan BYPASSRLS (atau ulangi per tenant dengan set_config).
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
      AND permissions ? 'pos.receipt.writeoff';
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous_tenant, ''), true);
END $$;
```

**Rollback (b): hapus tabel.** Utamakan perbaikan maju (fix forward). Rollback membuat Tutup Hari kembali diblokir.

Urutan wajib:

1. **Rollback (a)** di atas, lalu **rollback API** ke build sebelum legend-0hzqw. Kode saat ini mengakses `receipt_number_writeoffs` pada setiap Tutup Hari dan laporan shift. Jika tabel dihapus sebelum API diturunkan, operasi itu gagal.
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
