# 525 Fix temuan Codex 524: backfill + ubah atasan HRIS (ws/hris-manager-backfill)

Peran: engineer (~/.agents/team/roles/engineer.md). Model Sonnet 5.5. Tingkat K (akses): review akhir satu subagent architect effort xhigh.
Langkah 0: worktree `.worktrees/hris-manager-backfill` (cabang ws/hris-manager-backfill, tip df9eb4eb). Bila hilang: `git worktree add .worktrees/hris-manager-backfill ws/hris-manager-backfill`.
Kartu: legend-qhqf8, legend-f4uvg. Tanpa migrasi baru.

Temuan (semua P2, keputusan CTO: betulkan semua):
1. `apps/api/src/db/backfill-employee-managers.ts:373` — dry-run hanya simpan ID karyawan; saat apply, usulan atasan dihitung ulang dan bisa beda dari yang disetujui HR. Fix: dry-run tulis manifest (employee_id, current_manager_id, proposed_manager_id); `--apply` wajib baca manifest, cocokkan dengan keadaan terkunci, skip + laporkan baris yang berubah.
2. `apps/api/src/db/backfill-employee-managers.ts:462` — calon atasan tidak dikunci; offboarding bisa commit di tengah. Fix: kunci calon atasan `FOR SHARE`, cek ulang aktif/tenant/kelayakan setelah lock, tahan sampai commit (seperti jalur API PATCH).
3. `apps/web/src/features/ws10-employee-master/components/employee-profile-page.tsx:110` — tombol 'Ubah atasan' pakai capability global; muncul di profil sendiri dan outlet yang hanya view. Fix: API detail karyawan kirim `canChangeManager` per karyawan (outlet scope + larangan diri sendiri); UI pakai itu.

Paralel: 1 implementer untuk 1+2 (file skrip sama, berurutan di implementer itu), 1 implementer untuk 3, 1 test-writer untuk test gagal-dulu tiap temuan. Lalu test-runner (test terarah via `heavy`, LEGEND_TEST_FILES), tsc via `heavy`, lalu architect xhigh.
Selesai: commit + push ke ws/hris-manager-backfill (tanpa --force). Laporan: hash akhir, test yang dijalankan + hasil, angka subagent (total, puncak bersamaan, pemegang heavy), temuan architect. Satu laporan akhir; tunggu job latar dengan Monitor di giliran yang sama, jangan poll file output subagent.
