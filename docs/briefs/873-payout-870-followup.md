# Brief: engineer — sisa temuan second opinion ulang payout 870 (F1 P1, F2 P2, F3 P2)

## Peran
Sama seperti brief 870 (`docs/briefs/870-payout-second-opinion-fix.md`): engineer, aturan paralel dan pra-gate tetap.

## Repo
Lanjut di cabang `fix/payout-second-opinion-870` (tip 9f75ea558) di worktree-mu. Commit baru di atasnya, push tanpa force. Cabang `fix/ui-payroll-bank-export-871` berbasis 870; jangan rebase cabang itu.

## Tujuan
Tutup F1-F3 di `docs/qa/second-opinion-payout-870.md` (ambil dari commit 664c68b62 atau dari repo utama `docs/qa/second-opinion-payout-870.md`). Aturan founder: jangan sampai rugi.

## Kartu
`legend-2aspe` (F1), `legend-w3691` (F2), `legend-cnpap` (F3). Status in_progress di awal, review saat lapor, beri komentar.

## Keputusan CTO
- F1: settlement `settle_pending` yang sudah tercatat tetap wajib dijurnal walau modul accounting dimatikan sesudahnya. Consumer `payroll.locked` memproses lock + pending bila ada pending untuk run itu, terlepas dari flag accounting saat ini (flag hanya menentukan payroll BARU). Jangan konsumsi event sukses tanpa menyelesaikan pending.
- F2: simpan fingerprint SHA-256 isi berkas saat unggah bukti; claim return ditolak 409 `PAYOUT_RETURN_PROOF_REUSED` bila fingerprint yang sama sudah dikonsumsi untuk operasi return lain di tenant yang sama (lintas batch juga). Satu laporan untuk beberapa item dalam satu operasi tetap sah. Field nomor referensi transaksi bank: kartu terpisah legend-nsqhm, jangan dikerjakan di sini.
- F3: bekukan akun GL sumber tunai di baris pending saat serah terima; resolver memakai akun beku itu, bukan mapping terbaru.

## Scope
Sama dengan brief 870. Migrasi: tambahan dalam file migrasi 0368 boleh hanya bila belum dibagikan; lebih aman migrasi baru berikutnya (merge train menomori ulang). Tanpa `NOT VALID` pada FK tabel FORCE RLS.

## Pembagian paralel
- test-writer: satu test gagal-dulu per temuan sesuai "Skenario gagal" di laporan.
- implementer (3): satu per temuan; `payroll-payout-gl.service.ts` dipakai F1 dan F3, kerjakan berurutan atau per fungsi.
- Pemegang heavy: satu test-runner. Review: satu architect xhigh atas delta.

## Bukti selesai
- Test baru merah di 9f75ea558, hijau setelah fix; test payout/GL/export terarah tetap hijau.
- Pra-gate AGENTS.md, `pnpm db:generate` kosong, typecheck API.
- Lapor sekali saat semua selesai (jangan akhiri giliran untuk kabar antara): SHA tip baru, migrasi, merah→hijau, angka subagent.
