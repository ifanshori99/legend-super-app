# Brief: engineer — perbaikan KDS dari second-opinion architect (ws/kds)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/contracts.md`.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/kds`, cabang `ws/kds` (4a1f613). Pertama `git merge --no-ff main` (main = 1f0b6d2, sudah berisi db-role, fiscal, edge-hardening, pos-payment-fixes, UI kasir); renumber migration bentrok lewat drizzle-kit (HANDOFF §5), jangan edit `_journal.json` tangan. Jangan pkill proses test global.

## Temuan yang wajib dibetulkan (architect, 2026-11-08)
1. Sedang — `kds-realtime.ts:222`, `kds.service.ts:1283`: `after` dari klien dipercaya. Bila `after` > `snapshot.sequence`: tolak / kirim frame "resync required"; sama di HTTP `/feed`.
2. Sedang — `kds.service.ts:1275-1288`: baca dari cursor lama tanpa batas. Bila `after` terlalu jauh di belakang (jumlah sequence atau umur), paksa resync ke snapshot; tambah pemangkasan baris feed lama.
3. Sedang — keputusan CTO: penjualan TIDAK BOLEH gagal karena outlet tidak punya stasiun KDS untuk tipe item. Tanpa stasiun: lewati tiket KDS (catat audit/peringatan), POS fire tetap sukses. Test.
4. Sedang — `menu.service.ts:1137-1183`: `stationId: null` juga membersihkan `stationType` bila tipe tidak dikirim.
5. Rendah — cek izin stasiun sebelum lock order dan baca tiket (`kds.service.ts:742-758`, `968-999`).
6. Rendah — gabungkan wakeup realtime per socket (`kds-realtime.ts:169-183`).
7. Rendah — bump/recall/void tiket mencatat perubahan status per item; recall reset `readyAt`.
8. Test tambahan: dua transisi bersamaan, paging `hasMore`, penulis bersamaan feed tetap tanpa celah.

## Bukti selesai
- Test tiap butir; `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus (satu gerbang penuh setelah perubahan terakhir). `git status` bersih. Reviewer subagent konteks segar cek diff.

## Laporan
Per butir: perubahan dan test; migration yang di-renumber; bukti gerbang; commit; risiko tersisa.
