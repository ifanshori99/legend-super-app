# Brief: second opinion (Codex) — area rahasia, kunci data, dan akses dukungan

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan bagian "Kuota Codex dan second opinion" di `~/.agents/team/TEAM.md`. Read-only: jangan ubah kode.

## Cakupan
`git diff 5cbe2a1e...c0401d94` (cabang `ws/dheu-m1`) ditambah perbaikan `fix/batch53-blockers` ca50857e bagian kunci (legend-fesa8). Isi: rotasi kunci data (keyring, fallback kunci lama, `db:rotate-data-key`, laporan rotasi), penyegelan payroll (`payroll-sealed.ts`), `secrets.ts`, satu inti pencabutan akses dukungan platform (`/end` + `/revoke`: Owner aktif + MFA, grant dicek tiap request, audit tunggal), migrasi 0287→0309. Keputusan founder: `bd memories founder-u4` (tombol cabut akses tetap).

## Fokus
- Data terenkripsi bisa hilang? Rotasi terputus di tengah, dua rotasi bersamaan, kunci lama dipensiunkan terlalu cepat (legend-tetyr masih terbuka), versi kunci NULL.
- Rahasia bocor? log, pesan error, respons API, laporan rotasi, cache.
- Akses dukungan: bypass Owner/MFA, grant kedaluwarsa masih dipakai, request yang sedang berjalan setelah dicabut, lintas tenant, audit ganda/hilang saat retry/konkurensi.
- Migrasi: FORCE RLS, aman di DB berisi data tanpa BYPASSRLS.

## Hasil
- Tiap temuan nyata: `bd create --type=bug --priority=<0-2> --labels=second-opinion,auth` dengan file:baris, skenario gagal, saran.
- Lapor: daftar kartu, ringkas keparahan, area bersih, area yang tidak sempat dicek, angka subagent.
