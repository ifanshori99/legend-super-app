# Brief: engineer — dokumen pemegang saham (legend-69yq)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/contracts.md`.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/shareholder-docs`, cabang `ws/shareholder-docs` (dari `main` 31bf885). Setup: `pnpm install --offline --frozen-lockfile` (gagal: `--prefer-offline`); jangan symlink `node_modules`.

## Tujuan
WS-07, PRD §3.35 Dokumen, §6 I `shareholder_documents`, SH-01: service + route unggah/terbitkan dokumen pemegang saham di atas kontrak yang sudah ada (`shareholderDocumentSchema`, endpoint create/publish, `assertDocumentVisibleToShareholders`, dari legend-cq2), dengan adapter storage yang sudah ada. Pemegang saham hanya melihat dokumen `published` dengan `visibility=shareholders` milik profit entity-nya; dokumen manajemen tetap internal. Detail: `bd show legend-69yq`.

## Kartu
`legend-69yq`. Di awal: `ghostex board associate legend-69yq`, `bd update legend-69yq --status in_progress`. Saat melapor: status `review` + `bd comment` bahasa biasa.

## Catatan (data pribadi, keamanan)
- Akses file lewat URL bertanda tangan berumur pendek atau stream lewat API dengan cek izin; kunci storage tidak bisa ditebak dan tidak bocor ke log.
- Validasi tipe dan ukuran file; nama file dari pengguna tidak dipakai mentah di kunci storage.
- Terbit bersifat satu arah atau tercatat audit; perubahan visibilitas tercatat audit.
- Tabel baru (bila perlu): `tenant_id` NOT NULL, RLS FORCE, unique termasuk `tenant_id`. Migration via drizzle-kit. Jangan baca `.env*`. Jangan pkill proses test global.

## Scope
- Boleh: schema/service/route/test `*shareholder-document*` atau `profit-share-document*`, kontrak di `packages/shared` bagian profit share (tambah, jangan ubah yang dipakai web), satu-dua baris registrasi.
- Jangan: `apps/web/`, POS, payroll, akuntansi jurnal, payment.

## Bukti selesai
- Test: unggah + terbitkan oleh pengelola berizin; pemegang saham melihat hanya dokumen published+shareholders entity sendiri; dokumen manajemen dan entity lain ditolak; draft tidak terlihat; tenant lain ditolak (RLS); file tidak valid ditolak; URL/stream ditolak tanpa izin.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus (satu gerbang penuh setelah perubahan terakhir). `git status` bersih.
- Subagent reviewer konteks segar cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal di `ws/shareholder-docs`, hanya file dalam scope. Pesan commit merujuk legend-69yq.

## Laporan
Hasil, bukti (perintah dan hasilnya), file berubah, commit, risiko tersisa, yang dibutuhkan dari CTO.
