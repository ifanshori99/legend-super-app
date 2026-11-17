# 954 Susulan second opinion payout 950 (K uang + migrasi)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (uang + migrasi).
Cabang: worktree-mu dari `origin/ghostex/947-payout-934-followups` (aca164ca5). Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru 0440-0444 (nomor kerja).
Laporan SO: `git show ux/customer-order-benchmark:docs/qa/second-opinion-payout-934-947.md`.
Kartu (`bd show <id>`; claim dulu):
- legend-628t9 (P2): grant batch_approve kedaluwarsa saat antre lock tetap dikonsumsi lewat SQL langsung. Validasi expiry dengan waktu sesudah lock, tepat sebelum consume. Test dua koneksi (tahan lock run sampai lewat expiry -> ditolak).
- legend-e3m8d (P3): test audit batch_reopened dan batch_stopped.
Jangan sampai rugi: test bukti grant kedaluwarsa tidak menghasilkan persetujuan dan tidak ada uang keluar.
Paralel: Explore + test-writer (gagal-dulu) dalam satu giliran, satu implementer per kartu, lalu test-runner + architect xhigh bersamaan. Suite payout hanya setelah kode beku (Retro 39).
Bukti: gagal-dulu lalu hijau; test area payout lewat heavy setelah commit terakhir; pra-gate AGENTS.md (prettier, eslint, db:generate kosong, registry migrasi, typecheck API sekali); architect tanpa P1.
Laporan: SHA, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari kedua kartu. Lapor sekali di akhir; jangan akhiri giliran untuk kabar antara.
