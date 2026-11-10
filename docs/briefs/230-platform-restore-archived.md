# Brief: engineer — pulihkan tenant diarsip / outlet ditutup dalam 30 hari (legend-umzos)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/platform-restore-archived` dari `integ/m1-batch31`. Worktree `.worktrees/platform-restore-archived`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-umzos` (P2). Keputusan founder Q40 (lihat `bd show legend-d22m` dan `bd show legend-umzos`): admin platform dapat memulihkan tenant berstatus `archived` dan outlet berstatus `closed` ke status sebelumnya dalam 30 hari sejak transisi; sesudah 30 hari status itu final. Hari ini `packages/shared/src/platform/org.ts:75-78` dan `:239-242` membuat keduanya final.
- Catat waktu transisi (`archivedAt` / `closedAt`) dan status sebelumnya. Data lama tanpa waktu transisi: anggap final bila tidak bisa dibuktikan masih dalam 30 hari (jelaskan pilihannya di laporan).
- Aksi pulihkan: hanya aktor platform dengan izin yang sama seperti arsip/tutup, alasan wajib, audit TEN-04.
- Periksa efek samping saat pulih: edge node outlet, urutan nomor struk, langganan/subscription, akses pengguna. Pulih tidak boleh membuat nomor struk ganda atau edge lama tersambung tanpa daftar ulang bila itu tidak aman; bila ada efek yang belum bisa ditangani, tolak pulih dengan pesan jelas dan buat kartu.
- Perbarui PRD F4 di `docs/PRD.md` (satu paragraf aturan 30 hari).

## Kartu
`legend-umzos`. Di awal: `ghostex board associate legend-umzos` dan `bd update legend-umzos --status in_progress`. Saat melapor: `bd update legend-umzos --status review` dan `bd comment legend-umzos "<ringkasan>"`. UI Panel Platform tidak termasuk: buat kartu terpisah `-l platform,ui` dan sebut di laporan.

## Scope
Boleh: `packages/shared/src/platform/org.ts`, service/route platform org, skema tenant/outlet, kontrak shared, `docs/PRD.md` bagian F4, test. Jangan: penunjukan Owner (`ws/platform-assign-owner`, thread lain; hindari berkas provisioning/akses grant), refund, PIN edge, pajak, UI.
Migrasi: pakai 0165, `when` 1794244000000.

## Bukti selesai
- Test: arsip lalu pulih dalam 30 hari kembali ke status sebelumnya; sesudah 30 hari ditolak; aktor non-platform dan alasan kosong ditolak; audit tercatat; efek samping yang diperiksa punya test.
- `LEGEND_TEST_FILES` daftar eksplisit (path `src/test/...`) lewat `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="..." pnpm test'`, sertakan `src/test/edge-received-events-migration.test.ts` dan `src/test/migration-fk-force-rls.test.ts`; `db:generate` harus kosong.
- tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier untuk berkas berubah. Jangan jalankan `pnpm check` penuh.
- Review K (migrasi + akses): subagent reviewer Opus + architect paralel. Tulis brief Codex `docs/briefs/230b-second-opinion-platform-restore.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil, bukti, file berubah, SHA, nomor migrasi, kartu UI baru, risiko tersisa, jumlah subagent dan puncak bersamaan. Jangan menunggu proses global atau loop sleep. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
