# Brief: perbaikan workflow tim (routing Codex/Claude, model, effort)

## Peran
Kamu bekerja seperti retro (`~/.agents/team/retro-brief.md` bagian batas wewenang), tetapi tugasnya perbaikan workflow yang diminta founder 14 Nov 2026. Tidak menyentuh kode produk.

## Tujuan
Founder: akun Codex #6, #7, #8 tidak punya batas 5 jam (#7 7d 0%, #8 7d 5%, #6 7d 92%); akun Claude #1 dan #2 dimaksimalkan (cek `ghostex accounts --refresh`; #1 masih membaca 94% saat brief ditulis). Kerja harus paralel lagi (agent dan subagent), tetap hemat: routing model dan level thinking diatur.

## Yang diubah (langsung edit, simpan cadangan `.bak671` di scratchpad)
1. `~/.agents/team/TEAM.md`:
   - "Kuota Codex dan second opinion" dan "Rute kuota": aturan lama "Codex hanya dua akun Plus / hanya designer dan second-opinion" sudah usang. Tambah: Codex boleh menjadi `engineer` untuk kartu tingkat S yang jelas (test, flake, kontrak, backend tanpa uang/akses/migrasi data), dengan brief yang menyebut file dan test; Claude tetap untuk tingkat K, merge train, ui-engineer, architect. Catat batas: Codex tidak bisa menjalankan `bd` (CTO memindah kartu), akun baru butuh founder trust hook sekali.
   - Tabel model/effort: tambah baris Codex engineer (`gpt-6.1-sol`, medium untuk S kecil, high untuk area 3-6 kartu). Turunkan effort default yang boros bila datanya mendukung (lihat Retro 24-26 di `~/.agents/team/RETRO.md`: biaya per thread, subagent rata-rata).
   - Urutan pemilihan akun: Codex dulu untuk kerja S (akun 7d terendah tanpa batas 5 jam), Claude #1/#2 untuk K; Claude >90% 7d hanya untuk kerja < 30 menit.
2. `~/.agents/team/brief-template.md` (temuan 14 Nov):
   - `start-thread --worktree` membuat cabang `ghostex/<acak>`, bukan nama di brief; dua thread lupa rename/push. Tambah langkah wajib akhir: rename ke `ws/<nama>` dan push tanpa force sebelum lapor.
   - Fail-first tidak terbukti saat test-writer dan implementer paralel. Tambah: test-writer menjalankan test baru terhadap base sebelum implementer menggabung, catat yang merah.
   - Cabang yang dibangun di atas cabang lain (mis. finance-exceptions di atas dua cabang) membuat `_journal.json` idx ganda dan `when` tidak monoton. Tambah cek pra-lapor: idx unik dan `when` naik.
   - Helper tanggal test memakai UTC padahal service memakai Asia/Jakarta (AS-2 merah 00:00-07:00 WIB). Tambah satu baris ke `~/.agents/team/review-checklist.md`.
3. `~/.agents/team/roles/engineer.md`: usul Retro 26 nomor 2 (target subagent rata-rata >= 2 tidak pernah tercapai tiga retro; ganti ke target puncak >= 4 dan rata-rata >= 0,5) bila datanya masih mendukung.
4. `~/.agents/team/roles/cto.md`: satu baris rute akun baru (Codex S dulu, Claude K).

## Batas
Jangan ubah `~/.agents/main.md`, kode produk, rahasia, atau proses agent lain. Jangan menghapus aturan lain yang tidak disebut. Setiap perubahan: satu baris alasan + bukti (retro atau kejadian 14 Nov) di `~/.agents/team/RETRO.md` bagian baru "Perbaikan workflow 14 Nov".

## Laporan
Diff ringkas per berkas (path + 1 baris per perubahan), yang sengaja tidak diubah dan alasannya, dan keputusan yang menurutmu perlu founder (biaya/vendor).
