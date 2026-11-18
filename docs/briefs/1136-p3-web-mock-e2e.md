# 1136 Bundel P3 web mock/e2e/teks (tingkat S)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Ikuti `docs/briefs/_TEMPLATE-workstream.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore per kartu, implementer per kartu, berkas terpisah).
Cabang `ws/1136-p3-web-mock-e2e` dari `origin/milestone/m1` (worktree dari Ghostex). Push tanpa `--force`. Tanpa migrasi, tanpa uang/akses.

Kartu (`bd show <id>` dulu; cek prasyarat ada di m1; klaim `bd update <id> --claim`; tutup `bd close` bila selesai):
1. `legend-5vcqk`: `apps/web/src/features/ws04-expo/mock.ts` tambah handler `markPickupPickedUp` dan `markExpoOrderDelivered`.
2. `legend-46vt`: mock `?mock=claim-login` untuk `/t/<token>/bill` + spec e2e mencakup CTA claim-card dan consent-form (bukan hanya checkout).
3. `legend-eukn`: FE tutup periode menampilkan `periodStatus` dan `periodVersion` dari snapshot (API sudah ada di m1, `accounting-period-close.service.ts:485`; mock `:644`).
4. `legend-yf2b`: `apps/web/src/features/ws11-report-builder/mock-preview.ts` dukung metrik selain sales. Cek dulu duplikat dengan `legend-x73li`; bila sudah tercakup, tutup dengan komentar.
5. `legend-z274`: kategori checklist sendiri di kontrak + preferensi notifikasi (sekarang dipetakan ke `schedule_update`). Cek dulu bentrok dengan `origin/ws/1120-akses-outlet-order-recovery` (`notification-realtime.ts`); bila bertumpuk, lewati dan lapor.

Teks UI baru: daftarkan ke katalog (`node --test tests/text-contract.test.mjs`). Jangan sentuh `design-system/v2/sample.ts` (ws/1123).
Bukti: test gagal-dulu per kartu (unit/vitest web; e2e hanya untuk 46vt, sekali di akhir lewat `heavy`). Prettier, eslint. Typecheck web (dan API bila shared berubah) sekali lewat `heavy`. `reviewer` sonnet sekali.
Laporan: head SHA, kartu selesai/dilewati, risiko. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
