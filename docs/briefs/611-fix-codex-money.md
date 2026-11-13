# Brief: engineer — perbaikan temuan Codex area uang (QRIS DP + jurnal)

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `ws/payment-link-cancel` (1f0247da; berisi ws/qris-dp-hold). Langkah awal: `git merge --no-ff origin/fix/money-journal-refund` (c660fd6b). Konflik isi: lapor CTO. Push ke `origin` sebagai `fix/codex-money`.

## Kartu (keputusan sudah diambil CTO; jangan ditanyakan)
1. `legend-eh9i4`:
   - P1 `apps/api/src/services/payment.service.ts:2611`: polling/status check melewati cek hold. Contoh: QR Rp33.000, webhook hilang, status paid Rp36.000 -> sekarang capture 33.000 + parkir 3.000. Benar: seluruh Rp36.000 diparkir (QH-13: nominal salah tidak menutup hold). Pindahkan cek hold ke jalur settlement bersama (webhook dan polling) di bawah lock yang sama.
   - P1 `apps/api/drizzle/0419_pos_qris_holds.sql:93`: backfill hanya tender POS. Tambah backfill intent QRIS tamu (split) dan gagalkan migrasi bila ditemukan >1 QR collectible per tagihan. Migrasi 0419 belum di m1: boleh diedit, jangan nomor baru.
2. `legend-5i6k1`: P1 `apps/api/src/services/accounting-journal.service.ts:620`: perlindungan akun pajak/service charge harus memakai gabungan peta akun saat ini DAN historis. Contoh: penjualan pajak ke akun A, lalu mapping PBJT dan customer_deposit ke B -> refundGateway Rp100.000 saat ini lolos mengkredit akun pajak B; harus diparkir `ACCOUNT_MAPPING_MISSING`.

`bd update <id> --status in_progress` di awal; lapor `--status review` + `bd comment`.

## Aturan uang (founder)
Test gagal-dulu dengan skenario Codex di atas. Buktikan tidak ada pihak dibayar lebih, outlet tidak rugi, uang diparkir tepat sekali.

## Pembagian paralel
test-writer (3 test gagal-dulu), implementer 3 (payment.service settlement; migrasi 0419 backfill; accounting-journal), satu `architect` effort xhigh atas diff akhir, satu `test-runner` pemegang heavy.

## Bukti selesai
Gagal-dulu lalu hijau via `heavy env LEGEND_TEST_FILES="..." pnpm test` (test baru + test QRIS hold/jurnal/payment-link-cancel terkait); typecheck api via `heavy`; `db:generate` kosong; prettier + eslint.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
