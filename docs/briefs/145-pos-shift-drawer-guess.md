# Brief 145: engineer — kasir menebak isi laci lewat kas keluar/masuk (legend-67dt)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.
Tingkat K (kas): `reviewer` Opus dan `architect` bersamaan sebelum melapor.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
Base: `ws/small-bugs-pos-stock` (9f749d1f, berisi perbaikan test `pos-shift` terbaru).
`git worktree add .worktrees/pos-drawer-guess -b ws/pos-drawer-guess ws/small-bugs-pos-stock`. Jangan pakai `--worktree` Ghostex.

## Tujuan
`bd show legend-67dt` (baca juga riwayat review pos-shift G5rd6, commit e1674b1). Kasir bisa menebak isi laci untuk blind count lewat pasangan kas keluar/masuk: penolakan kas keluar karena saldo kurang membocorkan saldo yang diharapkan. Mitigasi M1 (tolak setelah 2 penolakan + audit) sudah ada. Kerjakan perbaikan tuntas: kas keluar yang membuat saldo yang diharapkan negatif tidak lagi ditolak dengan pesan yang membocorkan saldo, tetapi dicatat dan diteruskan ke alur persetujuan selisih (manajer), sehingga respons ke kasir tidak bergantung pada isi laci. Ubah skema dan kontrak sesuai kebutuhan (migrasi baru: laporkan nomornya; `ws/refund-promo` memakai 0106).
Di awal: `ghostex board associate legend-67dt`, `bd update legend-67dt --status in_progress`. Saat melapor: `--status review` dan `bd comment`.

## Scope
- Boleh: modul shift dan kas POS (`pos-shift*`, `pos-cash-guard.ts`), kontrak di `packages/shared`, migrasi baru, test di `apps/api/src/test/`.
- Jangan: `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`, `pos-order-payment.ts`, modul refund/DOIT/pajak, UI (laporkan bila layar kasir perlu menyesuaikan; buat bead).

## Bukti selesai
- Test: respons kas keluar identik (status, bentuk, pesan) untuk saldo cukup dan saldo kurang; saldo kurang membuat permintaan persetujuan selisih dengan audit; tutup shift memperhitungkannya; blind count tetap buta; isolasi tenant dan outlet; jalur edge offline (bila menyentuh) tetap konsisten.
- `LEGEND_TEST_FILES="<file terkait>" pnpm test` (`pos-shift.test.ts` 3 kali), typecheck dan lint lewat `heavy`, `pnpm db:generate` kosong atau migrasi tercatat.
- Commit lokal di `ws/pos-drawer-guess`, jangan push. Tulis `docs/briefs/146-second-opinion-pos-drawer-guess.md` di folder proyek (jangan commit): rentang diff, maks 800 baris non-test per run, berkas berisiko, invariant, tanpa temuan review Claude.

## Laporan
SHA awal..akhir, migrasi, hasil gate, temuan review K, dampak ke layar kasir, bead baru.
