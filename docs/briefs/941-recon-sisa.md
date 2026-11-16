# 941 Rekonsiliasi sisa: bank recon policy + match basi + DOIT recon (legend-fnxl.9, legend-fnxl.10, legend-3wpf)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Uang/akuntansi: architect xhigh. Spawn paralel dalam satu giliran (Explore, test-writer gagal-dulu, implementer per kartu dengan file terpisah, test-runner, architect). Lapor sekali. Typecheck penuh sekali; batas 1 tsc bila free < 60%.
Cabang: worktree-mu dari `milestone/m1` (c17c60df7); commit dan push tanpa force. Migrasi sementara mulai 0460 bila perlu. Tidak merge, tidak deploy.
Kartu (baca `bd show` dulu, cek m1 dulu):
- legend-fnxl.9: `caseDueDays` (accounting-bank-recon-cases.service.ts:88, hardcoded 7) jadi kebijakan tenant; hanya peran yang sudah berwenang mengatur kebijakan akuntansi yang bisa mengubah; default 7.
- legend-fnxl.10: match rekonsiliasi bank ditandai basi saat jurnal yang di-match dibalik (reversal); muncul di daftar kasus, tidak dihapus diam-diam.
- legend-3wpf: sisa 4 temuan review brief 95 DOIT rekonsiliasi (lihat kartu).
Aturan: penyetuju penutupan kasus = Owner atau Finance Manager, salah satu cukup (founder Q12). Jangan ubah angka jurnal.
Bukti: test gagal-dulu lalu hijau, test akuntansi/recon + metric-single-path lewat heavy setelah commit terakhir, pra-gate AGENTS.md, architect xhigh tanpa P1.
Laporan: SHA, migrasi, test, temuan architect, angka subagent. Komentari kartu.
