# 864 Tanya AI: nyalakan otomatis untuk tenant pemakai (engineer Sonnet, akses)

Founder Q6 (15 Nov): pilihan A. Modul `ai_assistant` dinyalakan OTOMATIS hanya untuk tenant yang (1) paketnya memuat AI DAN (2) sudah memakai AI. Tenant lain tetap terkunci dan dinyalakan Super Admin per tenant (jalur yang ada).
Cabang fix/ai-modul-otomatis-864 dari milestone/m1. Langkah 0: `git log --all --oneline --grep=0m495` dan baca hasil thread 836 (kartu legend-0m495, bd show) untuk akar masalah dan definisi "paket memuat AI".

- Tentukan dari kode: definisi "paket memuat AI" (plan/entitlement) dan "sudah memakai AI" (mis. ada percakapan/riwayat Tanya AI atau koneksi AI tenant). Ragu definisi: lapor CTO dengan pilihan, jangan menebak.
- Backfill idempoten (migrasi data, rentang 0451) menyalakan modul untuk tenant yang memenuhi keduanya; catat audit (siapa: system, alasan: founder Q6).
- Tidak ada penyalaan untuk tenant tanpa AI di paket (aturan biaya).
Test gagal-dulu: tenant paket-AI + pemakai -> terbuka; paket-AI tanpa pemakaian -> tetap terkunci; pemakai tanpa paket-AI -> terkunci; backfill dua kali tidak menggandakan; isolasi tenant.
Review: satu subagent architect effort xhigh (akses + migrasi). Pra-gate AGENTS.md. Commit + push tanpa force. Klaim legend-0m495 dengan bd. Lapor sha, test, review, angka subagent.
