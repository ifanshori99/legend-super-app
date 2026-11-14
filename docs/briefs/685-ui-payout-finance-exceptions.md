# Brief: ui-engineer — layar pencairan gaji dan pengecualian finance

## Peran
Baca `~/.agents/team/roles/ui-engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep, Read offset/limit), lalu ikuti. UI ikut `~/.agents/team/ui-standard.md`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `ws/finance-exceptions` (API pengecualian + payout ada di sana). Cabang akhir `ui/payout-finance-exceptions`.

## Tujuan
Founder menyetujui mockup (W6 Q1): cabang `design/payout-finance` fc6848ff9, `design/mockups/payout/review.html` dan `design/mockups/finance-exceptions/review.html`. Bangun keduanya tersambung API nyata:
1. Pencairan gaji (legend-wnkep.6, legend-wnkep.7; isi kartu di `docs/briefs/669-cards.txt`): empat tab run/persetujuan/status/pengaturan, persetujuan dua orang, status per karyawan, rekening sumber nonaktif ditolak, Duitku belum aktif. Gaji diterima dipisah dari biaya PT.
2. Pengecualian finance (legend-4oclu): `GET /api/accounting/finance-exceptions`, lima jenis, filter outlet/tanggal, nilai tidak diketahui = "Tidak tersedia", tabel jadi kartu di mobile.
Tombol uang tidak boleh aktif hanya karena UI: server tetap pemeriksa. Thread lain (brief 680) sedang mengubah service payout di cabang `ws/payroll-payout-so-fixes`: jangan ubah service API; bila butuh field baru, laporkan ke CTO.

## Kartu
`legend-wnkep.6`, `legend-wnkep.7`, `legend-4oclu` (bagian UI). Aturan kartu: `~/.agents/team/brief-template.md`. Teks UI didaftarkan ke katalog.

## Pembagian paralel
Explore (2): API payout; API finance-exceptions. implementer: payout tabs, persetujuan+status, pengecualian finance (file terpisah). ui-auditor sebelum lapor. Heavy: satu test-runner.

## Bukti selesai
Screenshot tiap state 1280 dan 390 di `docs/screenshots/payout-finance/`, test web hijau, pra-gate AGENTS.md (typecheck web + api lewat heavy).

## Sebelum melapor
Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Jangan merge, jangan deploy.
