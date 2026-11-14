# Second opinion akses foto fasilitas dan lampiran — #799

Tanggal: 14 November 2026. Bead review: `legend-rvzyp`.

Tidak ditemukan temuan P0–P3 dengan skenario gagal konkret pada cakupan ini. Kesimpulan ini berasal dari review statis, bukan hasil pengujian runtime atau persetujuan rilis.

## Cakupan dan metode

- Upload dan ACL fasilitas: `origin/milestone/m1...b961fdcc79121772047a6930c5c66d21cd3f1bae`; merge-base `ec4f7dfc640c39fef47eb97a9fd4ac940b91feb6`. Ref milestone ketika mulai diperiksa: `b42619abce5d326d547c4ae17293adca970db99e`.
- Izin aktif lampiran cuti: `b961fdcc7...f161bcca7de855da08edd91c08ea19a51826b87a`.
- Pengikatan bukti fasilitas: `b961fdcc7...ca9a7c0f4f2080cea41732feb9ed701b32a48421`.
- Tiga subagent read-only memeriksa ACL/storage/scanner, cuti, dan binding/replay secara paralel; pemeriksa utama memeriksa bukti serta integrasi yang relevan. Nomor baris di bawah mengikuti commit yang disebut, bukan gabungan cabang baru.
- Worktree laporan berada pada `ca9a7c0f4`; cabang cuti dibaca melalui `git show`. Tidak melakukan merge, mengubah kode produk, menjalankan layanan, atau menjalankan test/build/heavy.

## Hasil per invariant

| Area | Bukti kode | Penilaian statis |
| --- | --- | --- |
| Baca foto sesuai sumber | `b961fdcc7:apps/api/src/services/core-storage-access.ts:101` | Maintenance membutuhkan `ops.equipment.maintain` atau `facility.config.manage`; cleaning hanya pemilik berizin atau `facility.config.manage`; checklist hanya pemilik berizin atau `ops.checklist.manage`. Izin diperiksa pada outlet objek. |
| Pemilik kehilangan izin | `b961fdcc7:apps/api/src/services/core-storage-access.ts:228` | Identitas pemilik tidak cukup: pemilik tetap membutuhkan izin upload/review jenis sumber pada outlet tersebut. Ini juga berlaku pada selfie dan sumber lama melalui peta izin legacy. |
| Tenant/outlet dan probing objek | `f161bcca7:apps/api/src/services/core-storage-access.ts:260`, `:304`, `:332` | Query memfilter tenant; outlet harus milik tenant dan tercakup izin. Objek tidak ada, tenant lain, atau tidak berizin ditolak lewat penolakan yang sama. Referensi cuti mengalahkan klasifikasi storage lama dan mewajibkan outlet objek sama dengan outlet cuti. |
| URL cuti pada DTO | `f161bcca7:apps/api/src/services/hris-leave-request.service.ts:536` | Pengaju memerlukan `self.leave.request` aktif pada outlet cuti, atau pemirsa memiliki `hr.leave.approve` di outlet itu. Tanpa izin, signer tidak dipanggil dan URL nihil; baris cuti dapat tetap terlihat sesuai aturan daftar. |
| Pengunggah/kind/outlet dan respons generik | `ca9a7c0f4:apps/api/src/services/facility-evidence-media.ts:47`, `:54`, `:64` | Lampiran wajib satu tenant/outlet, kind tepat, `uploadedBy` dan `ownerUserId` sama dengan aktor, serta belum terkait dokumen lain. Kesalahan pre-check sama-sama 422 generik. |
| Attach ganda | `ca9a7c0f4:apps/api/src/services/core-storage.ts:255`, `:270`; `operations-checklist.service.ts:821`; `operations-equipment.service.ts:1369` | Link memakai update bersyarat `source_id IS NULL` dalam transaksi dokumen. Dua transaksi tidak dapat sama-sama mengikat media ke dokumen berbeda; transaksi yang gagal link harus rollback. Koreksi checklist boleh mempertahankan media pada `run.id` yang sama, sesuai brief #796. |
| Replay/offline | `ca9a7c0f4:apps/api/src/services/operations-checklist.service.ts:720`, `:730`, `:766`; `operations-equipment.service.ts:1293` | Aktor antrean dan konflik jawaban diperiksa; izin outlet diperiksa sebelum hasil idempotensi dikembalikan. Bukti tetap melewati pemeriksaan binding. UI tidak mengantre jawaban bermedia saat offline (`b961fdcc7:apps/web/src/features/operations-checklist/components/checklist-item-card.tsx:283`). |
| Tanda tangan/selfie dan format file | `b961fdcc7:packages/shared/src/storage/index.ts:26`; `apps/api/src/services/core-image.ts:127`, `:134`, `:136`, `:153` | Receipt, document dan selfie bersifat private. Gambar diperiksa magic bytes, dipindai melalui interface scanner, didekode dengan batas piksel, lalu diubah menjadi WebP tanpa mempertahankan metadata. SVG dan data yang tidak dapat didekode ditolak. Tidak ditemukan jalur baru yang menyajikan input gambar mentah sebagai konten aktif. |

Test yang dibaca mencakup `core-storage-access.test.ts`, `storage-facility-source-kinds.test.ts`, `operations-checklist.test.ts`, `operations-equipment.test.ts`, `operations-equipment-isolation.test.ts`, serta versi `f161bcca7` dari `hris-leave-attachment-api.test.ts` dan `hris-leave-attachment-db.test.ts`. Test tersebut menyediakan kasus revokasi/outlet lain, pemilik versus rekan, kind salah, pengunggah berbeda, dan media yang sudah terlampir. Test tidak dijalankan ulang dalam review ini.

## Batas penting

- URL yang sudah terbit tetap menjadi bearer URL selama TTL 300 detik (`b961fdcc7:apps/api/src/services/core-storage.ts:214`). Pencabutan izin mencegah penerbitan berikutnya; kode ini tidak mencabut URL lama seketika. Ini perilaku yang sudah ada, bukan regresi pada tiga diff tersebut.
- Runtime masih memakai `NoopMalwareScanner` (`b961fdcc7:apps/api/src/services/core-storage-runtime.ts:175`; `core-image.ts:29`). Re-encode gambar bukan bukti antivirus bekerja. PDF pada production ditolak 503 sebelum disimpan (`core-storage.ts:90`; `core-image.ts:19`); sambungan ClamAV nyata belum dibuktikan pada refs ini. Risiko ini sudah disebut kode sebagai `legend-dzh9q`.
- Binding/replay cleaning tidak dapat dinilai end to end pada refs ini: board selalu mengembalikan `cleaningTask: null` (`b961fdcc7:apps/api/src/services/facility-units.service.ts:88`) dan handler completion cleaning belum tersedia. Brief #796 juga menyatakan tidak ada jalur lampir media cleaning. ACL untuk objek `cleaning_task` tetap diperiksa.
- Tidak menguji storage provider, scanner nyata, balapan transaksi PostgreSQL, atau gabungan tiga cabang yang sudah dijalankan. Tidak menambahkan test maupun mengklaim suite yang ada lulus.

## Usul test lanjutan

1. **Balapan dua dokumen.** Jalankan dua pembuatan tiket pada peralatan berbeda dengan media sama dan kunci idempotensi berbeda. Tepat satu berhasil; hanya satu tiket tersimpan; `source_id` menunjuk pemenang; yang kalah mendapat 422 tanpa identitas sumber dan seluruh efek transaksinya rollback. Ulangi untuk dua checklist run.
2. **Replay sesudah revokasi.** Setelah jawaban/tiket sukses, cabut izin outlet lalu kirim ulang kunci yang sama. Replay wajib ditolak sebelum mengembalikan hasil lama. Untuk cuti, uji replay dengan izin tersisa hanya di outlet lain; URL harus nihil atau akses ditolak sesuai endpoint.
3. **Kesamaan ACL cuti pada data historis.** Seed cuti outlet A yang salah menunjuk document outlet B; aktor hanya approver A tetapi juga memiliki `hr.employee.view` B. Jalur storage langsung menolak. Tuntut list/detail juga tidak menghasilkan URL memakai signer runtime nyata dengan storage stub. Signer saat ini memeriksa purpose dan konteks gabungan (`f161bcca7:apps/api/src/services/core-storage-runtime.ts:95`), bukan kesamaan outlet cuti secara eksplisit. Jalur create saat ini membatasi outlet sehingga skenario ini belum terbukti dapat dibuat pengguna; tidak dihitung sebagai temuan P0–P3.
4. **Pemindai benar-benar menolak.** Setelah adapter ClamAV tersedia, uji berkas uji deteksi, scanner timeout/tidak tersedia, PDF, dan gambar valid. Penolakan harus meninggalkan nol blob dan nol baris storage; verifikasi PDF production tidak pernah tersimpan ketika pemindai tidak siap. Tambahkan pemeriksaan metadata GPS/EXIF hilang setelah re-encode.

Laporan ini hanya mengubah dokumen QA. Tidak ada temuan baru yang perlu dibuatkan bead perbaikan dari review ini; usul test di atas belum dikerjakan.
