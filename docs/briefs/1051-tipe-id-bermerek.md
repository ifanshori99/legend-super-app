# 1051 Helper tipe ID bermerek Drizzle (legend-izy5l)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Reviewer sonnet (tanpa perubahan perilaku).
Base: origin/milestone/m1. Panduan ada di docs/backend.md (cabang ghostex/b322bfb5 67a8b6411, merge dulu ke cabangmu). Buat helper tipe untuk ID bermerek (TenantId dsb.) di where/inArray/sql, ganti pemakaian yang memicu TS2769 (termasuk berkas query uang/akses: HANYA perubahan tipe, tanpa ubah logika/SQL yang dihasilkan). Spawn Explore untuk menemukan semua titik, implementer per kelompok berkas tidak bertumpuk.
Bukti: typecheck API + web lewat heavy, test terarah berkas yang disentuh, prettier/eslint. Commit, push tanpa force. Laporan sekali di akhir dengan SHA dan angka subagent.
