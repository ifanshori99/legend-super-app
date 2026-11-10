# Brief: engineer — pustaka SOP, pelatihan, pengumuman (legend-7df1)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/contracts.md`.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/hris-sop`, cabang `ws/hris-sop` (dari `main` 31bf885). Setup: `pnpm install --offline --frozen-lockfile` (gagal: `--prefer-offline`); jangan symlink `node_modules`.

## Tujuan
WS-10, PRD v1.7 §3 F32 Pustaka SOP, Pelatihan, Pengumuman (`docs/PRD.md`): SOP berversi dengan konfirmasi baca per karyawan, modul pelatihan + kuis + sertifikasi, pengumuman dengan tanda terima. Termasuk endpoint yang dibutuhkan FE `legend-r0wz`: buat pengumuman + daftar penerima/tanda terima; unggah versi SOP; pendaftaran pelatihan + sertifikat. Detail: `bd show legend-7df1`.

## Kartu
`legend-7df1`. Di awal: `ghostex board associate legend-7df1`, `bd update legend-7df1 --status in_progress`. Saat melapor: status `review` + `bd comment` bahasa biasa.

## Catatan
- Tabel baru: `tenant_id` NOT NULL, RLS FORCE, unique termasuk `tenant_id`; tabel operasional punya `outlet_id`. Migration via drizzle-kit, jangan edit `_journal.json`. Jangan baca `.env*`.
- Versi SOP tidak bisa diubah setelah terbit (versi baru = baris baru); konfirmasi baca terikat ke versi.
- Penyimpanan file: pakai abstraksi storage yang sudah ada di repo (cari dulu); jangan tambah vendor.
- `sop_documents` nanti jadi sumber `knowledge_chunks` (AI); cukup siapkan kolom teks/metadata, jangan bangun indeks.
- Cabang `ws/hris-leave` (belum merge) juga menyentuh `hris*`: pakai nama berkas baru `hris-sop*`, `hris-training*`, `hris-announcement*`; jangan ubah berkas cuti/lembur.

## Scope
- Boleh: `apps/api/src/db/schema/hris-{sop,training,announcement}*.ts`, migration baru, `apps/api/src/services/hris-{sop,training,announcement}*.ts`, `apps/api/src/routes/hris-{sop,training,announcement}*.routes.ts`, test `apps/api/src/test/hris-{sop,training,announcement}*.test.ts`, kontrak di `packages/shared/src/hris/`, satu-dua baris registrasi.
- Jangan: `apps/web/`, payroll, cuti/lembur, POS, akuntansi.

## Bukti selesai
- Test: versi SOP immutable; konfirmasi baca per versi; kuis lulus/gagal dan sertifikat; pengumuman + tanda terima; izin dan scope outlet; isolasi tenant (RLS).
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus (satu gerbang penuh setelah perubahan terakhir). `git status` bersih.
- Subagent reviewer konteks segar cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal di `ws/hris-sop`, hanya file dalam scope. Pesan commit merujuk legend-7df1.

## Laporan
Hasil, bukti (perintah dan hasilnya), file berubah, commit, risiko tersisa, yang dibutuhkan dari CTO.
