# 1201 Akses: baca izin pakai jam DB (engineer Sonnet, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.
Base: `ghostex/1183-fix-so1181-akses` (c3d5ca1bc; berisi 1172 + fix SO 1181). Cabang: `ws/1201-akses-jam-db`. Menggantikan 1172 dan 1183 di batch98. Tingkat K (akses): architect xhigh. Tanpa migrasi bila bisa; bila perlu, 0732 saja.
Kartu 1172 (tetap terbuka sampai ini SIAP): hb1u9, v8dfx, hzdy5, z2kaf, e3qgo.

## Masalah (merge train batch97)
1172 menulis `valid_from`/`valid_until` dengan jam DB (`readDbClock`), tetapi pembacaan izin memakai jam aplikasi (`new Date()`): `apps/api/src/middleware/permissions.ts` (sekitar baris 108, 195, 241, 256) dan `apps/api/src/routes/me.routes.ts` (73, 146). Jam DB bisa beberapa ms di depan host: role baru belum aktif, akses yang dicabut masih aktif selama selisih itu. Gagal deterministik: `platform-tenant-owner` (9 tes), `platform-access-api` TEN-03.

## Keputusan CTO
- Perbandingan masa berlaku dilakukan di SQL (`now()` di query yang memang sudah memuat grant), bukan query jam tambahan per request. Satu sumber jam: DB, untuk tulis dan baca.
- Semua jalur baca izin (middleware, `/me`, dan pembaca lain yang ditemukan Explore: grep `valid_until`, `valid_from`, `readDbClock`) memakai aturan yang sama. Pencabutan berlaku seketika menurut jam DB.
- Dilarang toleransi skew di tes.

## Bukti selesai
Fail-first: tes yang mensimulasikan jam DB di depan app (mis. grant dengan `valid_from = now()` lalu langsung request) merah di c3d5ca1bc, hijau sesudah; sertakan kasus cabut. `platform-tenant-owner`, `platform-access-api` dan berkas akses 1172/1183 hijau (terarah lewat heavy). Typecheck api sekali lewat heavy, prettier + eslint. Architect xhigh. Commit, push. Tunggu job heavy dengan Bash run_in_background satu notifikasi; tanpa Monitor/loop foreground; tanpa laporan antara.

## Laporan
SHA, subagent total dan puncak, gate, yang belum teruji. Lapor sekali.
