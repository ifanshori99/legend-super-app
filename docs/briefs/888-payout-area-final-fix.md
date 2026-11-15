# 888 Perbaikan second opinion akhir area payout (3 P1 + 4 P2)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo dan cabang
`/Users/ifanshori99/Projects/legend super app/legend`, worktree sendiri dari `origin/milestone/m1` (1a1480016). Cabang `fix/payout-area-final-888`. Migrasi baru: rentang sementara 0631-0634. FORCE RLS tanpa FK NOT VALID.

## Tujuan
Tutup semua temuan di `docs/qa/second-opinion-payout-area-final.md` (folder utama repo; baca seluruhnya). Kartu: legend-w5yx6 legend-v6gtp legend-wcd24 legend-8vcsg (associate + in_progress di awal; review + comment saat lapor). Aturan founder: jangan sampai rugi; tiap perbaikan dibuktikan test bahwa tidak ada pihak dibayar lebih tanpa tercatat dan GL cocok dengan uang yang bergerak.

## Keputusan CTO (aturan paling membatasi; jangan ditanyakan ulang)
- Step-up approval/konfirmasi payout: semua route payout yang menyetujui, mengonfirmasi, atau mengubah uang memakai pola yang sama dengan endpoint sumber 883 (`stepUp` + `passwordStepUp`). Faktor MFA yang baru didaftarkan dalam sesi yang sama tidak pernah cukup.
- Transfer ganda yang diketahui belakangan: buat jalur produk (route ber-`requirePermission` + `requireTrustedOrigin` + step-up, dua orang berbeda seperti resolusi failed yang ada, audit) yang memanggil `recordOverpaidItem`; status item dan jurnal (piutang karyawan) tercatat tepat sekali, idempoten. Tidak ada pembayaran otomatis tambahan.
- Utang gaji: akun `salaries_payable` yang dipakai jurnal lock dibekukan pada run/posting; settlement mendebit akun beku itu, tidak pernah mapping terbaru. Baris lama tanpa akun beku: ambil dari jurnal lock yang ada; bila tidak bisa dipastikan, tahan untuk rekonsiliasi dan tampilkan di daftar finance.
- Fingerprint bukti: simpan dan periksa hash byte asli dan byte tersimpan; claim menolak bila salah satunya cocok dengan bukti yang sudah dipakai. Bukti pra-0382: job backfill fingerprint dari objek tersimpan; selama backfill tenant belum selesai, konfirmasi return dengan bukti baru ditolak (fail closed).
- Overpaid saat accounting dimatikan: `lockJournalPending` konsisten dengan consumer (settlement pending lama = lock akan diposting); jurnal overpaid tidak hilang.
- Guard `fee_posted` false→true hanya bila jurnal biaya yang cocok (tenant, key) ada.
- Penutupan laporan sebelumnya yang masih terbuka sebagian: tutup juga.

## Daftar periksa invarian uang (TEAM.md Retro 32)
Cek ulang status dan bukti di dalam kunci; semua state yang mungkin masih tertagih ikut dibekukan; sweep pemulihan terlihat dan adil; tidak ada nilai ditandai selesai tanpa jurnal.

## Pembagian paralel (giliran pertama)
Explore (3): step-up+overpaid route, utang gaji, bukti/guard. test-writer: test gagal-dulu per temuan di m1. implementer per temuan (berkas tumpang tindih `payroll-payout-gl.service.ts`, `payroll-payout-manual.service.ts` berurutan atau per fungsi). Satu test-runner pemegang heavy.

## Bukti selesai
- Test baru merah di 1a1480016, hijau sesudah; ditambah semua berkas payout/GL/registry (`LEGEND_TEST_FILES=... heavy pnpm test`).
- Pra-gate AGENTS.md (prettier, eslint, `pnpm db:generate` kosong, typecheck API; web bila shared berubah).
- Review: satu subagent architect effort xhigh atas diff; temuan nyata dibetulkan.
- Commit + push tanpa force. Lapor sekali saat selesai (tunggu job dengan Monitor di giliran yang sama): cabang, SHA, migrasi, merah→hijau, angka subagent. Jangan merge, jangan deploy.

## Batas kerja ulang (Retro 11)
typecheck gagal 2 kali: baca `~/.claude/state/heavy-fail/<terbaru>` sampai habis, betulkan semua sekaligus. Gagal ketiga: lapor ke CTO. Jangan `pkill`/`killall` proses test, dev server, atau tsc.
