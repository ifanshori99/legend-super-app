# Brief: engineer — dedupe kasus rekonsiliasi termasuk yang sudah selesai

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `ws/payment-approvals` (d16dfb45b). Cabang akhir: `ws/payment-approvals-dedupe` (menggantikan ws/payment-approvals di batch63).

## Tujuan
Temuan second-opinion Codex P2 (keputusan CTO: perbaiki): `apps/api/src/services/payment-settlement-import.service.ts:460` deduplikasi kasus mengabaikan kasus `resolved`. Setelah selisih gateway disetujui, laporan settlement berreferensi berbeda untuk periode sama yang tetap tidak memuat transaksi itu membuat kasus kedua, yang bisa disetujui dan menghasilkan event resolusi kedua (hapus buku ganda). Perbaikan: dedupe permanen per ID transaksi/penjualan untuk semua status kasus (open, pending_approval, resolved), idempoten saat konkuren. Kasus yang ditutup lalu muncul selisih BARU (nominal berbeda) tetap boleh: tulis aturan paling membatasi yang kamu pakai di laporan.

Kedua (founder W8 Q10/Q12, 14 Nov): penyetuju bawaan penutupan kasus rekonsiliasi = Owner ATAU Finance Manager, satu tingkat, salah satu cukup (bukan Owner saja). Ubah seed di migrasi 0565 (belum diterapkan di mana pun, boleh diubah di cabang ini) dan `DEFAULT_RECONCILIATION_CASE_APPROVAL_POLICIES` di `packages/shared/src/access/approval.ts`, plus `access.service.ts` untuk tenant baru. Test: FM bisa menyetujui, pengaju tetap tidak bisa menyetujui sendiri. Typecheck web juga (shared berubah).

## Kartu
Buat kartu bd (discovered-from legend-hcqs), aturan kartu di `~/.agents/team/brief-template.md`.

## Aturan uang
Tingkat K. Test gagal-dulu: impor ulang setelah approval tidak membuat kasus kedua; dua impor konkuren tidak membuat kasus ganda; tidak ada event resolusi kedua. Satu subagent `architect` effort xhigh sebelum lapor.

## Scope
Hanya `payment-settlement-import.service.ts`, service rekonsiliasi terkait, dan test-nya. Migrasi (bila butuh index unik): nomor `0574` saja, lalu `node ~/.agents/team/check-journal.mjs origin/milestone/m1`.

## Bukti, sebelum melapor
Test terarah hijau lewat `heavy`, pra-gate AGENTS.md. Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Jangan merge, jangan deploy.
