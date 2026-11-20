# 1240 Verifikasi kriteria bead BLOK rilis 1 per area (21 Nov) — Explore read-only

Kode: `/Users/ifanshori99/Projects/legend super app/legend-m1-read` (detached di milestone/m1 6f418df53, semua kerja sampai batch105). Jangan edit, jangan ubah bead. Konteks triase: `docs/qa/triase-rilis1-2026-11-20.md` di checkout utama.

Per bead: `bd show <id>` (dari checkout utama `/Users/ifanshori99/Projects/legend super app/legend`), pecah kriteria jadi butir, lalu per butir cari kode (service/route/migrasi) DAN test yang membuktikannya. Putusan per bead: SELESAI (semua butir terbukti: sebut file:baris + nama test), SEBAGIAN (butir mana kurang, perkiraan ukuran S/M/L), BELUM. Butir di luar scope rilis 1 (GoFood/Grab/Shopee, EDC bank, refund DOIT, email) tandai LUAR-SCOPE.

Area:
- A HRIS/payroll: legend-j2l2, legend-07eg, legend-arj.5, legend-l3bq, legend-905j, legend-t1ufu, legend-wxvt9
- B inventori/akuntansi/pembelian: legend-29vw, legend-316, legend-tomda, legend-j7018, legend-w8cwg
- C pembayaran/refund/edge: legend-3tyl1, legend-ecr16, legend-xhl5j, legend-gdjpu, legend-k0i8, legend-1yig6, legend-astv2, legend-7tqe8
- D web/FE: legend-x73li, legend-tvkuz, legend-0orff, legend-du7t5, legend-94xqo

Lapor tabel: id | putusan | butir kurang (bila ada) + ukuran | bukti 1 baris. Maks 30 tool call.
