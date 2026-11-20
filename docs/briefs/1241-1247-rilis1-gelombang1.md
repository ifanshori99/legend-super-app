# 1241-1247 Rilis 1 gelombang 1: penutup bead BLOK (21 Nov)

Sumber: verifikasi 1240 (`docs/qa/triase-rilis1-2026-11-20.md`). Base semua kartu: `milestone/m1` (6f418df53). Setup: `command git worktree add "/Users/ifanshori99/Projects/legend super app/legend-<kartu>" -b ws/<kartu>-<slug> milestone/m1`, lalu di worktree `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Path berisi spasi: kutip. `command git`.

Prinsip: jangan sampai rugi; ragu = aturan yang membatasi pembayaran, catat keputusan di commit dan laporan. Baca `bd show <id>` dulu. Fail-first test wajib (merah di m1, hijau sesudah). Migrasi baru: nomor berikut sesudah migrasi terakhir di m1 (0522); kartu berbeda bisa bentrok nomor, merge train akan renumber. `heavy pnpm db:generate` harus "No schema changes". Ubah `scripts/*.mjs` runner -> jalankan `tests/test-runner-selection.test.mjs`.

Bukti selesai: `LEGEND_TEST_FILES="src/test/a.test.ts ..." heavy pnpm test` (test baru + test area), prettier --check + eslint berkas berubah, `heavy pnpm --filter @starter/api typecheck` (plus web bila shared/web berubah), teks UI baru: `node --test tests/text-contract.test.mjs`. Commit per langkah (akhiri `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`), push cabang. Budget 60 tool call; di 50 commit + lapor. Laporan: SHA, merah->hijau, keputusan, yang belum.

## 1241 legend-arj.5 angka settlement karyawan keluar (Opus)
`apps/api/src/services/hris-settlement.service.ts:47-53,:265` masih `PENDING_PAYROLL_ENGINE` untuk prorated_salary, thr, bpjs, leave_cash_out, net_payout. Hitung memakai engine payroll yang sudah ada (statutory calc, PPh21 TER/final period, THR, loan deductions). Konsisten dengan keputusan 1220 (gaji akhir dikeluarkan dari run dan dilaporkan, tidak dibayar otomatis): settlement menghitung dan menampilkan angka, pembayaran tetap manual/approval. Test: prorata hari kerja, THR proporsional, kasbon dipotong, tidak ada pembayaran ganda dengan run reguler periode sama.

## 1242 legend-tomda receipt biaya 0 ke stok negatif (Opus)
`inventory.service.ts:1203-1235`, `packages/shared/src/inventory/schemas.ts:460-463`. Receipt biaya 0 (bonus/gratis supplier) ke stok negatif menurunkan HPP -> laba naik -> bagi hasil dibayar lebih. Desain restriktif: receipt biaya 0 butuh flag eksplisit (mis. `isBonus`) dan revaluasi negatif memakai avg lama (bukan 0); tanpa flag ditolak 422 untuk qty>0 biaya 0. Ikuti pola revaluasi 1214/1232.

## 1243 legend-xhl5j promo refund + diskon manual (Sonnet)
`crm-promo-refund.ts:663,:721`: uncovered amount belum menghitung diskon manual yang ditumpuk dengan promo; voucher bisa kembali padahal tamu menyimpan diskon. Test kasus diskon manual + promo, refund parsial dan penuh. Konsisten dengan 1219.

## 1244 legend-ecr16 rekonsiliasi refund edge lama (Opus)
Refund dari edge yang belum tersinkron ke pusat bisa melewati batas kumulatif refund (`docs/release-notes-pos-refund-ceilings.md`, `test/pos-refund-ceilings.test.ts`). Saat ingest refund edge, hitung batas kumulatif terhadap semua refund (pusat + edge) dan tahan (hold untuk review) yang melewati, bukan menolak data kasir. Test.

## 1245 legend-gdjpu ACK void edge mendahului ingest (Opus)
SO 1111 P2: ACK void edge bisa terkirim sebelum ingest sukses -> edge mengira void tercatat. ACK hanya sesudah commit ingest; ingest gagal -> retry/outbox tetap. Cari doc SO 1111 di `docs/qa/`. Test.

## 1246 Sizing architect: legend-k0i8, legend-x73li (+qlirp, ay6e6, y3huu), legend-tvkuz, legend-0orff (architect, read-only)
Kode di `/Users/ifanshori99/Projects/legend super app/legend-m1-read`. Per bead: apa yang sudah ada, apa yang kurang untuk rilis tahap 1 Cafe Legend (satu tenant, edge outlet, gateway via env), apakah benar BLOK atau bisa SESUDAH, dan pecahan kartu S/M (file, test, urutan, butuh mockup/review founder atau tidak). Tulis `docs/qa/sizing-1246.md` di checkout utama, commit berkas itu saja.

## 1247 Verifikasi sisa kecil (Explore, read-only)
Di `legend-m1-read`: (a) legend-j2l2 anak 8di9d, sko14, pf9u7; (b) legend-07eg anak s5c1 + payslip PDF; (c) legend-905j konsumen jurnal points.*, distribution.paid, depresiasi; (d) legend-316 test approval pembayaran supplier; (e) legend-j7018 test bayar mundur ke periode tutup; (f) legend-29vw konsumen jurnal stock.moved (COGS/produksi/waste/penyesuaian) di `inventory-gl-consumer.ts`. Per butir: SELESAI (file:baris + test) / KURANG (apa). Lapor tabel.
