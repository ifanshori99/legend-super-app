# Brief 155: engineer — PPh21 kelebihan potong milik perusahaan tidak boleh mengurangi pajak karyawan (legend-u1xq)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.
Tingkat K (pajak): desain dulu oleh subagent `architect`, lalu implementasi, lalu `reviewer` Opus dan `architect` bersamaan sebelum melapor.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
Base `integ/m1-batch5` (berisi perbaikan legend-6q7o, legend-6p71, legend-m9gx di `ws/fix-6q7o`).
`git worktree add .worktrees/pph21-overwithhold -b ws/pph21-overwithhold integ/m1-batch5`. Jangan pakai `--worktree` Ghostex.

## Tujuan
`bd show legend-u1xq`, aturan F di `docs/briefs/sub-pph21-history-split.md`, kode `packages/shared/src/hris/payroll/pph21.ts` `computePph21Period`. Saat kelebihan potong Jan-Nov milik perusahaan (H < 0, T >= 0), kredit perusahaan sekarang pindah ke karyawan. Contoh di bead: gross-up 15 jt Jan-Nov, Desember gross; karyawan bayar 1.443.498, seharusnya 2.250.000. Perbaiki tanpa migrasi: izinkan W > T plus refund perusahaan saat T >= 0, dan ganti invarian `W <= T` dan `A+B+W = T` menjadi `withheld + borne - kedua refund = T`. Setoran ke DJP harus tetap benar dan karyawan tidak pernah menanggung lebih dari bagiannya.
Di awal: `ghostex board associate legend-u1xq`, `bd update legend-u1xq --status in_progress`. Saat melapor: `--status review` dan `bd comment`.

## Scope
- Boleh: `packages/shared/src/hris/payroll/pph21.ts` dan helper-nya, pemanggil di service payroll bila kontrak hasil berubah, test di `apps/api/src/test/` (`payroll-pph21-*`).
- Jangan: `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`, migrasi, UI, modul jurnal akuntansi (bila slip/jurnal perlu menyesuaikan, buat bead).

## Bukti selesai
- Test referensi dengan hitungan tangan (tulis langkahnya di komentar test): contoh di bead; H < 0 dengan T >= 0 untuk kedua kebijakan alokasi; H < 0 dengan T < 0; kasus satu skema tidak berubah; regresi semua test `payroll-pph21-*` yang ada; invarian baru dicek di tiap kasus.
- `LEGEND_TEST_FILES="<semua payroll-pph21-* dan payroll terkait>" pnpm test`, typecheck dan lint lewat `heavy`.
- Commit lokal di `ws/pph21-overwithhold`, jangan push. Tulis `docs/briefs/156-second-opinion-pph21-overwithhold.md` di folder proyek (jangan commit): rentang diff, maks 800 baris non-test per run, berkas berisiko, invariant, tanpa temuan review Claude.

## Laporan
SHA awal..akhir, invarian lama dan baru, tabel hasil contoh sebelum dan sesudah, hasil gate, temuan review K, bead baru.
