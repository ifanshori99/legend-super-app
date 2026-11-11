# 508 Second-opinion Codex: area akses kecil (ws/sec-small)

Peran: second-opinion (~/.agents/team/roles/second-opinion.md). READ-ONLY: jangan edit, jangan commit.
Repo: /Users/ifanshori99/Projects/legend super app/legend. Diff: `git diff origin/ws/approvals-rbac-bundle...origin/ws/sec-small` (3 commit, 9 file, tanpa migrasi).

Fokus (akses, tingkat K):
- `/staff-pins/verify` dan `/hris/attendance/outlet-clock`: token device basi setelah rotasi (`token_issued_at`) benar-benar ditolak di semua jalur (tenant dari Host vs dari token, header lain, race rotasi).
- Preferensi notifikasi: email kategori security tidak bisa dimatikan lewat jalur mana pun (PUT, bulk, import, mock vs API beda perilaku), normalisasi saat baca tidak membocorkan atau menulis data.
- Kode status (401/403/404/422) tidak membuka informasi tenant atau device.

Laporan: daftar temuan P0-P3 dengan file:baris, skenario gagal konkret, dan usulan fix. Tanpa temuan: tulis itu jelas.
