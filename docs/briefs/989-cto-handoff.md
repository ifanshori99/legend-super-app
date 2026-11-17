# 989 Serah terima CTO (17 Nov 18:30, dari G72tm)

Kamu CTO Legend baru (coordinator). Muat skill ghostex-coordinator, jalankan `ghostex coordinator guide`, baca ~/.agents/team/roles/cto.md dan "Paralel dulu" di ~/.agents/team/TEAM.md.
Keadaan lengkap: blok "CTO G72tm" terakhir di docs/PROGRESS.md (cabang ux/customer-order-benchmark), antrean di docs/merge-queue.md, cron di `bd memories cto-crons`.
Aturan founder: jangan merge ke main, jangan deploy, jangan force push. Jangan force-switch sesi CTO. Volume Docker bernama tidak dihapus.

## Langkah pertama
1. `ghostex coordinator link` tiga thread ini supaya laporannya datang ke kamu: S30:P6b2j:G36es (merge train batch84), S30:P6b2j:G6xcr (984 f586w), S30:P6b2j:G2669 (987 ronde 2).
2. Buat ulang 4 cron berulang dengan prompt sama seperti sesi lama (bd memory cto-crons; prompt verbatim di transcript G72tm): push :07, akun mati :37, retro 3 jam `43 1,4,7,10,13,16,19,22`, Q13 :52.
3. Buat ulang 2 cron sekali jalan:
   - 20:52 hari ini: "CTO: Codex #5 seharusnya sudah reset 7 hari (20:46). Cek `ghostex accounts` bagian CODEX. Bila #5 (atau #4) 7d < 50% dan ready: mulai SO QR/VA dengan `ghostex coordinator start-thread --agent codex --model gpt-6.1-sol --effort xhigh --account 5 --title "968 SO QR/VA 940" --body-file docs/briefs/968-second-opinion-qrva-940.md` (tanpa worktree). Bila #6/#7/#8 sudah login lagi dan ready, boleh dipakai. Bila belum ada akun Codex sehat, jangan mulai; catat di PROGRESS."
   - 21:07 hari ini: "CTO: Codex #4 seharusnya sudah reset 7 hari (20:54). Cek `ghostex accounts` bagian CODEX. Bila #4 (atau akun Codex lain yang belum dipakai SO QR/VA) 7d < 50% dan ready: mulai SO payroll dengan `ghostex coordinator start-thread --agent codex --model gpt-6.1-sol --effort xhigh --account 4 --title "971 SO payroll 955" --body-file docs/briefs/971-second-opinion-payroll-955.md` (tanpa worktree). Bila belum ada akun Codex sehat, jangan mulai; catat di PROGRESS."
4. Q13: akun Claude #3 5h 88% (reset 20:00). Tiga thread di atas masih di #3 dan sedang dalam giliran (switch tanpa --force ditolak). Pindahkan ke #1 (7d 0%) di batas giliran: `ghostex agents switch-account <ref> --account 1`. Thread baru: `--account 1`.

## Thread berjalan
- G36es merge train batch84 (brief 986): full run. Mendarat: verifikasi SHA m1, resolve, lalu train batch85 (brief baru pola 986; base m1 baru, renumber setelah batch84).
- G6xcr 984 f586w (cabang `ghostex/984-f586w-shared-device-wip`): opsi B `devices.shared_mode` 0560 + penanda sesi server 0561 + PATCH admin. Route uang menunggu 985 mendarat (kartu terpisah).
- G2669 987 ronde 2: membetulkan temuan reviewer #1 (kategori terhapus) setelah run. Lalu antre.

## Antrean (docs/merge-queue.md)
- Batch85 SIAP (7): 4badcac8 cf9428b5a, 978 fed38a6a9, 981 83dd3da01 (setelah ee902477), 980 08187d8b0 (sebelum 982), 982 2ba47d846, a846fbcc c9c096052 (983, setelah dd932307), 984 e35c4a41a (setelah 981).
- Batch86: 988 947c48b1b (e2e wajib), 985 cda5730e0 (setelah 982), 987 dan 984 f586w bila selesai.
- TAHAN: duitku-fe-ws05 (Q24/Q25), pos-panel-bayar-sisa-5w6 (Q19).
- Tahan sampai batch mendarat: legend-izy5l (akar TS2769), legend-1c5xg (void edge vs refund manual; butuh 978+980), route uang 984 (butuh 985).

## Second-opinion Codex sebelum gerbang rilis (tunggu kuota Codex)
968 QR/VA (+969), 971 payroll (+dd932307), 973 DOIT recurring 965, 975 Tanya AI 964+976, 977 POS 974, 979 recon 958+967. Belum ada brief: refund 980, charge tukar menu/refund manual 982+985, akses 981+984. Codex #6/#7 tidak diperbaiki (founder Q21).

## Founder belum jawab
W3 (dua keputusan refund 980, saran A keduanya), Q19-Q25, Q2 opsional, legend-0ytbu.

## Slot
RAM hijau 18:25 (Claude 6/8, Codex 0/3). Kartu siap di bd banyak: isi slot sesuai aturan (ram-guard dulu, `ghostex accounts`).
