# Brief 120: engineer — tolak transaksi POS pada hari usaha yang sudah ditutup (legend-mf0.1, POS-05)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.
Tingkat K (uang dan sinkron offline): `reviewer` Opus dan `architect` bersamaan sebelum melapor.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
Buat worktree sendiri: `git worktree add .worktrees/pos-closed-day -b ws/pos-closed-day milestone/m1`. Jangan pakai `--worktree` Ghostex.

## Tujuan
Setelah Tutup Hari, rekap yang dibekukan selalu sama dengan data POS: tidak ada pesanan, pembayaran, refund, atau void baru yang tercatat pada hari usaha yang sudah ditutup.

## Kartu
`legend-mf0.1`. Di awal: `ghostex board associate legend-mf0.1` dan `bd update legend-mf0.1 --status in_progress`. Saat melapor: `bd update legend-mf0.1 --status review` dan `bd comment legend-mf0.1 "<ringkasan bahasa biasa>"`.

## Masukan
- `bd show legend-mf0.1`: deskripsi dan keputusan CTO 2026-11-08 (wajib diikuti):
  - Tulisan POS online yang bertanggal hari usaha tertutup ditolak dengan `BUSINESS_DAY_ALREADY_CLOSED`.
  - Pesanan offline dari edge yang dibuat sebelum tutup tetapi tersinkron sesudahnya diterima, tidak pernah mengubah rekap beku, dan dicatat sebagai penyesuaian terlambat bertanda ke hari usaha berikut yang masih buka, dengan audit dan notifikasi manajer.
- Pola kunci: advisory lock `pos-shift-open:<tenant>:<outlet>` (hashtextextended) seperti `pos-shift.service` dan `pos-day.service`, atau baca `pos_daily_closes FOR SHARE`.
- PRD: POS-05.

## Scope
- Boleh diubah: layanan POS order, tender/payment capture, refund, dan void; jalur penerapan sinkron pesanan dari edge; test di `apps/api/src/test/`; migrasi baru bila perlu (penanda penyesuaian terlambat).
- Sentuh seminimal mungkin `refundPosOrder` dan `crm-promo-refund.ts`: cabang `ws/refund-promo` sedang mengubah keduanya. Tambahkan pemeriksaan hari tertutup di awal saja, jangan ubah logika perhitungannya.
- Jangan disentuh: adapter DOIT dan `payment-refund.service.ts` alur payout (cabang `ws/doit-refund` menunggu merge), `inventory.service.ts` dan limiter edge (cabang `ws/fix-edge-codex`).

## Bukti selesai
- Test baru: create, submit, tender, refund, void pada hari tertutup ditolak; pesanan edge terlambat masuk ke hari berikut dengan tanda, audit, dan notifikasi; rekap beku tidak berubah; balapan Tutup Hari vs pembayaran (pakai `pg_locks`, bukan sleep).
- `LEGEND_TEST_FILES="<file test baru dan yang terdampak>" pnpm test` dari root worktree.
- Lint dan typecheck paket yang berubah lewat `heavy`. `pnpm db:generate` kosong atau migrasi baru tercatat.

## Sebelum melapor
Commit lokal di `ws/pos-closed-day`, hanya file dalam scope. Jangan push. Tulis juga brief second-opinion Codex di `docs/briefs/121-second-opinion-pos-closed-day.md` (folder proyek, jangan commit): rentang diff non-test maks 800 baris per run, berkas berisiko, invariant dari PRD. Jangan sebut temuan review Claude.

## Laporan
SHA awal..akhir, migrasi (nomor), hasil gate, temuan review K, file berubah, bead baru, risiko tersisa.
