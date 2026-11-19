# 1113 Perbaikan SO akses 1094 (tingkat K akses/uang)
Peran: engineer (`~/.agents/team/roles/engineer.md`). Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (satu implementer per temuan, file tidak bertumpuk).
Cabang `ws/1094-akses-perangkat-bersama-sisa` (head 4f5e3cc08), worktree `legend-21375132`. Laporan SO: `docs/qa/second-opinion-akses-1094-1112.md` (lokasi, skenario, usul test). Push tanpa `--force`. Tanpa migrasi.

## Keputusan CTO (membatasi)
1. P1: di tablet bersama, pembuatan isu pesanan TIDAK boleh mencatat refund manual (selesai atau tidak) maupun resolusi uang apa pun; tutup di allowlist/guard yang sama dengan `resolve manual_refund` (403 `SHARED_DEVICE_SCREEN_CLOSED`) untuk semua jenis resolusi yang mengeluarkan uang. Isu tanpa uang (laporan saja) tetap boleh. Perangkat pribadi tidak berubah.
2. P2 availability: GET availability memakai batas outlet token kasir yang sama (`actorOf`/outlet path vs token), outlet lain 403 `ACTING_STAFF_OUTLET_MISMATCH`.
3. P2 socket panic: saat shared mode dinyalakan, socket panic lama diputus/ditolak sesuai usul SO.

## Bukti
Per temuan: test merah di 4f5e3cc08, hijau di head (test terarah lewat `heavy`, daftar berkas eksplisit). Regresi 12 berkas 1094. Typecheck API sekali (heap 8 GB bila OOM). Prettier/eslint. Architect xhigh review delta sekali.

## Laporan
Per temuan: commit, head SHA (push), risiko. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
