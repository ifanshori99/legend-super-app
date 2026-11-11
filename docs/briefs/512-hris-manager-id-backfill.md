# 512 Backfill manager_id karyawan sebelum rilis HRIS (legend-qhqf8 P1, data pribadi, tingkat K)

Peran: engineer (~/.agents/team/roles/engineer.md). Repo: /Users/ifanshori99/Projects/legend super app/legend.
Langkah 0: `git -C "/Users/ifanshori99/Projects/legend super app/legend" fetch origin ws/hris-leave-guard && git -C "/Users/ifanshori99/Projects/legend super app/legend" worktree add .worktrees/hris-manager-backfill -b ws/hris-manager-backfill origin/ws/hris-leave-guard`. PORT dan nama DB sendiri. Tanpa migrasi skema.

Konteks: 502 (4b7eb37a) membatasi supervisor/outlet_manager ke bawahan langsung; karyawan manager_id null jadi tak terlihat. Founder Q41: GM melihat semua karyawan brand-nya.
Tugas:
1. Query audit read-only: karyawan aktif per tenant/brand/outlet dengan manager_id null atau menunjuk karyawan nonaktif/lintas outlet.
2. Skrip backfill dengan --dry-run default (usulan manager dari outlet_manager outlet itu; tidak ada usulan: masuk daftar manual), satu transaksi per tenant, audit log, bisa diulang aman.
3. Runbook docs/ops/hris-manager-backfill.md: urutan sebelum rollout, siapa menyetujui daftar manual. JANGAN jalankan ke production atau staging; itu gerbang founder.
4. Opsional bila kecil: peringatan di layar HR untuk karyawan tanpa atasan.
Bukti: test skrip di DB lokal (null, nonaktif, lintas outlet, idempoten), test bahwa GM tetap melihat semua karyawan brand. Subagent architect effort high atas diff. Gate tsc/eslint/prettier/test terarah lewat `heavy`. Commit, push (tanpa --force). bd: qhqf8.
Laporan: commit, contoh output dry-run, temuan architect, angka subagent.
