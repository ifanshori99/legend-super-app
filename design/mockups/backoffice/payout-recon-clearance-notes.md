# Rekonsiliasi payout dan clearance dua orang

Mockup statis untuk `legend-o2b4m` (brief 1003). Lingkup hanya `design/mockups/`; tidak mengubah aplikasi, pembayaran, atau otorisasi. Data contoh adalah ilustrasi untuk penilaian tampilan.

## Arah yang dipilih

Mengikuti arah backoffice yang sudah ada di `account-role-mappings.html`: permukaan solid, navigasi dan tipografi konsisten, daftar rapat tetapi terbaca, warna status disertai teks. Direktif brief eksplisit memilih satu arah existing dan HTML statis beserta PNG hasil render; ini mengesampingkan alur umum peran designer yang meminta dua arah baru dan image generation. Desktop 1280 menggunakan daftar flag dan panel pemeriksaan berdampingan; mobile 390 menyusun daftar dan panel dalam satu kolom. Setiap flag mempertahankan alasan, karyawan, nominal, dan statusnya.

Daftar dan panel dipilih karena finance perlu membandingkan alasan, nominal, slip, dan jejak dua orang sambil tetap melihat konteks batch. Alternatif modal lebih ringkas saat menutup satu flag, tetapi menyembunyikan daftar dan memaksa bolak-balik saat memeriksa beberapa flag. Form tidak menutupi rincian yang sedang disetujui.

## Dasar keputusan

- `~/.agents/team/ui-standard.md`: satu aksi utama, status bukan warna saja, body mobile minimal 16 px, aksi utama minimal 44 px, angka tabular, pesan validasi dekat field, serta kondisi loading/kosong/error/sukses.
- `docs/PRD.md`, bagian 30 Payroll dan PAYR-01–05: payroll dikunci, persetujuan bertahap, dan total transfer sesuai gaji bersih. Clearance tidak digambarkan sebagai perintah membayar.
- `docs/briefs/sub-payout-finance-ui.md`: gaji diterima dan biaya PT ditampilkan terpisah; tindakan keuangan tetap diperiksa server; tabel menjadi kartu di mobile.
- `design/REFERENCES.md` saat ini membahas QR order pelanggan, sehingga bukan sumber arah visual layar finance. `DESIGN.md` tidak ditemukan pada checkout ini.
- Sumber kontrak yang diperiksa adalah commit `74e142d8b`, bukan tebakan dari istilah UI: route, validator, DTO, service, serta `docs/briefs/990/i2-contract.md`.

## Kontrak HTTP

Semua path berikut berada di `/api/hris/payroll` dan memerlukan izin `payroll.disburse.approve` serta konteks tenant.

| Operasi           | Path dan input                                                            | Hasil                                                            |
| ----------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Daftar flag       | `GET /payout-recon-flags`, tanpa query filter yang didefinisikan route    | `200 { data: PayoutReconFlagDto[] }`, terbaru dulu, maksimal 200 |
| Usul clearance    | `POST /payout-recon-flags/:flagId/clearance`, body `{ reason, password }` | `201 { data: { clearanceId } }`                                  |
| Setujui clearance | `POST /payout-recon-clearances/:clearanceId/approve`, body `{ password }` | `200 { data: { clearanceId } }`                                  |

`flagId` dan `clearanceId` adalah UUID. `reason` dipangkas di kedua sisi, wajib 10–500 karakter. Validator menyatakan `password` optional, string 1–128 karakter jika hadir; middleware POST tetap memerlukan pemeriksaan kata sandi (`passwordOnly: true`) serta step-up MFA. Karena itu mockup tetap menampilkan kolom konfirmasi kata sandi wajib. Detail grant/hash tidak ditampilkan kepada finance.

Mengusulkan ulang flag dengan usulan aktif untuk data yang sama mengembalikan ID usulan yang sama; alasan pertama tetap. Mockup tidak menawarkan mengedit alasan usulan aktif. Daftar saat ini tidak memiliki parameter batch/status/pencarian atau pagination; filter tampilan di mockup tidak boleh disamakan dengan kemampuan server mengambil seluruh riwayat.

Sumber: `apps/api/src/routes/payroll-payout-recon-clearance.routes.ts`, `packages/shared/src/validators/payroll-payout-recon-clearance.ts`, dan `apps/api/src/services/payroll-payout-recon-clearance.service.ts` pada `74e142d8b`.

## Pemetaan field ke tampilan

| Field `PayoutReconFlagDto` | Makna di layar                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `id`                       | Identitas flag; referensi teknis sekunder dan target usulan                                   |
| `kind`                     | Jenis flag internal; alasan finance tetap menjadi teks utama                                  |
| `itemId`                   | Identitas item payout yang ditandai; kunci pencocokan rincian item                            |
| `payslipId`                | Identitas slip terdampak; dasar deduplikasi jumlah slip                                       |
| `batchId`                  | Pengelompokan batch dan kunci pengambilan rincian batch                                       |
| `reason`                   | Alasan flag, dijelaskan dalam bahasa finance tanpa mengubah artinya                           |
| `flaggedAt`                | Waktu pertama ditandai, ISO datetime yang ditampilkan dengan waktu lokal                      |
| `reopened`                 | Ada clearance lama yang disetujui tetapi tidak lagi sesuai data terkini; slip kembali ditahan |
| `clearance`                | Usulan untuk fingerprint data terkini; `null` jika belum ada                                  |
| `clearance.id`             | Target persetujuan; berbeda dari `flag.id`                                                    |
| `clearance.status`         | `proposed` → Diusulkan; `approved` → Disetujui                                                |
| `clearance.reason`         | Alasan pengusul yang diperiksa orang kedua                                                    |
| `clearance.proposedBy`     | ID pengguna pengusul; pembanding dengan ID pengguna aktif                                     |
| `clearance.proposedAt`     | Waktu usulan; ditampilkan bersama identitas pengusul                                          |
| `clearance.approvedBy`     | ID pengguna penyetuju, atau `null`                                                            |
| `clearance.approvedAt`     | Waktu disetujui, atau `null`                                                                  |

Sumber DTO: `packages/shared/src/types/api.ts:215` pada `74e142d8b`. `reopened` bukan nilai tambahan pada `clearance.status`; keduanya dapat berlaku bersama, misalnya flag terbuka ulang yang sudah memiliki usulan baru. Tanda terbuka ulang tetap terlihat di detail meskipun status utama saat itu Diusulkan.

| Kondisi data                         | Label/konsekuensi                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `clearance === null` dan `!reopened` | Terbuka; usulan dapat dibuat                                                                  |
| `clearance?.status === "proposed"`   | Diusulkan; menunggu orang kedua; slip masih tertahan oleh flag ini                            |
| `clearance?.status === "approved"`   | Disetujui untuk data terkini; flag ini tidak lagi menahan slip                                |
| `reopened === true`                  | Terbuka ulang; clearance lama tidak berlaku untuk data terkini, perlu pemeriksaan/usulan baru |

Persetujuan clearance hanya menghapus penahanan oleh flag tersebut. Flag lain, perselisihan batch, atau syarat payout lain masih dapat menahan slip. Jangan menulis “gaji sudah dibayar” atau “slip pasti dapat dibayar” sebagai hasil clearance.

## Batas data gabungan dan identitas

Endpoint recon sengaja tidak mengirim nama, nominal, nomor rekening, nama PT/periode, maupun nama pengusul/penyetuju. Nama dan Rupiah contoh di mockup adalah gabungan ilustratif, bukan field baru dari endpoint recon.

- `GET /disbursement-batches/:id` yang sudah ada menggunakan izin `payroll.view`; cocokkan `batch.items[].id === flag.itemId` serta `payslipId` dan `batchId`. `PayrollDisbursementItemDto` menyediakan `employeeId`, `amountIdr` (gaji bersih), `feeIdr` (biaya PT), dan snapshot `accountHolderName`/`maskedAccountNumber`. Nama pemilik rekening bukan pengganti yang pasti untuk nama karyawan.
- Nama karyawan perlu sumber karyawan yang diizinkan untuk actor tersebut, dicocokkan dengan `employeeId`. Jika tidak tersedia, tampilkan referensi item/karyawan dan “Nama tidak tersedia”; jangan mengarang nama atau mengubah kegagalan baca nominal menjadi Rp0.
- Nama pengusul dan penyetuju belum disediakan `PayoutReconFlagDto`; `proposedBy`/`approvedBy` adalah ID. Resolusi identitas yang diizinkan masih perlu dipastikan saat implementasi. Jika belum dapat diresolusikan, pertahankan referensi ID yang dapat dibedakan dengan label “Identitas belum tersedia”, serta waktu usulan. Jangan meniru field `proposedByName` dari DTO proposal payout lain.
- Pemeriksaan usulan sendiri harus memakai ID pengguna, bukan nama tampilan. Server juga menolak pengusul/sesi pengusul; tombol nonaktif membantu penjelasan, tidak menggantikan pemeriksaan server.
- Nominal ditulis misalnya `Rp5.250.000` dan `Rp5.000` dengan format Indonesia. Total slip tertahan menghitung `payslipId` unik dari flag belum disetujui dalam data yang dimuat; jangan menjumlahkan nominal beberapa flag untuk slip yang sama atau menyebut hasil tersebut total seluruh tenant.
- Daftar maksimal 200 tidak menyertakan jumlah total/indikator pemotongan. Jika 200 baris diterima, UI produksi perlu copy batas data atau kontrak lanjutan sebelum mengklaim seluruh flag sudah tercakup.

## Keadaan dan varian yang diperlihatkan

| Keadaan dasar | Isi pemeriksaan                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `normal`      | Daftar lintas status dan panel usulan dengan alasan wajib serta konfirmasi kata sandi            |
| `empty`       | Tidak ada flag pada pilihan saat ini; penjelasan dan aksi pemulihan pilihan                      |
| `loading`     | Skeleton sesuai bentuk daftar/kartu dan panel, dengan status pemuatan yang terbaca               |
| `error`       | Gagal memuat; pesan penyebab yang dapat dipahami dan aksi Coba lagi                              |
| `validation`  | Alasan kosong/kurang dari 10 karakter dan kata sandi belum diisi; pesan di dekat field           |
| `success`     | Clearance berhasil disetujui, identitas dan waktu dua orang terlihat; tidak menjanjikan transfer |

Varian tambahan di bawah keadaan dasar:

- `approve`: panel menampilkan siapa mengusulkan, kapan, alasan, rincian flag, dan konfirmasi kata sandi orang kedua. Aksi “Setujui clearance”.
- `self`: tombol persetujuan nonaktif dengan alasan “Anda mengusulkan clearance ini. Persetujuan harus dilakukan oleh orang lain.”
- `changed`: error `PAYOUT_RECON_FLAG_CHANGED` (409) berarti data berubah sejak usulan. Pesan “Data berubah setelah usulan dibuat. Periksa data terbaru, lalu buat usulan clearance baru.” Aksi “Buat usulan baru”; persetujuan usulan lama tidak dapat dilanjutkan.
- `reopened`: tanda “Clearance lama tidak berlaku” serta “Data rekonsiliasi berubah setelah clearance disetujui. Slip kembali ditahan oleh flag ini dan perlu pemeriksaan ulang.” Jangan mengarang nama/waktu clearance lama karena daftar hanya mengirim clearance fingerprint terkini.

Error lain yang perlu dipertahankan dalam implementasi: `PAYOUT_RECON_CLEAR_SELF_APPROVAL` (403), `PAYOUT_RECON_CLEAR_REASON_INVALID` (422), `PAYOUT_RECON_CLEAR_STATE` (409), `PAYOUT_RECON_FLAG_NOT_FOUND`/`PAYOUT_RECON_CLEARANCE_NOT_FOUND` (404), serta kegagalan izin/verifikasi ulang. Setelah konflik status, muat data terkini sebelum menyajikan aksi berikutnya.

## Ringkasan untuk gerbang founder

- Founder melihat daftar alasan flag per batch, nominal gaji dan biaya PT terpisah, status, serta slip yang masih tertahan oleh flag.
- Panel memperlihatkan alasan, nama/waktu pengusul, dan persetujuan orang kedua dengan konfirmasi kata sandi.
- Pengusul sendiri tidak dapat menyetujui; perubahan data meminta usulan baru, dan clearance lama diberi tanda tidak berlaku.
- Pilihan desain: daftar dan panel berdampingan di desktop, kartu berurutan di mobile. Mohon penilaian keterbacaan dan kejelasan alur ini; tidak ada keputusan bisnis baru yang ditambahkan.

## Hasil gate

Perintah final: `heavy --browser node design/mockups/backoffice/payout-recon-clearance-render.mjs`.
Hasil: **20 PNG, 30 pemeriksaan layout, 16 pemeriksaan interaksi, 0 error runtime**; seluruh pemeriksaan lulus.
Bukti terstruktur: [payout-recon-clearance-verification.json](payout-recon-clearance-verification.json).

- Enam keadaan dasar × desktop 1280×1000 dan mobile 390×844, ditangkap seluruh tinggi halaman. Empat varian tambahan (`approve`, `self`, `changed`, `reopened`) juga ditangkap di kedua ukuran.
- Lebar 320 diperiksa untuk keenam keadaan dan empat varian; tidak ada overflow horizontal pada 30 kombinasi layout.
- Perilaku lokal yang dibuktikan: alasan/kata sandi wajib, alasan minimal 10 karakter, usul mempertahankan ID/alasan, alasan tidak bocor antarflag, persetujuan hanya mengubah flag terpilih dan bertahan saat membuka riwayat, pengusul sendiri diblokir, konflik mengajak usul baru, serta terbuka ulang tetap ditandai ketika usulan baru dibuat.
- Pemulihan error dan pilihan batch kosong diperiksa. Loading/error tidak menampilkan jumlah atau nominal yang belum diketahui. Nilai ringkasan mobile tetap satu baris.
- Review konteks segar dan inspeksi PNG desktop/mobile tidak menemukan temuan tersisa dalam lingkup mockup. Temuan awal tentang ID/status, pemisahan konflik dari validasi, dan ukuran teks mobile sudah diperbaiki sebelum render final.
- Sintaks renderer dan JavaScript inline diperiksa; Prettier dijalankan dengan `--ignore-path /dev/null` karena konfigurasi proyek mengecualikan `design/**`; `git diff --check` lulus.

Contoh ekspor:
[Normal desktop](payout-recon-clearance-normal-desktop.png),
[normal mobile](payout-recon-clearance-normal-mobile.png),
[persetujuan mobile](payout-recon-clearance-approve-mobile.png),
[data berubah desktop](payout-recon-clearance-changed-desktop.png),
[terbuka ulang mobile](payout-recon-clearance-reopened-mobile.png).
Seluruh PNG menggunakan awalan `payout-recon-clearance-` di folder ini.

| Area          | Hasil dan batas bukti                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product       | PASS untuk brief mockup; kontrak diperiksa dari commit dan satu pola visual existing (bukti visual Thin). Data tetap ilustrasi.                                           |
| UX            | PASS untuk urutan pemeriksaan, dua orang, dan pemulihan yang diuji lokal. Belum diuji dengan pengguna.                                                                    |
| UI            | PASS untuk arah task UI yang mengikuti rujukan, angka tabular, permukaan solid, dan status berteks.                                                                       |
| Design system | PASS untuk penggunaan pola warm canvas/shell/card dan font Jakarta existing.                                                                                              |
| Accessibility | NOT VERIFIED menyeluruh; label, pesan field, fokus CSS, dan status nonwarna direview. Axe, Lighthouse, pengukuran kontras menyeluruh, dan pembaca layar belum dijalankan. |
| Responsive    | PASS untuk 1280/390 dan overflow 320 pada keadaan yang dicatat.                                                                                                           |
| Edge cases    | PASS untuk enam keadaan dan empat varian; larangan setuju sendiri serta penanda clearance lama terbukti dalam simulasi.                                                   |
| Code quality  | PASS untuk sintaks dan perilaku statis yang diperiksa renderer; build/test aplikasi N/A karena kode aplikasi tidak berubah.                                               |
| Visual QA     | PASS untuk render Chromium dan inspeksi desktop/mobile; tidak mengklaim semua pixel diverifikasi otomatis.                                                                |
| Anti-slop     | PASS untuk tampilan finance tanpa dekorasi, klaim pemasaran, atau kemampuan produk tambahan.                                                                              |
| Final         | NOT VERIFIED sebagai UI production; artefak mockup dan verifikasi lokal selesai untuk gerbang founder.                                                                    |

Integrasi API, pemeriksaan izin/MFA/kata sandi server, dan pencegahan pembayaran berlebih tidak diuji oleh artefak ini. Mockup tidak memanggil API, mengirim kata sandi, atau menjalankan pembayaran. Nama actor memerlukan resolusi identitas saat implementasi, sebagaimana batas kontrak di atas.

Tugas dibagi ke empat subagent Codex: eksplorasi kontrak/renderer, pola/HTML, UX/catatan, serta review segar. Utilitas laporan sesi Claude tidak menemukan transkrip Codex ini, sehingga biaya dan rata-rata paralel sesi tidak diklaim. Tidak mengubah `docs/PROGRESS.md` karena brief membatasi commit pada berkas mockup.
