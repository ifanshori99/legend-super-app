# Upgrade aturan pembuat dan approver payroll (549 / G688h)

Runbook ini untuk tim rilis. Pembuat run harus berbeda dari approver HR dan
finance; kedua approver juga harus berbeda satu sama lain. Keputusan CTO:
trigger `payroll_runs_approvers_guard_trg` memeriksa setiap `INSERT` serta
`UPDATE` yang benar-benar mengubah pembuat atau approver. Baris historis tidak
diubah atau dihapus oleh migrasi.

## Preflight sebelum migrasi

Jalankan query baca saja berikut sebagai administrator dengan `BYPASSRLS` atau
superuser. Tabel `payroll_runs` memakai FORCE RLS; akun aplikasi tanpa konteks
tenant tidak memberi hitungan lintas tenant yang lengkap. Simpan hasil hitungan
bersama catatan rilis, waktu pemeriksaan, dan pelaku; jangan menyalin identitas
approver atau rincian gaji ke log rilis.

```sql
BEGIN READ ONLY;

-- Jumlah run lama dengan pembuat = salah satu approver (setiap run dihitung sekali).
SELECT count(*) AS historical_creator_approver_rows
FROM public.payroll_runs
WHERE approved_by_hr = created_by
   OR approved_by_finance = created_by;

-- Rincian agregat untuk tindak lanjut HR/finance; satu run dapat ada di dua kolom.
SELECT tenant_id,
       legal_entity_id,
       status,
       count(*) AS historical_creator_approver_rows,
       count(*) FILTER (WHERE approved_by_hr = created_by) AS creator_is_hr,
       count(*) FILTER (WHERE approved_by_finance = created_by) AS creator_is_finance
FROM public.payroll_runs
WHERE approved_by_hr = created_by
   OR approved_by_finance = created_by
GROUP BY tenant_id, legal_entity_id, status
ORDER BY tenant_id, legal_entity_id, status;

COMMIT;
```

Hitungan lebih dari nol tidak membatalkan upgrade: keputusan CTO mempertahankan
baris lama sebagai bukti historis. Laporkan hitungannya ke CTO; jangan memperbaiki
kolom pembuat/approver, menghitung ulang run beku, atau menghapus run agar migrasi
lolos.

## Urutan dan hasil migrasi

1. Migrasi `0350_payroll_run_approvers_not_creator.sql` sengaja diperbaiki untuk
   mengganti CHECK lama dengan trigger. Ini menjaga jalur upgrade yang belum
   menerapkan 0350; migrasi koreksi setelahnya tidak dapat menolong jika upgrade
   sudah gagal sebelumnya.
2. Migrasi `0381_payroll_run_approvers_not_valid.sql` memakai penggantian idempoten
   yang sama. Nama historis migrasi dipertahankan untuk jurnal; CHECK `NOT VALID`
   tetap memeriksa setiap UPDATE sehingga tidak lagi dipakai untuk aturan ini.
3. Migrasi `0384_payroll_run_approver_write_guard.sql` memasang guard yang sama
   untuk database yang sudah mencatat versi lama 0350 dan 0381. Ketiga migrasi
   tidak menulis baris payroll atau payslip.
4. Setiap INSERT, atau UPDATE yang mengubah nilai `created_by`, `approved_by_hr`,
   atau `approved_by_finance`, tetap menolak pembuat = approver dan HR = finance
   dengan SQLSTATE `23514`. Diagnostic constraint tetap bernama
   `payroll_runs_distinct_approvers_check`, tetapi tidak ada CHECK dengan nama
   tersebut lagi. Kolom approver yang NULL tetap diperbolehkan.

Run lama yang identitas pembuat/approvernya tetap sama dapat melanjutkan transisi
`locked` ke `paid` atau `reversed` sesuai guard lifecycle yang sudah ada. Penulisan
nilai identitas yang sama juga diperbolehkan. Konfigurasi, total, periode,
persetujuan, dan slip beku tetap dilindungi guard sebelumnya; trigger baru tidak
memberi persetujuan ulang, mengubah gaji, atau menambah pembayaran. Run `paid` dan
`reversed` tetap tidak dapat diubah.

## Pemeriksaan setelah migrasi

Ulangi preflight segera setelah migrasi, sebelum transisi bisnis berikutnya,
dan pastikan jumlah serta rincian agregat tidak berubah. Gunakan akun
administrator yang sama untuk memastikan CHECK lama sudah hilang dan trigger
aktif:

```sql
SELECT count(*) AS legacy_check_count
FROM pg_constraint
WHERE conrelid = 'public.payroll_runs'::regclass
  AND conname = 'payroll_runs_distinct_approvers_check';

SELECT tgname,
       tgenabled,
       pg_get_triggerdef(oid) AS definition,
       pg_get_functiondef(tgfoid) AS guard_definition
FROM pg_trigger
WHERE tgrelid = 'public.payroll_runs'::regclass
  AND tgname = 'payroll_runs_approvers_guard_trg'
  AND NOT tgisinternal;
```

Hasil wajib `legacy_check_count = 0` serta satu trigger dengan `tgenabled = 'O'`
dan definisi `BEFORE INSERT OR UPDATE`. Fungsi guard harus memeriksa perubahan
tuple identitas dengan `IS NOT DISTINCT FROM` sebelum memeriksa ketiga larangan
pembuat/approver. Jangan menonaktifkan trigger atau memakai
`session_replication_role = replica` saat membuktikan penolakan penulisan baru.

Rollback aplikasi tetap mempertahankan trigger database: aturan tulis berlaku
pada versi API lama maupun baru. Mengembalikan CHECK lama dapat memblokir lagi
transisi run historis, sehingga perubahan database berikutnya memerlukan migrasi
dan keputusan CTO tersendiri.
