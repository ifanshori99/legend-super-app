# G688h: finalisasi rapel dan transisi approver legacy

Basis `df4fffcd`, worktree `.worktrees/payroll-engine`, branch `ws/payroll-engine`. Perintah CTO: dua butir, bukti gagal dulu dan commit per butir; tanpa merge/push. Hanya payroll, tanpa perubahan accounting atau HRIS non-payroll.

## 1. Revisi alokasi dan finalisasi terkunci

Masalah: alokasi kedua menggunakan ID slip yang sama; seal preview lama tetap bisa ditulis sehingga rapel kedua tidak dibayar. Revisi adalah jumlah header allocated immutable untuk tuple tenant/run/karyawan/ID slip. Preview memasukkan revisi dan tetap tanpa write.

Kontrak yang dipilih setelah konsultasi architect: helper internal `finalizePayrollRapelRunInTransaction(tx, context, actor, input)`, dengan plan lengkap milik server dan optional expected revisions. Tidak menambah endpoint lifecycle atau menerima ciphertext/parameter uang dari klien. Pemanggil mengelola lifecycle run, tetapi tidak boleh mengambil row lock run sebelum helper; helper memverifikasi run locked, persetujuan/config/totals sah dan seluruh plan/alokasi tercakup.

Urutan: ambil advisory komponen seluruh plan secara deterministik sebelum row lock karyawan/outlet/run, recompute gross/overlay/alokasi lewat helper tx yang sama, lalu validasi aggregate terhadap totals frozen. Nominal/statutory nonzero yang belum dapat dibuktikan, aggregate berbeda, plan tidak lengkap atau sebagian sudah persisted ditolak409 sebelum write. Helper tidak mengubah totals, approval atau status run.

Envelope versi baru menaruh run/revisi dalam header yang diautentikasi AES-GCM. SQL membandingkan header dengan alokasi terkini; receipt berlabel baru tidak dapat meloloskan ciphertext lama yang utuh. Header yang diubah gagal dibuka sebelum nominal dipakai. Receipt immutable mengikat tuple, revisi, digest ciphertext, key version dan transaction ID. Guard INSERT mensyaratkan receipt revisi terkini dan hash yang sama pada transaksi tersebut. Semua slip batch ditulis atomik; pemanggilan ulang batch lengkap mengembalikan slip tersimpan. Receipt tidak menggandakan ciphertext gaji.

Test wajib: alokasi-preview-alokasi-kunci dengan dua kenaikan; source tetap beku; keduanya masuk slip tepat sekali; ordinary employee juga tercakup; ulang finalisasi tidak menambah slip; stale/current revision, current overlay, receipt/hash/tx binding, plan/totals/unsupported guards, dan lock nyata. Penetapan batas gross-only internal ini dilaporkan ke CTO; writer penuh tetap bertanggung jawab atas statutory/lifecycle yang belum dimiliki cabang.

Migrasi0383/snapshot/journal hanya butir1. FK baru menggunakan inline atau bracket FORCE-RLS yang aman. Payload sumber tetap membaca envelope legacy dan metadata revisi baru secara ketat. Regresi pertama sah: 1 gagal/29 lulus, seal7,35juta diterima setelah alokasi berikutnya seharusnya total8,25juta (`/tmp/g688h-p1-red.log`).

## 2. Trigger maker-checker selektif

Masalah: CHECK NOTVALID juga mengevaluasi UPDATE status lama. Ganti dengan trigger INSERT dan UPDATE hanya ketika nilai creator/HR/finance benar-benar berubah. Ketiga aturan pembeda identitas tetap diperiksa; assignment identik tidak dihitung perubahan. Pertahankan SQLSTATE23514 dan diagnostic constraint untuk kompatibilitas.

Amend0350/0381 karena upgrade harus bisa melewati tahap tersebut; forward0384 menangani instalasi yang sudah menerapkan versi lama. Schema/snapshot terbaru menghapus CHECK; data historis dan snapshot historis tidak diubah. Transisi legacy locked→paid/reversed mempertahankan nominal, konfigurasi dan bytes payslip.

Test post-upgrade menjalankan trigger origin dengan parent FK valid; replica hanya boleh dipakai seeding legacy sebelum upgrade. RED sah: 2 gagal/10 lulus, kedua transisi legacy ditolak23514 (`/tmp/g688h-p2-red.log`).

Karena rantai migrasi dan schema dipakai bersama, patch butir2 disiapkan di `/tmp/g688h-approvers` dan baru diterapkan setelah commit1. Nomor0383–0384 berada dalam sisa rentang0381–0385 yang sudah ditetapkan; setiap when di atas0382 lama1794454276910.

## Verifikasi dan batas

Test terarah melalui heavy; satu pemegang token setiap waktu. API tsc heap8192MB dan shared tsc berurutan; changed-file eslint/prettier; db:generate kosong; satu review architect final dengan konteks baru. Tidak menjalankan gate penuh/build/e2e di thread ini. Parent memperbarui PROGRESS dan commit; subagent tidak commit.
