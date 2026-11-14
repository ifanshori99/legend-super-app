# Brief: ui-engineer — Pengaturan AI sesuai mockup yang disetujui (legend-nnufz)

## Peran
Baca `~/.agents/team/roles/ui-engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep, Read offset/limit), lalu ikuti. Semua kerja UI ikut `~/.agents/team/ui-standard.md`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `milestone/m1`. Cabang akhir `ui/ai-settings-v2`.

## Tujuan
Founder menyetujui mockup (W5 Q2): `design/mockups/ai/` di cabang `design/ai-settings` 08defdc48 (`review.html`, state lengkap desktop 1280 + mobile 390). Layar sudah tersambung API (commit 95de4c6d1, 3c4a5c73a legend-nnufz.1). Samakan layar dengan mockup: utama/cadangan tampil bersama, persetujuan risiko sebelum login ChatGPT, pengaturan teknis dilipat, state memuat/offline/sesi habis (login ulang lalu kembali ke halaman ini), dimatikan platform. Cakupan kunci platform: ikuti keputusan CTO yang dikirim terpisah; sampai itu datang, pertahankan perilaku sekarang (kunci ChatGPT saja) dan jangan ubah API.

## Kartu
`legend-nnufz` (aturan kartu: `~/.agents/team/brief-template.md`). Teks UI baru didaftarkan ke katalog (`node --test tests/text-contract.test.mjs`).

## Pembagian paralel
Explore (2): layar sekarang vs mockup; kontrak shared AI. implementer per kelompok state (file terpisah). ui-auditor sebelum lapor. Heavy: satu test-runner.

## Bukti selesai
Screenshot tiap state 1280 dan 390 (`docs/screenshots/ai-settings-v2/`), test web terkait hijau, pra-gate AGENTS.md (prettier, eslint, typecheck web lewat heavy).

## Sebelum melapor
Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Jangan merge, jangan deploy.
