# Brief 151: engineer — filter query sadar station di otorisasi (legend-cot3)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.
Tingkat K (auth/otorisasi): `reviewer` Opus dan `architect` bersamaan sebelum melapor.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
`git worktree add .worktrees/station-scope -b ws/station-scope milestone/m1`. Jangan pakai `--worktree` Ghostex.
Sebelum mulai: cek `integ/m1-batch3/4/5` (`git log --all --grep=cot3`, `git grep` untuk `station-access`). Bila sebagian sudah ada di sana, base dari batch tertinggi yang memuatnya dan sebutkan di laporan.

## Tujuan
`bd show legend-cot3` (baca komentarnya). Inventaris brand dan cek brand tak dikenal sudah ada (legend-cyu.8, `apps/api/src/services/station-access.ts`). Yang kurang: filter query sadar station dan integrasinya. User yang jangkauannya hanya station di sebuah outlet tidak boleh membaca atau mengubah data station lain di outlet yang sama, atau data level outlet di luar station-nya, lewat service maupun route. Defaultnya menolak (deny by default). Petakan dulu service mana yang membaca data per station (dapur/KDS, printer/station routing, menu per station, pesanan per station) dengan subagent `Explore`, lalu pasang filter di batas service, bukan di UI.
Di awal: `ghostex board associate legend-cot3`, `bd update legend-cot3 --status in_progress`. Saat melapor: `--status review` dan `bd comment`.

## Scope
- Boleh: `station-access.ts`, helper otorisasi/scope, service yang membaca data per station, `packages/shared/src/permissions.ts` bila perlu, test di `apps/api/src/test/`.
- Jangan: `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`, migrasi (bila butuh skema, berhenti dan lapor), modul pembayaran/refund/pajak, UI.

## Bukti selesai
- Test: user station A tidak bisa baca/ubah data station B (service dan route); user outlet penuh tetap bisa; kontrol positif sebelum tiap penolakan; isolasi tenant; brand kosong dan brand tak dikenal tetap ditolak.
- `LEGEND_TEST_FILES="<file terkait>" pnpm test`, typecheck dan lint lewat `heavy`.
- Commit lokal di `ws/station-scope`, jangan push. Tulis `docs/briefs/152-second-opinion-station-scope.md` di folder proyek (jangan commit): rentang diff, maks 800 baris non-test per run, berkas berisiko, invariant, tanpa temuan review Claude.

## Laporan
SHA awal..akhir, service yang tercakup dan yang sengaja tidak, hasil gate, temuan review K, bead baru.
