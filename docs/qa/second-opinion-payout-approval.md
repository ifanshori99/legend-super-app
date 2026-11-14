# Second opinion: payout approval (#776)

Tanggal: 14 November 2026. Peran: second-opinion, read-only terhadap kode produk.

Rentang yang ditinjau: `origin/milestone/m1...origin/ws/payout-approval-followups`, dengan baseline `5dcc1cfd97959d5e263833929bc1ffb6905fec39` dan head `172a26c777db80031a19f0521d0d2e53cde2f09d`. Nomor baris di bawah merujuk head tersebut, bukan checkout baseline tempat laporan ini ditulis.

Fokus: rekening sumber saat approve, nama pengusul, kunci konfigurasi, retry web setelah MFA, pembayaran berlebih/ganda, masking, dan izin lintas outlet. Rentang juga membawa fitur evidence/withdraw dan UI lain dari ancestry; fitur tersebut tidak diaudit menyeluruh. Pemeriksaan dibagi ke tiga subagent read-only, puncak tiga bersamaan; penulis memeriksa ulang lokasi dan jalur temuan.

## Temuan

**P0: 0 · P1: 0 · P2: 1 · P3: 0.**

- **P2 — `apps/web/src/features/ws10-payroll-payout/components/approval-tab.tsx:123`: Konfirmasi sumber dan panel MFA tidak terikat ke batch.** `ApprovalBatch` dirender tanpa `key={batchId}` pada baris 64, sedangkan reset konfirmasi pada baris 125–134 hanya mengikuti `sourceId`. Skenario gagal: detail batch A dan B sudah ada di cache, keduanya satu PT dengan sumber bank yang sama; penyetuju membuka A, mencentang pemeriksaan, menekan approve sampai muncul `MFA_REQUIRED`, lalu berpindah lewat riwayat ke `?tab=approval&batch=B`. Karena B cached dan `sourceId` tetap sama, checkbox, `confirmedSourceRef`, dan panel MFA dari A bertahan. Mengirim kode sekarang memanggil `submit` render B sehingga B disetujui memakai konfirmasi A. Jika verifikasi kode A sudah berjalan sebelum perpindahan, callback lama pada `approval-verify.tsx:94–110` dapat mengirim approve A ketika layar telah menampilkan B. Dampaknya adalah persetujuan batch yang tidak sesuai konfirmasi pengguna; ini tidak membuktikan pembayaran ganda atau melewati izin server. **Saran perbaikan:** Beri `key={batchId}` dan ikat konfirmasi ke tuple `{batchId, contentHash, sourceId}`; sebelum retry, pastikan tuple masih sama dan callback verifikasi lama sudah tidak berlaku. **Usul test:** Cache detail A/B dengan sumber sama, mulai MFA di A, navigasi ke B, lalu pastikan checkbox/panel direset dan tidak ada POST approve B sebelum konfirmasi baru. Ulangi dengan respons verifikasi A ditunda dan pastikan callback lama tidak mengirim approve A setelah perpindahan. Temuan berdasarkan penelusuran statis; belum direproduksi di browser.

## Bukti statis untuk invariant lain

| Invariant | Lokasi pada head | Hasil pemeriksaan |
| --- | --- | --- |
| Approve ulang atau serentak tidak mengesahkan batch dua kali | `apps/api/src/services/payroll-payout.service.ts:1184`, `:1186`, `:1266`, `:1289` | Run dikunci sebelum batch; batch memakai `FOR UPDATE`, status harus `pending_approval`, dan jumlah item yang berpindah harus tepat. Kegagalan dibatalkan oleh transaksi handler. |
| Orang kedua menyetujui isi batch yang sama | `apps/api/src/services/payroll-payout.service.ts:1193`, `:1240` | Pengusul ditolak; hash kiriman, hash tersimpan, dan hash item saat approve harus sama. Ini menjaga backend, tetapi tidak mengatasi konfirmasi web lintas batch pada temuan P2. |
| Rekening yang dibekukan sama dengan ID yang dikirim penyetuju | `apps/api/src/services/payroll-payout.service.ts:1205`, `:1227`, `:1263` | Config ditahan `FOR SHARE` sebelum setup/compare/freeze. ID null atau berbeda pada batch bank ditolak `409 PAYOUT_SOURCE_MISMATCH` sebelum penulisan. |
| Perubahan konfigurasi tidak menyela compare/freeze | `apps/api/src/services/payroll-payout-config.service.ts:208`, `:219` | Penulis config mengambil `FOR UPDATE` pada baris yang sama; perubahan jalur uang ditolak ketika batch masih berjalan. Belum dibuktikan dengan test dua transaksi. |
| Retry pada batch tetap memakai sumber yang dicentang | `apps/web/src/features/ws10-payroll-payout/components/approval-tab.tsx:213`, `:237` | Request memakai `confirmedSourceRef`, perubahan sumber membatalkan konfirmasi, dan mismatch memicu refetch serta checkbox baru. |
| Nama pengusul tidak dicari lintas tenant | `apps/api/src/services/payroll-payout-evidence-read.service.ts:158`, `:183` | Join nama dibatasi `roleAssignments.tenantId` dan ID pengusul proposal; tanpa assignment tenant tersebut, nama menjadi `null`. |
| Nomor rekening pada tampilan tetap ter-mask | `apps/api/src/services/accounting-cash-bank-shared.ts:47`, `apps/web/src/features/ws10-payroll-payout/api.ts:121`, `apps/api/src/services/payroll-payout.service.ts:530` | Sumber memakai `accountNumberMasked` berupa `****` + last4; DTO item memakai snapshot `maskedAccountNumber`. Nomor rekening sumber tidak dapat diganti dengan ID sama melalui API rekening yang ditelusuri. |
| Grant outlet tidak naik menjadi izin tenant | `apps/api/src/routes/payroll-payout.routes.ts:208`, `apps/api/src/routes/payroll-payout-evidence.routes.ts:168`, `apps/api/src/middleware/permissions.ts:150` | Approve/proposal memerlukan izin tenant; `contextFor(permission, { type: "tenant" })` menolak grant yang hanya berlaku pada outlet/brand. Read batch dan query pengusul juga dibatasi tenant. |

Tidak ditemukan skenario konkret pembayaran berlebih/ganda, sumber bank berbeda yang lolos pembandingan server, nomor rekening penuh yang keluar melalui DTO terkait, atau akses lintas outlet dari grant outlet pada cakupan ini.

## Cakupan test yang dibaca dan usul penguatan

Test yang dibaca, **tidak dijalankan**:

- `apps/api/src/test/payroll-payout-approval-followups-source.test.ts:213`: Mismatch/null, pergantian A ke B sebelum approve, field wajib di HTTP, ID sumber pada DTO, dan rollback state/item/audit.
- `apps/api/src/test/payroll-payout-approval-followups-proposer-name.test.ts:169`: Nama pengusul resolve/return serta `null` ketika assignment tenant pengusul tidak ada.
- `e2e/payout.mock.spec.ts:139`: Kebutuhan checkbox/orang kedua; belum memuat perpindahan dua batch cached selama retry MFA.

Usul test tambahan selain regresi P2:

- **Race config:** Tahan transaksi approve setelah memperoleh `FOR SHARE`, mulai transaksi perubahan config, buktikan perubahan menunggu, lalu pastikan ID sumber batch tetap yang dikonfirmasi. Uji urutan sebaliknya juga: perubahan A ke B lebih dahulu, approve dengan A ditolak tanpa mutasi. Gunakan penghalang transaksi, bukan jeda berbasis waktu.
- **Approve ganda:** Jalankan dua approve pada batch yang sama; tepat satu berhasil, satu ditolak, satu audit approval tercatat, dan jumlah/nominal item tetap.
- **Akses dan masking:** Grant `payroll.view`/`payroll.disburse.approve` hanya pada outlet A; list/detail/proposal/approve tenant harus ditolak. Untuk grant tenant yang sah, pastikan respons rekening mengikuti pola `^\*{4}\d{4}$` dan tidak memuat nomor lengkap.

## Verifikasi dan batas laporan

- Pemeriksaan statis melalui `git diff`, `git show`, penelusuran guard/mapper, dan pembacaan test pada hash head di atas.
- Tidak menjalankan test, build, browser, atau `heavy`; tidak menyatakan test yang tersedia lulus.
- Tidak mengubah kode produk, tidak membuat commit, push, atau PR. Satu-satunya berkas keluaran adalah laporan ini.
- Hasil ini merupakan second opinion terbatas, bukan bukti runtime seluruh alur payout atau gerbang rilis.
