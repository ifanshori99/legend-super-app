# Upgrade aturan pembuat dan approver payroll (549)

Runbook ini untuk tim rilis. Pembuat run harus berbeda dari approver HR dan
finance; kedua approver juga harus berbeda satu sama lain. Keputusan CTO:
constraint `payroll_runs_distinct_approvers_check` ditambahkan sebagai `NOT VALID`.
Baris historis tidak diubah atau dihapus oleh migrasi.

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

Hitungan lebih dari nol tidak membatalkan upgrade: keputusan CTO memang
mempertahankan baris lama sebagai bukti historis. Laporkan hitungannya ke CTO;
jangan memperbaiki kolom pembuat/approver, menghitung ulang run beku, atau
menghapus run agar migrasi lolos.

## Urutan dan hasil migrasi

1. Migrasi `0350_payroll_run_approvers_not_creator.sql` sengaja diperbaiki dengan
   `NOT VALID`. Ini diperlukan untuk database yang belum menerapkan 0350:
   migrasi koreksi setelahnya tidak dapat menolong jika upgrade sudah gagal
   pada validasi 0350. Ekspresi pemeriksaan tetap sama.
2. Migrasi `0381_payroll_run_approvers_not_valid.sql` mengganti constraint dengan
   ekspresi yang sama dan `NOT VALID` untuk database yang sudah menerapkan
   versi awal 0350. Migrasi ini tidak menulis baris payroll.
3. Setiap `INSERT` dan `UPDATE` baru tetap diperiksa oleh PostgreSQL. Penulisan
   pembuat = approver, atau HR = finance, ditolak dengan SQLSTATE `23514`.
   `NOT VALID` hanya melewatkan pemindaian data yang sudah ada saat penambahan
   constraint, bukan pengecualian pemeriksaan pada penulisan berikutnya.

Baris lama yang melanggar tetap bisa dibaca, tetapi `UPDATE` apa pun pada baris
tersebut juga ditolak selama pelanggarannya masih ada. Run beku harus tetap
beku. Tindak lanjut untuk run historis yang belum beku memerlukan peninjauan
terpisah oleh HR/finance; migrasi ini tidak memberi persetujuan ulang atau
mengubah riwayat secara otomatis.

## Pemeriksaan setelah migrasi

Ulangi preflight dan pastikan jumlah serta rincian agregat tidak berubah.
Periksa definisi constraint menggunakan akun administrator yang sama:

```sql
SELECT convalidated,
       pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.payroll_runs'::regclass
  AND conname = 'payroll_runs_distinct_approvers_check';
```

Hasil wajib satu baris dengan `convalidated = false` dan definisi yang berakhir
`NOT VALID`. Jangan menjalankan `VALIDATE CONSTRAINT` sebagai bagian rilis ini.
Jangan menghapus constraint untuk rollback aplikasi: pemeriksaan tulis tetap
berlaku pada versi API lama maupun baru. Perubahan kebijakan berikutnya harus
melalui migrasi dan keputusan CTO tersendiri.
