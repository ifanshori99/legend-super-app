# 843 HRIS bug P1 (engineer Sonnet)

Kartu: legend-xzzdq (cache profil/koreksi bocor saat ganti akun, data pribadi), legend-l5tvy (antrean 20 penolakan membuang pengajuan baru; Ubah menghapus pengajuan lama beserta penggantinya).
Sumber temuan: docs/qa/second-opinion-hris.md.

- Paralel: Explore per kartu, test-writer gagal-dulu per kartu, satu implementer per kartu, file tidak bertumpuk.
- xzzdq: bersihkan cache TanStack Query saat sesi berganti atau key per user. Test: login A, lihat koreksi, logout, login B, tidak ada data A.
- l5tvy: pengajuan baru tidak pernah hilang; Ubah hanya mengganti pengajuan yang dipilih.
- Jangan sentuh hris-leave-collective.service.ts, hris-offboarding.service.ts, payroll-run-pph21.service.ts (milik thread G2up8).
- Migrasi: tidak diharapkan; bila perlu pakai 0386.
- Review: satu subagent architect effort high (data pribadi).
- Pra-gate AGENTS.md "Pra-gate sebelum lapor". Commit + push tanpa force. Lapor dengan angka subagent (total, puncak, pemegang heavy).
