# 792 Perbaikan akses baca foto fasilitas (second opinion Codex, tingkat K akses)

Basis: `git fetch origin && git reset --hard origin/ghostex/upload-foto-fasilitas-sungguhan` (5738a8412), tetap di cabang itu, push ke sana.

Keputusan CTO:
1. `apps/api/src/services/core-storage-access.ts:213`: pemilik tidak lagi otomatis boleh baca. Pemilik juga harus masih punya izin fitur dan akses outlet objek saat ini; dicabut = tidak dapat signed URL.
2. `core-storage-access.ts:100,104,108`: aturan baca per kind:
   - `maintenance_ticket`: staf dengan izin fitur di outlet objek boleh baca (tim perlu melihat foto kerusakan), plus manajer fitur.
   - `checklist_evidence` (termasuk tanda tangan = data pribadi) dan `cleaning_task`: hanya pemilik (dengan izin aktif) dan manajer fitur di outlet itu.
Test gagal-dulu: izin dicabut -> pemilik ditolak; staf lain di outlet sama -> ditolak untuk checklist/cleaning, boleh untuk tiket; lintas outlet/tenant tetap ditolak.

Selesai: test terarah lewat heavy, pra-gate (prettier, eslint, typecheck API), satu reviewer sonnet atas diff, commit, push. Jangan merge. Laporan: SHA, test, angka subagent.
