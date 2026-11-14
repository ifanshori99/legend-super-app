# 799 Second opinion area akses foto fasilitas dan lampiran
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Akses dan data pribadi: effort xhigh. Read-only, tanpa edit kode produk.
Cakupan (gabungan tiga cabang, satu area):
- `origin/milestone/m1...origin/ghostex/upload-foto-fasilitas-sungguhan` (b961fdcc7): upload foto fasilitas, storage kinds, aturan baca per sumber (maintenance_ticket: staf outlet dengan izin fitur + manajer `facility.config.manage`; checklist_evidence dan cleaning_task: pemilik + manajer), pemilik butuh izin aktif.
- `origin/ghostex/upload-foto-fasilitas-sungguhan...origin/fix/leave-attachment-active-permission` (f161bcca7): `canReadLeave` dan `presentRequest` cuti, pengaju butuh `self.leave.request` aktif di outlet cuti atau `hr.leave.approve` di outlet itu.
- `origin/ghostex/upload-foto-fasilitas-sungguhan...origin/fix/facility-evidence-bind-source` (ca9a7c0f4): lampiran bukti checklist/tiket harus kind sama, pengunggah sama, outlet sama, belum terlampir; 422 generik.
Cari: signed URL bocor lintas tenant/outlet/karyawan, izin dicabut tapi akses tetap, probing id, race attach ganda, replay offline, data pribadi (tanda tangan, selfie, lampiran) terbaca orang yang tidak berhak, file berbahaya lolos scanner.
Tanpa heavy kecuali benar perlu satu test terarah (LEGEND_TEST_FILES=... heavy pnpm test).
Hasil: tulis `docs/qa/second-opinion-akses-foto-lampiran.md` di worktree-mu (P0-P3, berkas:baris, skenario gagal konkret, usul test). Lapor ringkasannya.
