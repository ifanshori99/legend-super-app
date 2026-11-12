# Rapel kenaikan gaji

Alur `legend-svqew` membayar koreksi positif ke periode beku melalui run regular berikutnya. Riwayat nominal, run sumber, dan slip sumber tidak diubah. Semua endpoint memakai tenant dari sesi dan memerlukan origin terpercaya.

## Permintaan dan persetujuan

1. Pembuat dengan `payroll.run` mengirim `POST /api/hris/payroll/rapel` berisi `employeeId`, `componentId`, `effectiveFrom`, `newAmountIdr`, dan `idempotencyKey`.
2. HR dengan `payroll.approve` menyetujui lewat `POST /:rapelId/approve-hr` dengan `idempotencyKey`.
3. Finance dengan `payroll.approve` dan `payroll.lock` menyetujui lewat `POST /:rapelId/approve-finance`. Pembuat, HR, dan Finance harus tiga orang berbeda.
4. Pembuat run mengalokasikan melalui `POST /:rapelId/allocate` dengan `payrollRunId` dan `idempotencyKey`. Target harus run regular draft paling awal yang tersedia pada badan hukum sumber, sesudah batas periode beku.

`GET /:rapelId` membaca nilai dan status yang telah dicatat. Mengulang request dengan key yang sama mengembalikan identitas yang sama; kalkulasi ulang kenaikan yang sudah tercakup tidak menciptakan kredit baru. Selesaikan atau batalkan permintaan terdahulu sebelum mengajukan kenaikan berikutnya pada komponen yang sama.

Jika periode beku, riwayat prospektif, masa kerja, atau badan hukum berubah sebelum persetujuan, permintaan ditolak. Ledger menyimpan snapshot tanggal mulai/akhir kerja; persetujuan, alokasi, kalkulasi komponen rapel, dan penulisan slip final memeriksa ulang snapshot tersebut dengan kunci SHARE pada karyawan dan outlet. Preview lama tidak dapat dimasukkan sebagai slip setelah kelayakannya berubah. Batalkan permintaan `pending` atau `hr_approved` melalui `POST /:rapelId/cancel` dengan `idempotencyKey`, lalu buat permintaan baru untuk persetujuan baru. Rapel `approved` atau `allocated` tidak dibatalkan otomatis.

## Perhitungan dan pembayaran

Selisih dihitung pada hari kalender dalam masa kerja karyawan yang berada di rentang tanggal komponen, menggunakan pembagi hari kalender penuh periode payroll. Semua operasi uang memakai bilangan bulat dan pembulatan ke bawah. Batas hak baru dijumlah setelah pembulatan per baris riwayat asli, mengikuti engine gross, agar sisa pecahan lintas baris tidak menjadi rupiah tambahan. Target nominal sebelumnya yang sudah disetujui menjadi dasar kenaikan berikutnya; kredit terdahulu yang sudah disetujui atau dialokasikan dikurangkan lagi sebagai batas terhadap nominal slip sumber. Jumlah tidak boleh melebihi hak baru dikurangi gaji dan rapel yang telah dicatat.

Setelah Finance menyetujui, nominal baru berlaku prospektif mulai sehari sesudah periode beku terakhir. Ledger menyimpan identitas baris riwayat asli; kalkulasi gaji dan basis lembur membaca target yang telah disetujui untuk baris itu. Dua kenaikan pada tanggal prospektif yang sama dapat berlaku tanpa menulis ulang riwayat. Baris nominal baru dari alur setter normal menggantikan overlay tersebut mulai tanggalnya sendiri. Permintaan yang belum disetujui Finance tidak mengubah gaji.

Alokasi mengembalikan `reservedPayslipId`. Pemanggil `computeEmployeeGross` wajib memberikan `payrollRunId`, `payslipId` tersebut, karyawan, dan periode yang cocok untuk memasukkan baris `RAPEL`. Satu baris per permintaan menyimpan `sourceId` identitas ledger. Preview tetap hanya membaca, dan seal mencatat `rapelAllocationRevision`, yaitu jumlah alokasi immutable untuk tuple karyawan/run. Alokasi kedua menaikkan revisi; seal preview tidak boleh langsung dimasukkan sebagai slip final.

Writer payroll internal memakai `finalizePayrollRapelRunInTransaction(tx, context, actor, { payrollRunId, employeePlan, expectedAllocationRevisions? })` di dalam transaksi tenant miliknya. `employeePlan` berasal dari writer terpercaya dan memuat seluruh karyawan, identitas slip, serta metode pembayaran run. Fungsi ini bukan endpoint HTTP. Actor memerlukan `payroll.run` dan `payroll.lock`; run harus regular dan sudah `locked`, dengan snapshot konfigurasi dan total beku yang valid. Fungsi tidak mengubah status, total, konfigurasi, atau persetujuan run.

Pemanggil tidak boleh mengunci baris run lebih dahulu. Finalisasi mengunci advisory seluruh komponen dalam urutan karyawan/komponen, lalu baris karyawan, outlet, dan run. Overlay gaji serta semua alokasi dihitung ulang dalam transaksi yang sama melalui engine gross bersama. Rumus lembur tetap mengikuti `formulaId` request yang telah disetujui. Jumlah karyawan dan setiap total hasil harus sama persis dengan total run yang telah disetujui. Revisi opsional yang berbeda ditolak `409`, begitu pula rencana tidak lengkap, alokasi yang tidak tercakup, batch parsial, atau total berbeda. Semua validasi selesai sebelum penulisan pertama.

Batas fungsi ini adalah envelope gross yang telah digunakan engine. Total pajak, BPJS, pinjaman, receivable pajak, service charge, atau reimbursement yang bukan nol ditahan `409` untuk lifecycle payroll lengkap; fungsi ini tidak membuat efek samping statutory, jurnal, bank file, atau transfer. Writer lengkap tetap harus menangani kewajiban tersebut. Total beku yang perlu diperbarui harus melalui alur koreksi yang sah; finalisasi tidak menimpa persetujuan lama.

Envelope kalkulasi baru memuat run dan revisi alokasi dalam header yang diikat oleh autentikasi AES-GCM. Trigger membandingkan header dengan run dan jumlah alokasi terkini; receipt berlabel revisi baru tetap tidak dapat menerima seal lama yang utuh. Mengubah header membuat dekripsi gagal sebelum nominal dapat dipakai. Format lama tetap dapat dibaca sebagai sumber historis. Saat penulisan, receipt immutable mengikat tenant/karyawan/run/slip, revisi alokasi terkini, hash ciphertext baru, versi kunci, dan transaksi. Trigger menolak preview lama atau ciphertext yang ditukar, termasuk seal yang dulu valid sebelum alokasi kedua. Receipt tidak menyimpan nominal gaji. Keunikan `(tenant, run, employee)` dan replay seluruh batch tersimpan mencegah pembayaran ganda. Mengulang finalisasi hanya membaca slip final beserta receipt dan memeriksa total beku; perubahan data hidup tidak menghitung ulang pembayaran yang telah tersimpan. Rotasi kunci slip tetap didukung karena receipt memeriksa INSERT awal saja.

## Pembatas pembayaran

- Penurunan gaji backdate ditolak dengan `409`. Alur ini tidak membuat potongan otomatis; koreksi negatif memerlukan keputusan dan persetujuan terpisah.
- Hanya komponen penghasilan tetap aktif dan sumber run regular `locked` atau `paid` yang memiliki slip karyawan dapat dikoreksi. Sumber reversed, periode bertumpuk, lintas badan hukum, dan celah riwayat memerlukan review manual.
- Setelah karyawan pindah badan hukum, rapel dan overlay entitas lama ditahan untuk review manual. Entitas baru hanya menghitung gaji normal dari riwayat yang berlaku tanpa menambahkan rapel atau overlay entitas lama.
- Setelah dialokasikan, periode, jenis run, kebijakan dan badan hukum target tidak dapat diubah. Transisi status biasa tetap mengikuti lifecycle payroll; draft yang belum memiliki alokasi tetap dapat diperbarui.
- Target harus draft. Jika sudah disimulasikan, kembalikan melalui lifecycle run yang sah sebelum mengalokasikan agar total lama tidak terbawa ke persetujuan.
- Run sumber dengan rapel yang sudah disetujui atau dialokasikan tidak dapat direversal otomatis. Pemulihan harus menilai gaji dan rapel bersama agar pengganti tidak membayar hak yang sama dua kali.
- Reversal run target menahan alokasi pada target lama. Kredit tidak dilepas dan tidak dipindah otomatis ke run lain.

Slip sumber dapat memakai kalkulasi penuh atau envelope gross lama yang tepat berisi gross, potongan, net, lembur, dan baris. Seluruh nominal dan aritmetik divalidasi; pin run opsional harus cocok. Metadata penuh yang rusak tidak dipangkas menjadi format lama, dan AAD serta relasi tenant/karyawan/run tetap wajib.

Nominal target dan selisih terenkripsi dengan ikatan tenant, tabel, baris dan field. Audit menyimpan identitas dan status tanpa nominal gaji. Rotasi kunci payroll mencakup header dan item rapel; reseal tidak mengubah nilai logis, sumber, persetujuan atau alokasi.

Service lifecycle run persisten lengkap belum tersedia pada cabang ini. Primitive finalisasi batch di atas menyediakan batas penulisan gross rapel internal; integrasi produksi, efek samping statutory, pembuatan bank file, dan transfer uang tetap menjadi tanggung jawab lifecycle payroll lengkap.
