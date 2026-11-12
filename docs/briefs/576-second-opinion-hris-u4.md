# Brief: second opinion (Codex) — area HRIS U4

## Peran
Baca `~/.agents/team/roles/second-opinion.md` dan bagian "Kuota Codex dan second opinion" di `~/.agents/team/TEAM.md`. Read-only: jangan ubah kode, jangan commit selain catatan review.

## Cakupan
Cabang `ws/hris-u4-full` (5042d392), diff terhadap `milestone/m1` ab574d58: `git diff ab574d58...5042d392`. Isinya backend + layar HRIS U4 (pengajuan cuti/shift, tukar shift, keputusan supervisor, lampiran, alasan tolak, cabut akses dukungan Owner) dan migrasi `0406_hris_u4` (di m1 akan dinomori 0308 oleh merge train batch51; isi SQL sama).

## Fokus (akses + migrasi)
- Otorisasi: tiap endpoint memakai requireAuth, requireTrustedOrigin, requirePermission yang tepat; filter tenant + outlet di SQL; karyawan tidak bisa membaca/memutuskan pengajuan orang lain; supervisor dibatasi outlet; data nama pemohon/rincian shift tidak membuka direktori/roster penuh.
- Cabut akses dukungan (legend-8iuos): hanya Owner, efektif segera, tidak bisa dilewati sesi lama.
- Migrasi: RLS/FORCE RLS, FK, index, aman diterapkan di DB berisi data tanpa BYPASSRLS, tidak mengunci tabel besar lama.
- Lampiran: batas ukuran/tipe, tidak bisa diambil lintas tenant.
- Race: dua supervisor memutuskan bersamaan, tukar shift diterima dua kali.

## Hasil
- Tiap temuan nyata: `bd create --type=bug --priority=<0-2> --labels=second-opinion,hris` dengan file:baris, skenario gagal, saran.
- Lapor: daftar id kartu, ringkas tingkat keparahan, area yang dicek tapi bersih, dan yang tidak sempat dicek.
