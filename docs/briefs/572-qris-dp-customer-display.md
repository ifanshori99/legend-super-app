# Brief: engineer (Codex) — QRIS pesanan ber-DP = sisa tagihan (legend-y5d2r)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit).

## Kartu
`bd show legend-y5d2r` (status review: cek dulu `git log --all --grep=y5d2r` apakah kontrak sudah ada di cabang lain). Masalah: skema layar pelanggan memaksa jumlah QRIS = total tagihan; pesanan ber-DP bisa ditagih lebih. UI kasir (sekarang di milestone/m1 ab574d58, dari ui/pos-extra) menahan QRIS untuk pesanan ber-DP (founder Q68).

## Tujuan
1. Kontrak shared: `depositAppliedIdr` dan `amountDue = total - DP` di skema layar pelanggan; zod ketat, `amountDue` tidak pernah negatif atau > total.
2. Backend layar pelanggan: jumlah QRIS dihitung server dari DP yang benar-benar teralokasi (DP draft = 0, aturan alokasi saat submit sudah ada di m1). Nilai dari klien tidak dipercaya.
3. UI: buka penahanan QRIS ber-DP. Bila DP dipasang saat QR sudah tampil: QR lama dibatalkan dan dibuat ulang dengan jumlah baru (jendela ~5 detik di komentar kartu), jangan sampai dua QR aktif.

## Uang — wajib (Jangan sampai rugi)
Test gagal-dulu yang membuktikan: pelanggan tidak ditagih lebih dari sisa; outlet tidak menerima kurang dari sisa; DP yang dipasang setelah QR tampil tidak membuat total bayar > tagihan; dua intent QRIS untuk pesanan yang sama tidak bisa sama-sama lunas melebihi tagihan. Ragu soal aturan: pilih yang membatasi pembayaran, lapor ke CTO.

## Repo
Worktree dari Ghostex basis `milestone/m1` (ab574d58). Cabang `ws/qris-dp-due`. Commit lokal, push cabang boleh. Tanpa migrasi bila bisa; bila perlu, pakai nomor 0410 ke atas.

## Bukti selesai
- Test terarah lulus (`LEGEND_TEST_FILES=... heavy pnpm test`), typecheck web+api, satu screenshot layar pelanggan ber-DP (`ghostex visual check`).
- Satu subagent architect effort xhigh (uang) mereview diff; temuan nyata dibetulkan.
- Jangan jalankan `pnpm check` penuh; jangan sentuh milestone/m1 atau main; jangan deploy.
