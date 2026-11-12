# Brief: engineer (Codex) — Tanya AI: deteksi otomatis model + login ChatGPT device code

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu", "Kerja berat" di `~/.agents/team/TEAM.md`. Kartu: `bd show legend-39d.8 legend-z83k` (baca komentar z83k: pagar CTO 9 Nov + keputusan founder Q88).

Kerjakan berurutan di satu cabang `ws/ai-login-autodetect` (basis `milestone/m1`): bagian A dulu, commit, lalu bagian B. Selesaikan keduanya, baru lapor.

## A. legend-39d.8 — provider kustom deteksi otomatis (tingkat S)
Provider OpenAI-compatible sudah ada (`apps/api/src/lib/ai/openai-compatible.ts`, layanan provider tenant dari legend-dwrr). Tambahkan:
- Saat admin menyimpan/menguji base URL + API key + nama model: deteksi jendela konteks, batas output, dukungan tools dan reasoning. Urutan sumber: respons `GET /v1/models` (field seperti `context_length`, `max_model_len`, `context_window` bila ada) → tabel model dikenal di kode → default aman kecil. Admin boleh override. Simpan hasil per tenant.
- Orkestrator (`services/ai-orchestrator.service.ts`) memilih level thinking/`reasoning_effort` per permintaan (pertanyaan singkat rendah, analisis/forecast/multi-tool lebih tinggi), dibatasi kemampuan model terdeteksi. Model tanpa reasoning: parameter tidak dikirim.
- Riwayat percakapan dipangkas sesuai jendela konteks terdeteksi.
- Biaya: level thinking tidak boleh membuat anggaran AI tenant terlampaui (anggaran default 0 tetap). Test bukti.
- Pakai Context7 untuk format `/v1/models` OpenAI/OpenRouter/vLLM/Ollama.

## B. legend-z83k — login ChatGPT lewat device code (tingkat K, auth)
Keputusan founder Q26 + Q88: tiru cara Hermes (client Codex CLI, device code flow), risiko blokir akun diterima founder. Rincian alur dan endpoint: `docs/design/chatgpt-oauth-research.md` bagian 3. Pagar wajib (dari komentar z83k):
1. Opt-in per tenant, mati default; hanya owner yang bisa menghubungkan, wajib centang persetujuan risiko blokir akun ChatGPT (simpan siapa + kapan).
2. Provider kustom (bagian A) tetap jalur cadangan: bila token ChatGPT gagal/dicabut, orkestrator jatuh ke provider kustom tenant bila ada, atau menampilkan keadaan "AI tidak tersedia".
3. Access/refresh token terenkripsi (pakai kunci data yang sudah ada di repo), tidak pernah dikirim ke klien, tidak pernah di-log; endpoint cabut koneksi.
4. Kill switch global lewat env (validasi di `config/env.ts`, tambah ke `.env.example`) yang mematikan semua koneksi ChatGPT seketika.
5. Satu adapter terisolasi (mis. `lib/ai/chatgpt-codex.ts`) agar nanti bisa ditukar ke client ID resmi OpenAI tanpa ubah orkestrator.
- API: mulai device code (kembalikan kode + URL verifikasi ke owner), polling status, cabut. Semua di belakang `requireAuth`, `requireTrustedOrigin`, `requirePermission`. Rate limit polling.
- Migrasi: pakai nomor 0417–0418 saja (registry dan referensi test memakai nomor yang sama).
- UI tidak termasuk (layar admin legend-nnufz menyusul lewat mockup). Cukup kontrak shared + API + test.

## Jangan
- Jangan menyentuh alur pembayaran, loyalty, atau HRIS. Jangan merge ke m1 atau main. Jangan deploy.
- Jangan memanggil endpoint OpenAI sungguhan di test; pakai mock/fixture.

## Bukti selesai
- Test gagal-dulu untuk: deteksi konteks (3 sumber), pemilihan level thinking + batas anggaran, opt-in + persetujuan, token tidak bocor di respons/log, kill switch, fallback ke provider kustom, isolasi tenant (tenant lain tidak bisa melihat/mencabut koneksi).
- Test terarah lewat `heavy` (lihat AGENTS.md "Test terarah") dan pra-gate AGENTS.md hijau.
- Lapor: commit, file, test yang dijalankan, yang belum terverifikasi. Bagian B akan direview architect xhigh dan second-opinion sebelum rilis.
