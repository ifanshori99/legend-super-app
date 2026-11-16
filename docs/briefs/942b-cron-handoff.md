# 942b Cron + thread untuk CTO G4c20 (dari G1rv9)

## Cron (buat ulang, prompt verbatim)
1. `7 * * * *` (tiap jam :07):
di repo /Users/ifanshori99/Projects/legend super app/legend jalankan git push origin --all tanpa --force (backup cabang kerja; repo privat). Gagal karena non-fast-forward: catat cabangnya, jangan force. Laporan satu baris, tanpa membangunkan thread.
2. `37 * * * *` (tiap jam :37):
Cek akun mati (Retro 31): jalankan `ghostex accounts 2>&1 | grep -iE "refreshing has failed|past due|not allowed|error"`. Kosong: jangan lapor apa pun. Ada hasil: pindahkan thread di akun itu ke akun sehat dengan 7 hari terendah (`ghostex agents switch-account`), lalu `ghostex coordinator item ask` + `ghostex notify` ke founder dengan akun dan pesan errornya.
3. `43 1,4,7,10,13,16,19,22 * * *`:
Retro 3 jam: mulai thread Sonnet (`ghostex coordinator start-thread --title "Retro workflow berkala" --model sonnet --effort high --body-file ~/.agents/team/retro-brief.md`, `--account` = akun Claude dengan 7 hari terendah, bukan yang >90%; cek `ghostex accounts`). Log hasil ke ~/.agents/team/RETRO.md. Jangan buat ganda bila thread retro sebelumnya masih jalan.
4. Q13 (tidak ada di CronList sesi lama; buat bila perlu, mis. tiap jam :52):
Q13 (founder: terima jeda kuota akun Claude #1). Jalankan `ghostex accounts`. Bila akun #1 7d >= 95% atau 5h hampir habis: pindahkan tiap thread yang masih bekerja di #1 ke akun #2 (`ghostex agents switch-account <ref> --account 2`, tunggu thread selesai giliran bila bisa; jangan --force kecuali turn-nya sudah aman). Akun #3 (7d >90%) hanya untuk kerja <30 menit. Sesi CTO sendiri: perbarui docs/PROGRESS.md lalu pindah juga ke #2 bila perlu. Lapor satu baris ke founder.
(Catatan: kuota akun sudah berubah; #3 sekarang rendah, #1 reset 17 Nov 18:00.)

## Thread (sudah di-unlink dari G1rv9)
- G196j 934 payout approvedBy grant (legend-xp8mc, brief 934, K uang/akses, architect xhigh): gerbang akhir di 892530f76, sedang ulang test 934+905. Belum lapor akhir.
- G15h0 936 POS panel bayar sisa (legend-5w6, brief 936, Opus ui-engineer): ambil ulang screenshot design/screenshots/pos-936. Belum lapor akhir; layar perlu review UI founder.
- G3p7h 940 QR/VA P3 (24ogm, 154wr, gp3fw; brief 940; architect xhigh): gagal-dulu sudah ditulis, implementasi berjalan. Belum ada SHA.
- G0suw 941 recon sisa (fnxl.9, fnxl.10, 3wpf; brief 941; architect xhigh): berjalan. Belum ada SHA.
Second-opinion Codex wajib sebelum gerbang rilis untuk 934, 940, 941.

## Founder, sudah ditanya, belum dijawab
Q15 (A), Q16 Coretax (A BPMP saja), hapus ~/.cache/huggingface 5,9 GB, review UI payout + POS 936.
