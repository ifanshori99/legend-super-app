# Brief 86: fix review Sonnet — HRIS SOP/pelatihan (ws/hris-sop, dari 50e6eba4)

Worktree `.worktrees/hris-sop`. Kartu legend-7df1. Jangan push, jangan `.env*`, jangan pkill.

## Wajib
1. **Kunci jawaban terbongkar lewat skor** (Sedang) — `hris-training.service.ts:80,595-640`. Wajib jawab semua soal (422 kode baru bila ada yang kosong); batasi percobaan (maks 5 per 24 jam per karyawan per pelatihan, 429/409 kode baru); respons percobaan hanya `passed` + skor total, tanpa detail per soal.
2. **Sertifikat diperpanjang tanpa batas** (Rendah) — `:640-690`. Tolak percobaan baru selama sertifikat aktif masih berlaku (boleh dalam 30 hari terakhir sebelum kedaluwarsa).
3. **Jadwal tidak dicek** (Rendah) — `:535-720`. Bila `scheduled_start`/`scheduled_end` diisi, tolak di luar jendela.
4. **SOP versi masa depan** (Rendah) — `hris-sop.service.ts:~470-520`. Daftar karyawan dan konfirmasi pakai versi terbaru dengan `effectiveFrom <= hari ini (WIB)`.

## Jadi bead (jangan dikerjakan)
Lampiran SOP ke objek storage sembarang tenant (`hris-sop.service.ts:299-318`).

## Bukti
Test regresi per poin di `apps/api/src/test/hris-training.test.ts` / `hris-sop.test.ts`; `pnpm format:check`, `heavy pnpm check`, `heavy pnpm build`. Commit lokal path-scoped, pesan `fix(hris-sop): ... (legend-7df1)` + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Lapor SHA + test, maks 10 baris.
