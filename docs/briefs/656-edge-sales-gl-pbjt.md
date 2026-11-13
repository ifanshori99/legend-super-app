# Brief: engineer — jurnal GL, PBJT, dan poin untuk penjualan edge (legend-uctlr + 132mw + vje21)

Peran: baca `~/.agents/team/roles/engineer.md`. Model Sonnet. Area uang dan pajak: "jangan sampai rugi".

## Konteks
`ws/edge-order-ingest` (c72bddf73, legend-771dl) memasukkan order/void kasir edge ke tabel order cloud, tetapi tanpa jurnal, PBJT, dan poin. Net sales, avg ticket, dan target membaca GL, jadi penjualan edge belum masuk. Keputusan CTO 14 Nov (komentar di bead): GL dan PBJT wajib sama seperti penjualan cloud; poin diberi saat ingest bila ada customer, idempoten per order, tanpa penukaran offline; void/refund order edge dari cloud tetap diblok (void dilakukan di kasir edge); void lama tanpa id aktor diblok sampai rekonsiliasi manual.

## Repo
Worktree dari `origin/ws/edge-order-ingest`: `git worktree add .worktrees/edge-gl-656 -b ws/edge-sales-gl origin/ws/edge-order-ingest`, `pnpm worktree:setup`. Migrasi rentang **0526-0529**.

## Kartu (paralel bila file terpisah)
1. `legend-uctlr`: jurnal penjualan + PBJT untuk order edge hasil ingest, memakai jalur posting yang sama dengan penjualan cloud (cari service posting order POS). Void edge membalik jurnal tepat sekali. Poin loyalty earn saat ingest bila ada customer.
2. `legend-132mw`: re-drive refusal transien (`lock_failed`, `db_error`) lewat sweep; `isTransientReason` hanya 40P01, 55P03, 40001; test `lock_failed`.
3. `legend-vje21`: pesan 409 `EDGE_ORDER_CORRECTION_BLOCKED` yang jelas untuk kasir/finance (teks UI didaftarkan ke katalog).

## Test gagal-dulu
Total jurnal penjualan edge = total order edge (tidak ada selisih), PBJT sama dengan perhitungan cloud untuk order yang sama, replay/urutan acak tidak menggandakan jurnal atau poin, void membalik tepat sekali, tenant lain tidak tersentuh.

## Review
Tingkat K: satu subagent `architect` effort xhigh, maks 2 ronde. Keputusan bisnis baru: tulis di laporan, jangan tebak.

## Bukti selesai
Test terarah lewat `heavy`, typecheck api (+ web bila tersentuh) sekali lewat `heavy`, prettier + eslint, text-contract, `db:generate` kosong, registry migrasi. Push tanpa force.

## Batas
Jangan merge, deploy, `pkill`, `pnpm test` penuh. Maks 4 subagent bersamaan.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
