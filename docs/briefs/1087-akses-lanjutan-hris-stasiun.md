# Brief: engineer — akses lanjutan HRIS + stasiun dapur (4 kartu, tingkat K akses)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Langkah pertama: spawn subagent paralel dalam satu giliran.

## Worktree
Worktree Ghostex milikmu, base `ws/1086-hris-kecil` (3b0baeb2e, SIAP batch91, belum landing di m1). Langkah 0: `node ~/.claude/scripts/worktree-slim.mjs --full && heavy pnpm worktree:setup`. Migrasi: rentang 0702-0703 saja. Cabang: `ws/1087-akses-lanjutan`.

## Kartu
Di awal: `ghostex board associate <id>` + `bd update <id> --status in_progress`. Saat lapor: `--status review` + `bd comment`. Baca `bd show` tiap kartu (termasuk komentar) untuk AC.
1. `legend-huz8` stasiun dapur: field `canManageStationConfig` (default false) di kontrak GET `/api/me/access` (packages/shared + service API + `accessFromView`), lalu UI `stations-page.tsx` menyembunyikan ganti nama/tipe/hapus untuk grant stasiun saja, dan 403 `PERMISSION_DENIED` dipetakan ke pesan izin (kunci teks baru). Server tetap pemeriksa akses (legend-cot3 sudah menolak).
2. `legend-m7yeb` lampiran SOP: source kind khusus SOP + penautan media ke versi SOP, menggantikan aturan berbasis pemilik dari 1086 (`hris-sop.service.ts:312-370`, `core-storage-access.ts`). Migrasi di 0702-0703. Media lama (legacy) tetap terbaca dan bisa dibawa ke versi baru (catatan P3 reviewer 1086: legacy `sourceKind` sekarang 422 saat terbit versi — perbaiki di sini). SOP berlingkup tenant: media baru dari aktor yang tidak lagi punya akses outlet asal media ditolak.
3. `legend-5bx8v` duty meal: tolak catat bila karyawan tidak bertugas di outlet yang dicatat (aturan membatasi).
4. `legend-p30t3` decoder cursor lain (taskCursor checklist, dst.) menolak `\u0000` dengan 422 seperti `cursorPair`.

## Aturan
- Akses: bila ragu, pilih yang menolak. Test lintas tenant dan lintas outlet untuk kartu 1, 2, 3.
- Migrasi: tambah saja, tidak mengubah identitas data lama; `pnpm db:generate` kosong sesudahnya.
- Teks UI baru: daftarkan ke katalog text-contract.
- Hindari area aktif: refund (ws/1072), kas (cek-kas-1102), edge (ws/1073), int/batch90.

## Pembagian paralel
- Explore (1): peta file tiap kartu + cek tabrakan dengan `origin/int/batch90`.
- test-writer (1): test gagal-dulu kartu 1-4.
- implementer per kartu (file terpisah; kartu 1 kontrak dulu lalu UI berurutan).
- test-runner: pemegang token heavy (setup, test terarah, typecheck API + web sekali).
- architect (effort xhigh, akses + migrasi): satu review atas diff akhir. Temuan nyata dibetulkan sebelum lapor.

## Bukti selesai
Test terarah lulus, merah-dulu tercatat, typecheck API + web lulus, text-contract lulus, `db:generate` kosong, architect tanpa P0-P2 terbuka.

## Batas kerja ulang
Ikuti `~/.agents/team/brief-template.md` bagian "Batas kerja ulang". Jangan `pkill`. Matikan dev server/browser milikmu.

## Sebelum melapor
Pra-gate AGENTS.md. Commit di `ws/1087-akses-lanjutan`, push tanpa `--force`.

## Laporan
Hasil per kartu, migrasi, bukti, berkas, commit, head SHA, risiko.
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
