# Sub-brief triase kartu (Explore, baca saja, JANGAN ubah apa pun, JANGAN jalankan bd update/comment)

Repo: /Users/ifanshori99/Projects/legend super app/legend. Basis: `milestone/m1` (4c818489). Baca kode lewat `git show milestone/m1:<path>` atau `git grep <pola> milestone/m1 -- <path>`; jangan checkout.
Daftar kartu areamu: /private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app/7ed16f27-35b7-4845-a380-97505e9eaf06/scratchpad/areas/<AREA>.txt (satu kartu per baris: id, P, label, judul, deskripsi singkat). Detail penuh: `bd show <id>` (baca saja; komentar kartu sering sudah memuat bukti "fix di m1" atau cabang ws/...).

Klasifikasikan SETIAP kartu ke satu kelompok:
- A = fix sudah di m1 (bukti: sha ancestor `git merge-base --is-ancestor <sha> milestone/m1`, atau file:baris + test di m1), kartu masih terbuka hanya menunggu second-opinion Codex. Beri bukti.
- B = EXT / butuh founder (akun, kunci, kontrak vendor, label external/human).
- C = FE/UI yang menunggu gerbang mockup atau review UI founder (label fe/design, "UI:" dll.) dan belum ada mockup disetujui.
- D = siap dikerjakan backend/infra/test sekarang. Beri: ukuran S/M/L, tingkat K (uang, auth, migrasi, data pribadi, nomor dokumen) atau S, berkas utama (path), ketergantungan (id kartu lain / cabang belum merge), model (sonnet cukup? ya/tidak), dampak (tinggi/sedang/rendah, 1 kata alasan).
Kalau kartu sudah ada cabang ws/... yang belum merge ke m1 dan sedang dikerjakan, tandai D dengan catatan "ada cabang <nama>". Jangan menebak: bukti tidak ketemu = D atau '?' dengan alasan.

Keluaran (satu blok, satu baris per kartu, pemisah |):
id|grup|bukti-atau-alasan(<=140 char)|ukuran|K/S|berkas utama|dep|model|dampak
Untuk A/B/C kolom ukuran..dampak boleh kosong. Akhiri dengan jumlah per grup. Tanpa prosa lain.
