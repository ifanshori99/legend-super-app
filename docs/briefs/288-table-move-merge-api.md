# Brief: engineer (Sonnet) — WS-03 operasi meja: pindah, gabung, pindah item

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/table-move-merge` dari `milestone/m1` (d2080951). Worktree `.worktrees/table-move-merge`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Migrasi hanya bila perlu: pakai nomor sesudah ujung journal di m1 dengan `when` lebih besar dari semua yang ada, tulis di laporan.

## Tujuan
`legend-685n` (P2, tingkat K: tagihan pelanggan berpindah). Sudah ada di m1 (legend-irw): GET floor, CRUD floor, POST status meja (ORD-10), confirm/close sesi meja. Kontrak ada di `packages/shared/src/qr-order/table-operations.ts` (`moveTableSession`, `mergeTableSessions`, `moveSessionItems`), dirujuk `apps/api/src/middleware/public-rate-limit.ts` sekitar :34, :208, tapi belum ada service dan route. Kerjakan:
1. Service + route `POST /api/table-sessions/:sessionId/move`, `.../merge`, `.../move-items`, di bawah `requireAuth`, `requireTrustedOrigin`, `requirePermission`, filter tenant dan outlet di SQL.
2. Aturan: meja tujuan harus kosong atau sesuai aturan kontrak; tidak boleh untuk sesi tertutup atau sudah dibayar penuh; pembayaran sebagian dan diskon tetap benar sesudah gabung atau pindah item; total tagihan sebelum dan sesudah sama; idempoten untuk permintaan ulang.
3. Event `table_session.moved`, `table_session.merged`, `table_session.items_moved` di `events/catalog.ts` baris WS-03, plus entri audit. Mode `link` meja dan `table.status_changed` tetap milik `legend-1nmh`; jangan dikerjakan.
Perilaku acuan: `apps/web/src/features/ws03-floor/mock.ts`.

## Kartu
Awal: `ghostex board associate legend-685n`, `bd update legend-685n --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: service dan route table-session di `apps/api`, `packages/shared/src/qr-order/*` dan `events/catalog.ts` bila kontrak perlu dilengkapi, tes. Jangan: UI web, mode link (legend-1nmh), pembayaran dan refund, KDS.

## Bukti selesai
- Tes gagal-dulu: pindah, gabung, pindah item mengubah sesi dengan benar dan total tagihan tetap; sesi tertutup atau sudah dibayar ditolak; tenant atau outlet lain ditolak; peran tanpa izin ditolak; permintaan ulang tidak menggandakan; event dan audit tertulis sekali.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes. Contract root bila `packages/shared` berubah.
- `tsc` api dan shared lewat `heavy` sekali; eslint + prettier.
- Review (tingkat K): satu `architect`.

## Laporan
Sekali di akhir: SHA, migrasi (ada/tidak), bukti, file berubah, kontrak untuk UI, risiko, jumlah subagent dan puncak bersamaan.
