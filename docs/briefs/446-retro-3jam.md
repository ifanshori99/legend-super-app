# Brief: retro workflow berkala

Tujuan: belajar dari kerja nyata, lalu perbaiki workflow tim supaya cepat, akurat, hemat, dan tidak crash di Mac 16 GB.

## Data yang dibaca (sejak retro terakhir, lihat tanggal teratas di `~/.agents/team/RETRO.md`)
1. `~/.claude/state/ram-log.csv`: sampel RAM dan CPU per menit. Cari:
   - puncak RAM, menit merah, dan proses penyebabnya;
   - menit dengan CPU >85% atau `load1` > jumlah core, serta proses penyebabnya;
   - proses yang memakan CPU berulang-ulang: watcher, dev server dari cabang yang sudah selesai, tsc atau test yang dijalankan ulang tanpa perubahan;
   - proses yatim (`orphans`). Laporkan pemiliknya; jangan dimatikan sendiri.
2. `~/.claude/scripts/parallel-report "<folder sesi>" --since <HH:MM>` (Legend: `/Users/ifanshori99/Projects/legend super app`; subfolder `legend` memberi `(tidak ada sesi)`): rata-rata dan puncak subagent per agent, serta rentang kerja sendiri.
3. `~/.claude/scripts/ram-guard status`, `ghostex coordinator status`: agent restart, thread macet.
4. `docs/PROGRESS.md` repo Legend: insiden, gate gagal, temuan Codex yang lolos dari review Claude, kerja ulang.
5. `git log --since` di repo dan worktree: berapa commit fix dan revert.

6. `ghostex accounts`: pemakaian kuota 5 jam dan 7 hari per akun Claude dan Codex, thread yang berhenti karena limit, akun yang hampir habis.
7. `python3 ~/.claude/scripts/session-usage.py <uuid>` untuk sesi CTO dan thread yang selesai di jendela ini: biaya per thread dan per kartu yang selesai.
8. `bd` (folder repo Legend): kartu yang pindah ke `review` dan `closed` di jendela ini, kartu baru dari temuan review (kerja ulang), dan sisa kartu siap.
9. `ghostex coordinator status` dan board: slot kosong dan berapa lama, thread parkir atau macet, pertanyaan ke founder, kartu izin palsu.

## Enam ukuran (founder 10 Nov)
Nilai tiap jendela dengan angka, bandingkan dengan retro sebelumnya:
- Efektif: kartu masuk `review` dan masuk m1 per jendela retro (sekarang 3 jam).
- Efisien: slot terisi (rata-rata thread aktif dari batas RAM), subagent rata-rata per agent.
- Hemat: biaya per kartu selesai, persen kuota 7 hari yang terpakai per kartu.
- Tepat: kerja ulang (temuan review tingkat tinggi/sedang, gate gagal, revert) per kartu.
- Cepat: waktu kartu dari thread mulai sampai `review`, dan dari `review` sampai masuk m1.
- Akurat: laporan thread yang ternyata salah atau kurang saat diperiksa CTO/merge train.

## Keluaran
Tambahkan satu entri di atas `~/.agents/team/RETRO.md`:
- tanggal dan jam;
- 3 sampai 6 angka kunci: puncak RAM, menit merah, subagent rata-rata dan puncak per agent, gate gagal, kerja ulang;
- tabel enam ukuran dengan tren (naik/turun dari retro sebelumnya);
- maks 3 temuan, masing-masing dengan bukti;
- perubahan yang dilakukan.

## Aturan perubahan
- Boleh langsung (kecil, bisa dibalik):
  - menyetel angka di `ram-guard` atau `heavy`;
  - menambah pola perintah berat di hook;
  - merapikan `TEAM.md` atau template brief.
  Untuk perubahan skrip: jalankan semua `~/.claude/scripts/tests/*.sh` sampai lulus, lalu catat di RETRO.md.
- Usul saja (tulis di RETRO.md bagian "Usul untuk CTO"):
  - mengubah peran, model, atau jumlah agent;
  - menghapus aturan;
  - apa pun yang menyentuh kode produk.
- Jangan ubah kode produk, rahasia, atau `main.md`.
- Jangan mematikan proses milik agent lain.

Laporan maks 6 baris: angka kunci, temuan, perubahan, usul.

## Jadwal
Founder 11 Nov: retro tiap 3 jam sampai workflow ideal, lalu 5 jam, lalu 12 jam. Bila 3 retro berturut-turut stabil dan target tercapai (enam ukuran datar atau membaik, tanpa temuan baru), tulis usul "naik ke tahap berikut" di bagian "Usul untuk CTO"; CTO yang menanyakan ke founder.

Topik tambahan retro pertama 11 Nov: kenapa 3 tsc jalan bersamaan (heavy.lock, heavy-2.lock, heavy-5.lock) saat RAM merah 05:40. Log ke ~/.agents/team/RETRO.md.
