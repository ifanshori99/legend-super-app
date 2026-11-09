# Brief 89a: merge-prep satu cabang (subagent implementer)

Konteks: merge train ke `milestone/m1` (brief 89). Isi m1 setelah journals digabung = `ws/journals` 4ec3babb. Kamu menyiapkan SATU cabang di worktree prep-nya sendiri. Jangan sentuh worktree lain, jangan push, jangan merge ke m1/main.

## Langkah
1. `cd .worktrees/prep-<cabang>` (cabang `prep/<cabang>`). Bila `node_modules` belum ada: `node scripts/worktree-setup.mjs`.
2. `git merge --no-ff 4ec3babb -m "merge-prep: m1 (journals 4ec3babb) into <cabang>"`.
3. Konflik kode/tes/dokumen: selesaikan, gabungkan maksud KEDUA sisi (jangan buang fitur mana pun).
4. Konflik migration (`apps/api/drizzle/*.sql`, `apps/api/drizzle/meta/*`): JANGAN regen. Ambil sisi m1 (`--theirs` dari 4ec3babb) untuk `_journal.json` dan snapshot milik m1, simpan SQL milik cabang apa adanya di nomor lamanya (regen dilakukan serial nanti). Catat file migration milik cabang (nama + apakah ada SQL custom RLS / FK di bawah FORCE RLS).
5. Schema TS (`apps/api/src/db/schema*`) konflik: gabungkan kedua sisi.
6. `pnpm -s typecheck` (filter output: hanya error). Perbaiki error akibat merge.
7. Jalankan test yang terdampak saja: `pnpm --filter @starter/api exec vitest run <file...>` / `pnpm --filter <pkg> exec vitest run <file...>` untuk file yang konflik atau yang tersentuh kedua sisi. Output difilter (`| tail -40`). Jangan jalankan full `pnpm check`. Jangan `pkill`/`killall`.
   - Test yang butuh migration cabang mungkin gagal karena journal belum diregen: catat, jangan akali.
8. Commit lokal di `prep/<cabang>`.

## Laporan (singkat)
- SHA commit prep.
- File konflik + cara menyelesaikan.
- Migration milik cabang (nama file, custom RLS/FK FORCE RLS ya/tidak).
- Hasil typecheck + test yang dijalankan (lulus/gagal, nama test gagal).
- Konflik semantik (dua sisi mengubah perilaku yang sama, enum/permission/route bentrok, dsb).

## Wajib: merge asli, bukan squash (09-11)
- Gunakan `git merge --no-ff <basis>` sehingga commit merge punya dua parent. Jangan `git merge --squash`, jangan commit satu-parent yang berisi isi m1. Commit squash membuat merge berikutnya ke m1 bentrok ulang (kejadian: prep/fix-edc-codex a043f87a).
- Cek: `git log --format="%h %p" -1` harus menampilkan dua parent.

## Wajib: suite root harus jalan (09-11)
- Gate dihitung lulus hanya bila log memuat baris vitest DAN baris root `ℹ tests / ℹ pass / ℹ fail`. Bila vitest gagal, suite root tidak jalan: jangan merge berdasarkan "flake" sebelum suite root juga dijalankan (`node --test tests/<file>.test.mjs` untuk yang relevan, atau gate ulang).
