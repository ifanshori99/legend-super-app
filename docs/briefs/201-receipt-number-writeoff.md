# Brief: engineer — write-off nomor struk hilang yang teraudit (legend-0hzqw)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/receipt-number-writeoff` dari `ws/day-close-all-gaps` 57e92b6d (legend-6b0ld, antre merge train sesudah ws/receipt-gaps-prefix). Worktree `.worktrees/receipt-number-writeoff`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-0hzqw` (P1 release-gate, tingkat K: nomor dokumen dan migrasi). Sejak 6b0ld, satu nomor hilang di run mana pun (perangkat dicabut, run pensiun, urutan cloud C) menahan setiap Tutup Hari outlet itu dan tidak ada jalan keluar. Keputusan CTO:
- Hanya owner tenant yang boleh menandai satu nomor (prefix + ordinal) sebagai hilang permanen. Alasan wajib (teks, batas panjang wajar). Nomor yang sudah punya struk ditolak. Nomor di luar rentang run (lebih besar dari lastNumber) ditolak.
- Cek celah (`receiptGapsForDevice`, `receiptGapsForOutletFast`, port laporan shift dan Tutup Hari) menghitung nomor yang di-write-off sebagai ada, dan laporan menandainya sebagai write-off (bukan hilang diam-diam).
- Tiap write-off menulis baris audit tenant (TEN-04) dengan pelaku, prefix, nomor, dan alasan. Tidak bisa dihapus atau diubah (append-only).
- Endpoint API owner-only (permission di `packages/shared/src/permissions.ts`, `requirePermission`, `requireTrustedOrigin`, `jsonBody`, skema zod strict). Tidak ada UI di cabang ini: buat kartu UI terpisah (menunggu review UI founder) dan tulis runbook singkat di `docs/runbooks/` untuk dipakai sebelum UI ada.
Detail: `bd show legend-0hzqw`, `bd show legend-6b0ld`, `bd show legend-nhmct`.

## Kartu
`ghostex board associate legend-0hzqw`, `bd update legend-0hzqw --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: tabel baru write-off (tenant_id NOT NULL, RLS FORCE, unik termasuk tenant_id) dan migrasi `0156` dengan when `1794235000000` (0155 dipakai payroll; catat), `pos-receipt.service.ts` bagian hitung celah, service/route write-off baru, permissions, validator shared, penulis audit, runbook, test. Jangan: logika klaim/rotasi/alokasi urutan struk edge, `closePosDay` selain yang perlu agar write-off terhitung, refund, payroll, auth, `worker-main.ts`, UI.

## Bukti selesai
Test reproduksi gagal dulu: Tutup Hari tertahan oleh lubang di run pensiun; sesudah owner write-off nomor itu, Tutup Hari lulus dan audit tercatat. Non-owner ditolak 403; nomor yang punya struk ditolak; nomor di luar rentang ditolak; lintas tenant tidak bocor; write-off tidak bisa diulang untuk nomor yang sama. `db:generate` kosong sesudah migrasi. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/201b-second-opinion-receipt-number-writeoff.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil, bukti, file berubah, SHA, migrasi dan langkah rilis, kartu UI yang dibuat, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
