# 788 Pengerasan DOIT dan refund (4 kartu, tingkat K, uang)

Peran: engineer (baca `~/.agents/team/roles/engineer.md`). Basis: worktree dari `origin/milestone/m1`, cabang `ws/doit-refund-hardening`.

Kartu (baca `bd show <id>` tiap kartu, termasuk komentar):
1. legend-gqv7: webhook refund DOIT dari integrasi nonaktif tanpa `data.reference` ditolak 401, hasil refund hilang. Sekitar `payment-webhook.service.ts:236-251`. Hasil refund yang sah harus tetap tercatat; webhook palsu tetap ditolak.
2. legend-tx8x: jalur refund di bawah tier (satu penyetuju) tanpa cek MFA; juga refund karantina yang dibuka ulang. Aturan CTO 9 Nov (komentar kartu): refund karantina yang dibuka ulang butuh MFA atau penyetuju kedua.
3. legend-3gna: `DOIT_REFUNDS_ENABLED` harus sama di API dan worker (peringatan startup dan/atau cek `pnpm run doctor`, plus `docs/deployment.md`).
4. legend-1vm1: batalkan VA lama saat tamu ganti bank (`cancel()` adapter DOIT); pastikan `GATEWAY_POLL_WINDOW_MS` >= umur VA (180 menit).

Paralel: Explore per kartu, test-writer untuk test gagal-dulu, satu implementer per kartu (file tidak bertumpuk; bila bertumpuk, berurutan).

Aturan uang (founder): tiap perubahan dibuktikan test bahwa tidak ada pihak dibayar lebih dan outlet tidak rugi (refund ganda, VA lama yang tetap dibayar, webhook diputar ulang). Bila ragu, pilih aturan yang membatasi pembayaran dan laporkan keputusan ke CTO.

Tanpa migrasi kecuali memang perlu; bila perlu, nomor 0373 dan laporkan. Jangan sentuh area yang sedang dikerjakan thread lain: panik, payout, QRIS hold, edge KDS, HRIS.

Selesai: test terarah lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, typecheck API), satu subagent architect effort xhigh atas diff, temuan nyata dibetulkan, commit lokal per kartu, push cabang. Laporan: SHA, test yang dijalankan, hasil architect, angka subagent (total, puncak bersamaan). Jangan merge ke m1, jangan deploy. Codex tidak menjalankan bd; kamu (Claude) boleh `bd update --claim` dan komentar SHA.
