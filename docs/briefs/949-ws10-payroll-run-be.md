# 949 WS-10 payroll run backend (4 kartu, K uang + migrasi)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (uang + migrasi).
Cabang: worktree-mu dari `origin/milestone/m1` (tip terbaru). Commit dan push tanpa force. Tidak merge, tidak deploy. Nomor migrasi kerja 0460-0469 (akan dinomori ulang merge train).
Kartu (`bd show <id>` untuk AC; claim dulu):
- legend-xo0xx: tabel `payroll_run_results` + `payroll_loan_deductions` (fondasi; RLS + FORCE sesuai pola di docs/plan/contracts.md).
- legend-0ytbu: aturan populasi run + subjek setahun sebagian (O7, O8).
- legend-vepv0: route create/approve/return-to-draft run (O6); butuh xo0xx. Izin lewat requirePermission, filter tenant di SQL.
- legend-838hi: ekspor Coretax BPA1 (A1 tahunan), modul terpisah.
Jangan sentuh berkas payout/pencairan (`*payout*`, sedang dipegang 947). Keputusan founder: metode bayar gaji bawaan transfer bila rekening tercatat, selain itu tunai (Q10); format bank BCA ditunda (Q1).
Jangan sampai rugi: test bukti tidak ada karyawan dibayar lebih (run ganda, potongan pinjaman ganda, approve dua kali, return-to-draft lalu approve ulang) dan potongan tidak melebihi sisa pinjaman.
Paralel: Explore per kartu + test-writer (gagal-dulu) dalam satu giliran; implementer xo0xx, 0ytbu, 838hi bersamaan, vepv0 setelah xo0xx; lalu test-runner + architect xhigh bersamaan.
Bukti: gagal-dulu lalu hijau per kartu; test area payroll/hris lewat heavy setelah commit terakhir; pra-gate AGENTS.md (prettier, eslint, db:generate kosong, registry migrasi, typecheck API + shared sekali lewat heavy); architect tanpa P1.
Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu. Lapor sekali di akhir; jangan akhiri giliran untuk kabar antara.
