# 860 Akses HRIS (engineer Sonnet, akses)

Langkah 0: `git log --all --oneline --grep=<id>` per kartu; sudah ada: lapor, jangan ulang. Pastikan base memuat kode yang disebut kartu (`git merge-base --is-ancestor`); tidak ada: cari cabang yang memuatnya, lapor CTO bila ragu.

- legend-qu04u: leave detail/list presentRequest mengeluarkan link lampiran tanpa cek self.leave.request aktif di outlet cuti. Cabang fix/leave-attach-860 dari milestone/m1 (cek kode ada di m1).
- legend-2boxs: server tolak POST koreksi absen bila id karyawan yang diharapkan tidak cocok dengan sesi (expectedEmployeeId di kontrak shared). Cabang fix/koreksi-identitas-860 dari fix/hris-koreksi-so-852 (408336d1c), worktree terpisah.

Test gagal-dulu per kartu, termasuk isolasi antar outlet/tenant. Tanpa migrasi.
Paralel: test-writer + implementer per kartu. Review: satu subagent architect effort xhigh (akses).
Pra-gate AGENTS.md. Commit + push tanpa force. Klaim kartu dengan bd, jangan close. Lapor sha per cabang, test, temuan review, angka subagent.
