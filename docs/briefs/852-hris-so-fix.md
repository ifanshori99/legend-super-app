# 852 Perbaikan second opinion HRIS payroll (engineer Sonnet)

Temuan: docs/qa/second-opinion-hris-payroll-15nov.md (4 P2). Keputusan sudah diambil CTO: perbaiki keempatnya sesuai baris "Perbaikan" di sana.

- Cabang A (temuan 1-3): kerja di atas ghostex/hris-payroll-followups-4-kartu (309c541b8). Buat cabang fix/hris-so-852 dari sana.
- Cabang B (temuan 4): buat cabang fix/hris-koreksi-so-852 dari ghostex/hris-koreksi-absen-ditolak-tampil (0ac8e3b7c), di worktree terpisah (git worktree add).
- Test gagal-dulu tiap temuan. Temuan 1-2: test bukti karyawan tidak mendapat hari lebih dan tagihan setelah settlement tidak hilang. Temuan 3: HR outlet lama tidak menerima. Temuan 4: tab lama setelah ganti akun tidak bisa mengirim atau menghapus antrean.
- Paralel: test-writer per temuan, implementer per temuan (file terpisah).
- Tanpa migrasi.
- Review: satu subagent architect effort xhigh untuk gabungan.
- Pra-gate AGENTS.md. Commit + push tanpa force kedua cabang. Lapor sha tiap cabang dan angka subagent.
