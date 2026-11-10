# Brief 219: second-opinion Codex gabungan — pajak

Tingkat K (pajak, uang). Baca dulu prosedur `docs/briefs/217-review-queue-procedure.md` dan ikuti.

Brief yang diperiksa dalam run ini (semua di `docs/briefs/`, nama diawali id ini dan memuat `second-opinion`):
1. `170b` — PPh 21 piutang karyawan (legend-6ajk, legend-xzid).
2. `177b` — pajak (legend-de3b, legend-mdh0).
3. `173b` — race provisioning dan default pajak (legend-dq0n, legend-hd1m).

Konteks terbaru yang sudah diketahui (jangan laporkan ulang): legend-xx22n ditutup bukan bug (QR memakai SC-DINE-IN default saat zona 0; test regresi `qr-service-charge-default.test.ts`), legend-etmr2 (aturan produk zona 0), legend-k7x4p (take-away POS di sesi meja).

Pakai subagent Codex paralel (maks 6), satu per brief, lalu periksa sendiri temuan sebelum menulis hasil. Laporan sesuai prosedur 217.
