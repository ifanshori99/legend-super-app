# Brief: engineer — area WhatsApp masuk (kartu A + D, test B)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit; jangan baca TEAM.md utuh), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Kamu jalan di worktree sendiri dari `milestone/m1` (origin 46352cd5). Buat dua cabang kerja:
- `ws/lgfru-wa-proof` (kartu A) dari `origin/milestone/m1`.
- `ws/s5rgo-wa-simulator` (kartu D) dari `origin/milestone/m1`, worktree terpisah (`.worktrees/s5rgo`).
- `ws/9h2oj-tests` (test acceptance B) dari `origin/fix/codex-418-pin` (912e79c5), worktree terpisah (`.worktrees/9h2oj-tests`).

## Tujuan
Bukti WhatsApp masuk tercatat di identitas (A), simulator webhook + dokumen setup/rotasi secret (D), dan test acceptance gagal-dulu untuk reset PIN slip gaji lewat WhatsApp masuk (B) siap sebelum API B dibangun.

## Kartu
- `legend-lgfru` (A), `legend-s5rgo` (D), `legend-9h2oj` (B, hanya test; status tetap open setelah test, jangan tandai review).
Di awal tiap kartu A dan D: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan bahasa biasa>"`. Untuk B: `bd comment legend-9h2oj "test acceptance siap di ws/9h2oj-tests <sha>"`.

## Masukan
- Desain: `git show origin/ws/kirimdev-inbound-design:docs/design/whatsapp-inbound-verification.md` (rev 2.1). A: §2 D-WA1..D-WA3, §5.1, §6.1, kartu A §9. D: §7, kartu D §9. B: §2 D-WA3/D-WA6, §3, §5.2, §6.2, kartu B §9.
- Deskripsi kartu: `bd show legend-lgfru`, `bd show legend-s5rgo`, `bd show legend-9h2oj`.
- Login pelanggan inbound Kirimdev sudah ada di m1; A memperluas mesin yang sama (purpose di login_challenges).

## Pembagian paralel (giliran pertama, satu giliran)
- 2 `Explore`: (1) mesin login inbound Kirimdev di m1 (login_challenges, loadChallenge poll/cancel, login-binding.ts, route webhook, user_identities); (2) area payslip PIN di `origin/fix/codex-418-pin` (reset-otp, payslip-pin-whatsapp-sender, hris/payroll/errors.ts).
- 1 `test-writer`: test acceptance B dari kontrak §6.2 di worktree `ws/9h2oj-tests`, harus gagal terhadap kode sekarang.
- 1 `implementer` A (unit gagal-dulu dulu, lalu kode), 1 `implementer` D. File A dan D tidak bertumpuk; bila bertumpuk (mis. DECISIONS.md), D menunggu A untuk file itu saja.
- Review: A tingkat K (migrasi + identitas/akses) -> satu subagent `architect`, **architect effort xhigh**. D tingkat S -> satu `reviewer` sonnet. Temuan nyata dibetulkan sebelum lapor.

## Scope
- Boleh diubah: modul identitas/login inbound, route webhook Kirimdev, migrasi A, `scripts/wa-simulate-inbound.mjs`, `docs/deployment.md`, `docs/runbooks/kirimdev-webhook.md`, `docs/DECISIONS.md` (entri D-WA1..D-WA6), test terkait.
- Jangan disentuh: kode API reset PIN B (hanya test), modul uang (refund, Duitku, profit share), meja/sesi POS.
- Migrasi: A pakai nomor sementara **0272** (`0272_wa_proof_purpose`), bukan 0270 (0270 sudah dipakai `ws/owner-self-approve`). Nomor 0271/0273 dicadangkan untuk B. Merge train menomori ulang; jangan ubah migrasi lama.
- Jangan pernah mencetak `KIRIM_WEBHOOK_SECRET` atau rahasia lain; nama key dari `.env.example`.

## Bukti selesai
- Unit/integrasi A dan D lulus via `heavy` (perintah test proyek, path-scoped), bukti gagal-dulu A tercatat (sha + jumlah gagal).
- `heavy pnpm typecheck` 0 di kedua cabang.
- Test B: gagal terhadap `origin/fix/codex-418-pin` dengan alasan yang benar (bukan error setup).
- `node scripts/wa-simulate-inbound.mjs --help` jalan tanpa mencetak secret.

## Batas kerja ulang (Retro 11)
- `typecheck` atau `tsc` gagal 2 kali di kartu yang sama: berhenti menebak. Baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan SEMUA error sekaligus, jalankan sekali lagi. Gagal ketiga: lapor ke CTO dengan isi log.
- Jangan `pkill`/`killall` proses test, dev server, atau tsc.
- Jam di laporan: `date '+%H:%M'`.

## Sebelum melapor
Commit di tiap cabang kerja, hanya file dalam batas peranmu, lalu push ketiga cabang ke `origin`. Pesan commit merujuk id kartu.

## Laporan
Per kartu: hasil, bukti (perintah dan hasil), file berubah, commit/sha, temuan review dan perbaikannya, risiko tersisa, yang dibutuhkan dari CTO.
