# 1263 status (25 Nov)

Sudah: kontrak, izin `accounting.period.close_override` (owner, finance), migrasi 0523, service, route, layar, test, screenshot. Cabang ws/1263-period-close-override didorong.
- Route `POST /fiscal-periods/:id/close-override` meminta `accounting.period.close` DAN `close_override`, plus MFA sesi (kasir acting tidak mewarisi MFA).
- `GET /fiscal-periods/:id/close-blockers` (tambahan dari rencana): detail 422 hanya mengirim nilai string ke klien, jadi daftar batch dibaca dari endpoint ini.
- Hanya sumber `production_order` + `PRODUCTION_INCOMPLETE`, paling banyak 200; lainnya tetap 422.
- Replay kunci yang sama dengan alasan atau daftar lain: 409 IDEMPOTENCY_KEY_REUSED.
- Bukti: `period-close-override-1263.test.ts` merah 10 dari 12 (tanpa service dan route) lalu hijau 13 dari 13.
Belum: review architect xhigh (tingkat K), merge train, gate penuh, layar terhadap API nyata.
Diketahui:
- Batch yang baru diparkir dan belum commit saat tutup tidak terlihat di daftar (celah sejak 1260: parkir tidak mengambil kunci badan usaha). Batch itu tetap terparkir dan muncul di tutup buku berikutnya.
- `errorCode` adalah hasil percobaan terakhir, tidak dicoba ulang saat override.
- Audit memakai kelas retensi `audit_2y` (sama dengan audit akuntansi lain).
