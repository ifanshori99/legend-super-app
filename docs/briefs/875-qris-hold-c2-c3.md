# Brief: engineer — QRIS hold ber-DP lanjutan (legend-yhia9.3 C2, legend-yhia9.4 C3)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree sendiri.

## Langkah 0 (wajib, sebelum kode)
Petakan keadaan: apakah C1 (`legend-yhia9.2`, `fix/qris-hold-strict-amount`, merge fdb878413, perbaikan 1275f0123) sudah ada di `origin/milestone/m1` atau masih di cabang int/antrean (`git merge-base --is-ancestor`, `docs/merge-queue.md`). Base kerja = m1 bila C1 sudah di sana, kalau tidak = ujung cabang C1. Baca `docs/briefs/775-qris-hold-c1.md`, kartu `legend-yhia9`, `legend-y5d2r`, anak-anaknya, dan memori `bd memories founder-q92-q95-13-nov` (keputusan founder sudah disetujui). Bila desain C2/C3 belum tertulis, minta satu subagent `architect` effort xhigh menulisnya dulu ke `docs/design/` sebelum implementer mulai.

## Tujuan
Selesaikan C2 (`applyQrisPaid` + penutupan dengan bukti provider) dan C3 (layar pelanggan: migrasi, pairing, pilihan, state) sesuai arah CTO di kartu: satu intent QRIS aktif per tagihan; selama intent pending DP tidak bisa diubah; QR baru hanya terbit setelah intent lama terbukti batal/kedaluwarsa di gateway. Aturan founder: jangan sampai rugi. Test wajib membuktikan pelanggan tidak bisa bayar lebih dan outlet tidak kurang terima.

## Kartu
`legend-yhia9.3`, `legend-yhia9.4` (dan tutup `legend-yhia9.2` bila terbukti di m1 — lapor saja, CTO yang menutup). Status in_progress di awal, review saat lapor, beri komentar.

## Scope
- Boleh: service/route pembayaran QRIS, hold, layar pelanggan (API), test API, kontrak shared, migrasi.
- Jangan: UI web di luar kontrak (UI layar pelanggan menyusul gerbang founder), modul payout/HRIS.
- Migrasi: rentang sementara `0615-0619` (merge train menomori ulang). Tanpa `NOT VALID` pada FK tabel FORCE RLS.

## Pembagian paralel
Explore (2-3) per C2/C3, test-writer test gagal-dulu, implementer satu per kartu, satu test-runner pemegang heavy, review architect xhigh atas diff.

## Bukti selesai
Test merah di base lalu hijau (`LEGEND_TEST_FILES=... heavy pnpm test`), pra-gate AGENTS.md, typecheck API (dan web bila shared berubah). Commit, push tanpa force, jangan merge. Lapor sekali di akhir (jangan akhiri giliran untuk kabar antara): cabang, SHA, migrasi, merah→hijau, angka subagent.
