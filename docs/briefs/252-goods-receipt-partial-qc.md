# Brief: engineer (Opus) — goods receipt parsial + QC + foto, stok bertambah sebesar qty diterima (legend-o1o4s)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/goods-receipt-partial-qc` dari `milestone/m1` terbaru (d8ea5e0b atau lebih baru). Worktree `.worktrees/goods-receipt-partial-qc`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-o1o4s` (P2, K: migrasi + stok/uang, desain baru → Opus). Baca `bd show legend-o1o4s`, induk `legend-316` (+ komentar triase), `legend-0una` (foto), dan PRD INV-05 / bagian purchasing. Langkah 1: dua `Explore` paralel memetakan PO, supplier, stok ledger, dan pola storage foto yang sudah ada.
- Skema receiving (header + baris): qty dipesan vs diterima vs ditolak QC, alasan QC, foto (ref `core_storage_objects` milik tenant), status PO parsial/lengkap.
- Stok bertambah HANYA sebesar qty diterima lolos QC, lewat ledger stok yang sudah ada, idempoten (posting ulang tidak menggandakan).
- Kontrak zod di `packages/shared` (belum ada).

## Kartu
Di awal: `bd update legend-o1o4s --status in_progress`. Saat melapor: `--status review` + `bd comment`. Sisa kerja (invoice supplier, 3-way match, retur): kartu baru `-l ws-06`.

## Scope
Boleh: `db/schema/inventory-receiving.ts`, satu migrasi, `services/inventory-receiving.service.ts`, `routes/inventory-receiving.routes.ts`, kontrak shared purchasing/receiving, test. Jangan: izin inventori (`inventory.item.manage`, cabang lain), invoice/pembayaran supplier, akuntansi jurnal (buat kartu bila perlu), UI.
Migrasi: 0173, `when` 1794252000000, prevId ke snapshot terakhir di basismu (merge train rechain). Satu berkas.

## Bukti selesai
- Test: isolasi tenant/outlet (RLS), terima parsial dua kali sampai lengkap, QC tolak tidak menambah stok, posting ulang idempoten, terima paralel tidak melewati qty PO, foto tenant lain ditolak, izin route.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sertakan `src/test/edge-received-events-migration.test.ts`, `src/test/migration-fk-force-rls.test.ts`, `src/test/migration-force-rls-guard.test.ts`; generate drizzle harus kosong.
- Typecheck via `heavy` sekali per perbaikan, eslint, prettier. Jangan `pnpm check` penuh.
- Review (Q48): satu subagent `architect`. Maks 3 subagent bersamaan; test-writer hanya menjalankan file yang ia tulis.
- Brief Codex `docs/briefs/252b-second-opinion-goods-receipt.md` (tidak di-commit).

## Laporan
Sekali: tabel dan endpoint, bukti, file berubah, SHA, nomor migrasi, kartu sisa, risiko, jumlah subagent.
