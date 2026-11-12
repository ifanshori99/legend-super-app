# 549 Payroll: second opinion, formula lembur, dan rapel

Basis: `d6dce374`, cabang `ws/payroll-engine`, worktree `.worktrees/payroll-engine`.
Brief CTO 12 November 2026 memerintahkan lima butir berurutan, test gagal sebelum implementasi dan satu commit per butir. Tidak push atau merge.

## Batas dan bukti uang

Hanya payroll. Tidak menyentuh edge, HRIS non-payroll, akuntansi, refund, CRM atau inventory. Migrasi baru memakai 0381–0385 dengan `when` di atas migrasi terakhir. Setiap perubahan pembayaran wajib membuktikan tidak ada pembayaran berlebih dan outlet tidak rugi. Kebijakan yang meragukan membatasi pembayaran dan dilaporkan kepada CTO.

## Rencana implementasi

1. **Basis lembur per tanggal.** Test sebelum mulai, sesudah berhenti, baris nol dan celah riwayat. Ganti minimum positif seluruh periode dengan basis dari riwayat yang berlaku pada tanggal request; tanggal tanpa basis = Rp0. Pertahankan batas attendance dan jam penuh. Jalankan test terarah dan commit.
2. **Formula terpatok (`legend-g5v69`).** Test parameter pemanggil lebih mahal, formula kosong ditolak dan batas attendance tetap berlaku. Pakai pemuatan formula tenant-scoped bersama bagian payroll-feed `hris-overtime.service.ts`; kelompokkan tarif per tanggal/jenis hari/formula tanpa memperbesar kuota menit. Perbarui fixture lama agar memakai pin sah. Test dan commit.
3. **Freeze historis.** Test outlet pindah entitas A ke B dengan payslip pada run A terkunci; riwayat tidak berubah. Buktikan lock pada baris run A tetap ditunggu. Perluas predicate run lewat `EXISTS` payslip tenant+karyawan, pertahankan `FOR SHARE` dan maksimum tanggal setelah lock. Test dan commit.
4. **Upgrade approver (`NOT VALID`).** Test upgrade dengan baris lama pembuat=approver, baris lama identik dan tulis baru ditolak. Amend 0350 sesuai keputusan CTO agar upgrade tidak berhenti sebelum perbaikan; 0381 memperbarui instalasi yang sudah melewati 0350. Runbook berisi preflight hitung tanpa mutasi data. Test dan commit.
5. **Rapel (`legend-svqew`, Q43/Q44).** Ledger koreksi terpisah, prorata harian, approval HR dan finance sebelum dibayar, run lama tetap beku, audit, konsumsi tepat sekali pada run berikutnya. Test run diulang, kalkulasi ulang, dua kenaikan berurutan dan penurunan backdate tanpa potongan otomatis. Detail kontrak ditetapkan dari pemetaan kode sebelum test/implementasi; test gagal dulu, commit tersendiri.

## Pembagian dan verifikasi

Tiga Explore paralel (payroll 1–3, migrasi 4, rapel 5), satu test-writer, satu implementer payroll 1–3 berurutan dan satu implementer migrasi. Worker rapel dan architect final memakai slot setelah Explore selesai. Satu pemegang token heavy pada satu waktu. Root menggabungkan, memeriksa, memperbarui progress dan melakukan commit lokal.

Gate: test terarah melalui `LEGEND_TEST_FILES=... heavy pnpm test`, API/shared tsc melalui heavy, changed-file eslint dan prettier, `db:generate` tanpa perubahan baru, satu review architect konteks segar. Gate penuh dan e2e milik merge train sesuai aturan tim.

## Keputusan implementasi

- 0350 harus diubah karena migrasi lanjutan tidak dapat menyelamatkan upgrade yang gagal lebih awal; perubahan ini secara eksplisit diminta CTO.
- Formula kosong gagal tertutup; parameter pemanggil tidak boleh menaikkan pembayaran request lama.
- Rapel negatif tidak otomatis menjadi potongan. Alur ini membayar koreksi positif yang sudah disetujui; keputusan rinci tentang netting mencegah pembayaran lebih akan dicatat sebelum implementasi.

### Kontrak rapel yang diputuskan dari pemetaan

- API `POST /api/hris/payroll/rapel` menerima karyawan, komponen, tanggal backdate, nominal target dan idempotency key; subroute approve-hr, approve-finance, allocate, cancel dan GET rincian. Cancel hanya pending/HR-approved agar request stale dapat diganti, seluruhnya diaudit.
- Requester, HR dan finance berbeda. HR mengikuti izin existing `payroll.approve`; finance `payroll.approve` + `payroll.lock`. Tidak ada pembayaran sebelum dua approval.
- Sumber hanya payslip karyawan dari run regular beku dan bukan reversed; koreksi harian mengurangi target yang sudah disetujui/reserved sebelumnya. Request pending sebelumnya memblokir request berikutnya supaya delta tidak paralel.
- Approval finance mengambil advisory lock komponen yang sama dan menguji ulang watermark frozen serta anchor riwayat. Perubahan sumber/anchor menolak request stale; penghitungan diam-diam sesudah HR approval tidak dibolehkan.
- Ledger approved memberi overlay nominal prospektif mulai sehari setelah frozen terakhir, terikat baris riwayat yang menutupi tanggal itu. Riwayat baru setter normal mengakhiri overlay. Resolver tanggal yang sama dipakai gaji reguler dan dasar lembur. Ini diperlukan agar dua kenaikan dengan tanggal prospektif sama tetap append-only.
- Alokasi hanya draft run regular berikutnya, entitas/periode cocok. Satu target payslip per run+karyawan; gross opsional `payrollRunId` wajib mencocokkan target/payslip/karyawan/periode sebelum membaca rapel. Preview tidak menulis atau mengonsumsi ledger.
- Nilai ledger terenkripsi; integrasi reseal dibatasi cabang tabel payroll baru. Penurunan backdate ditolak409 untuk review manual, tanpa potongan otomatis.
