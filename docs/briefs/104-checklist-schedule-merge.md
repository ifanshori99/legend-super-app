# Brief 104: jadwal checklist per shift masuk m1 (legend-5v69, board B11)

Peran: engineer. Baca `~/.agents/team/roles/engineer.md` dan `docs/briefs/_TEMPLATE-workstream.md`.

## Keadaan
- `ws/checklist-engine` di `e3ac2efb` (jadwal checklist per shift dan per role, F45 OPS-01) belum masuk `milestone/m1`.
- Eksekusi checklist, eskalasi, dan food-safety sudah ada di m1 lewat operations: `f9291385`, `16e4f457`, `36a82eba`.

Masalah yang tercatat di board B11:
1. Migration bernomor 0063 bentrok. Regen di atas m1 terbaru.
2. Template rusak.
3. Konfirmasi menjawab 422 untuk `roleId`.

Rincian: grep "checklist" dan "B11" di `docs/PROGRESS.md`.

## Tugas
- Port isi `e3ac2efb` ke cabang baru `ws/checklist-schedule` dari m1 terbaru, di worktree `.worktrees/checklist-schedule`.
- Selaraskan dengan eksekusi checklist yang sudah ada di m1. Jangan menduplikasi tabel atau route.
- Perbaiki 3 masalah di atas, masing-masing dengan test merah lebih dulu.
- Review oleh reviewer Sonnet; tingkat S kecuali menyentuh RLS (tingkat K).
- Gate sekali lewat `heavy`.
- Commit lokal, lalu handoff ke merge train.
