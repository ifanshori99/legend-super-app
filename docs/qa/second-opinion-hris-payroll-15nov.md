# Second opinion Codex: HRIS dan payroll (15 Nov 2026)

Rentang: origin/milestone/m1...ghostex/hris-payroll-followups-4-kartu (0f517d933 + 309c541b8) dan ...ghostex/hris-koreksi-absen-ditolak-tampil (0ac8e3b7c). Thread G6dun, read-only. Hasil: 4 P2, tanpa P1.

1. P2 apps/api/src/services/hris-leave-collective.service.ts:753: nilai carry hangus yang sama dipakai berulang untuk menutup potongan tanggal berbeda. Carry 5, terpakai 4, hangus 1; dua penolakan masing-masing 1-1=0, carry tetap 4 padahal seharusnya 3. Karyawan dapat lebih 1 hari. Perbaikan: konsumsi nilai hangus secara kumulatif.
2. P2 hris-leave-collective.service.ts:817: tagihan setelah settlement bisa hilang; delta memakai carry berlaku pada tanggal review, snapshot memakai carry mentah. Perbaikan: hitung selisih dari basis snapshot settlement yang dibekukan.
3. P2 apps/api/src/worker/notification-adapters.ts:991: penerima mengikuti outlet absen, detail settlement bocor ke HR outlet lama. Perbaikan: penerima dari outlet rumah karyawan saat ini + izin settlement.
4. P2 apps/web/src/features/ws10-hris-employee/hooks.ts:188: edit koreksi tidak mengecek pemilik terhadap sesi saat ini (tab lama setelah ganti akun). Perbaikan: ikat POST ke identitas karyawan yang diharapkan, tutup edit saat identitas berubah, cocokkan pemilik respons sebelum menghapus antrean.

Keputusan CTO: keempatnya diperbaiki (brief 852).
