# 951 WS-01 pengerasan akses dan identitas (4 kartu, K akses/PII/migrasi)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (akses + migrasi).
Cabang: worktree-mu dari `origin/milestone/m1` (tip terbaru). Commit dan push tanpa force. Tidak merge, tidak deploy. Nomor migrasi kerja 0470-0479 (akan dinomori ulang merge train).
Kartu (`bd show <id>` untuk AC; claim dulu):
- legend-ijcxc: PATCH manager-key tidak boleh menyasar peran karyawan atau baris `roles` custom (revoke izin lolos).
- legend-p0ms5: `requestDtos` di platform-support tidak mengirim email peminta ke admin tenant; pakai `actorNames()`.
- legend-d3quc: akses dokumen pemegang saham hanya lewat versi yang berlaku; `legend_app` tidak bisa ubah `fiscal_periods.status` tanpa cek transisi (mungkin migrasi).
- legend-tetyr: kolom versi kunci + job reseal yang bisa dilanjutkan untuk rahasia tersegel (ikuti pola `worker/hris-pii-reseal.job.ts`). Kartu terbesar.
d3quc dan tetyr berbagi rentang migrasi: d3quc 0470-0472, tetyr 0473-0479. Jangan sentuh payout, payroll run, edge registry, recon.
Paralel: Explore per kartu + test-writer (gagal-dulu: lintas tenant, peran tanpa izin, data pribadi tidak bocor) dalam satu giliran; satu implementer per kartu; lalu test-runner + architect xhigh bersamaan.
Bukti: gagal-dulu lalu hijau per kartu; test area terkait lewat heavy setelah commit terakhir; pra-gate AGENTS.md (prettier, eslint, db:generate kosong, registry migrasi, typecheck API sekali lewat heavy); architect tanpa P1.
Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu. Lapor sekali di akhir; jangan akhiri giliran untuk kabar antara.
