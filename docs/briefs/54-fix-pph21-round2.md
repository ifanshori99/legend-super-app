# Brief: fix PPh 21 putaran 2 + kebijakan pajak per tenant (legend-5cnk, legend-y4wp)

Cabang `ws/payroll-pph21-tests` (HEAD 34a5e2d), worktree `.worktrees/payroll-pph21-tests`. Merge `main` dulu; pastikan `node_modules` bukan symlink.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (file tidak bertumpuk). Uang/pajak: tiap fix butuh test dengan angka referensi dari sumber resmi (cantumkan link di komentar test), dan test yang mengunci perilaku salah (R14, R16, R29, R36) diperbaiki nilainya.

## A. Temuan second-opinion Codex (laporan lengkap: `ghostex read-session-chat S30:P9mkl:G5xe9 --last 1 --format text`)
1. **P1 payroll-pph21.ts:263,270 — skema net: pajak ditanggung tidak masuk bruto.** TK/0, net Rp10.000.000 bulan TER: benar bruto Rp10.230.179, pajak Rp230.179 (engine Rp200.000). Fix: pajak ditanggung = kenikmatan taxable, diselesaikan bersama iterasi gross-up. Sumber: FAQ DJP PMK-66 no. 40.
2. **P1 :274 — refund memakai proporsi net bulan terakhir.** Kelebihan potongan yang dipotong dari pegawai harus kembali penuh ke pegawai (contoh: lebih potong Rp9,5 jt, engine Rp5,7 jt). Jangan inferensikan pembayar historis dari komposisi bulan ini; butuh input riwayat potongan pegawai vs ditanggung.
3. **P1 :190,220 — PTKP K/I pada payroll satu pegawai.** Status pemotongan payroll terpisah dari status SPT gabungan; K/I dinormalisasi konsisten (bulanan dan tahunan) atau ditolak. Contoh: suami K/I/0 gross Rp10 jt/bln → pajak tahunan benar Rp2.775.000 (engine Rp75.000).
4. **P2 :220 — berakhirnya kewajiban pajak subjektif** (PMK 168 Pasal 15(3), Lampiran I.2.2.3): tambah status + rumus penyetahunan dan proporsi, atau guard yang menolak. Contoh resmi: TK/0 Rp17,5 jt Jan–Agu → potongan Rp1,2 jt (engine refund Rp3,5 jt).
5. **P2 :199–201 — surcharge 20% dikalikan sebelum pembulatan akhir** (satu kali pembulatan, BigInt). R14 → Rp53.999.
6. **P2 statutory-tables.ts:202 — aturan pembulatan berversi per periode** (PER-11/PJ/2025 Pasal 129, half-up untuk periode Coretax).
7. Komentar pasal: rekonsiliasi masa terakhir = PMK 168 Pasal 15(1)–(3), bukan 13–14.
8. Residual Rp1 pada campuran gross-up/net: take-home harus tepat.
9. Test tambahan: perpindahan gross↔net dengan histori berbeda, K/I pada rekonsiliasi, berakhirnya kewajiban subjektif, THR+bonus bulan sama, batas TER B/C, lapisan Pasal 17 35%.

## B. Kebijakan pajak per tenant (legend-y4wp, keputusan founder: buat config, default ikut saran CTO, nanti disesuaikan konsultan)
Engine membaca objek kebijakan berversi per tenant, dengan default:
- biaya jabatan pro-rata Rp500 rb × bulan kerja (alternatif: cap penuh);
- tambahan 20% tanpa NPWP di bulan TER dan tahunan (alternatif: hanya tahunan);
- K/I: dinormalisasi ke status pemotongan payroll K/n secara konsisten (alternatif: tolak);
- alokasi pajak skema campuran: proporsional, tanpa menghapus refund potongan pegawai (alternatif: gross dulu);
- mode pembulatan per periode (default sesuai A6).
Simpan kebijakan di tabel config tenant (RLS FORCE, berversi, perubahan diaudit, izin admin payroll). Test per opsi.

## Bukti selesai
Test PPh21 + test kebijakan lulus, `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check` lulus (satu gerbang penuh setelah perubahan terakhir), `git status` bersih, subagent reviewer konteks segar cek diff. Commit lokal merujuk legend-5cnk dan legend-y4wp. Jangan push, jangan merge. Lapor per temuan dan per opsi kebijakan.
