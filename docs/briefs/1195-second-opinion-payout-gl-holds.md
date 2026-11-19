# 1195 Second opinion payout GL holds (1184)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran.

Fokus: `git fetch origin`, lalu `git diff origin/milestone/m1...origin/ws/1184-payout-gl-holds -- apps/api packages/shared` (head 356b357e6; migrasi 0715-0716).
Isi: legend-3xzop (POST /payout-gl-postings/:postingId/fee-opening-balance: tandai biaya posting accounting_was_off sudah di saldo pembukaan, tanpa jurnal; tidak boleh dijurnal jalur mana pun sesudahnya), legend-6qp12 (POST .../payable-hold-release: lepas hold hanya bila jurnal settle ada dan mendebit hanya akun payable beku). Izin baru payroll.payout.gl_resolve (owner, finance) + backfill 0716. Guard DB 0715 dibangun ulang dari 0412/0415.
Cari: jurnal ganda atau hilang, biaya hilang dari laporan tanpa jejak, hold lepas dengan akun salah (retur kredit akun salah), self-approval, step-up/MFA lewat, lintas tenant, guard DB melonggarkan kolom lain, backfill izin ke peran yang salah.
Hasil: tulis `docs/qa/second-opinion-payout-gl-1195.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain.
