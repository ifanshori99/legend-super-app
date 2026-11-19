# 1202 Merge train batch98 (Sonnet, 19 Nov)

Peran: `~/.agents/team/roles/merge-train.md` (ikuti seluruhnya, termasuk aturan Retro 53: mendarat hanya bila full run lulus di kode final, atau keputusan per berkas tertulis di `docs/merge-queue.md`).
Target: `milestone/m1` cbec1feb6 (sesudah batch97). Integrasi di worktree `int/batch98`. Migrasi tip m1: 0503; renumber berurutan mulai 0504.

## Isi batch98 (maks 7, urutan ini)
Baca baris SIAP masing-masing di `docs/merge-queue.md`.
1. ws/1177-tablet-reservasi-aktor f48fe4134 (lewati bila sudah ada di m1)
2. ws/1184-payout-gl-holds 356b357e6 (migrasi kerja 0715-0716)
3. ws/1170-flake-higiene e9105cf90
4. ws/1187-test-isolasi 23701452f
5. ws/1188-reservasi-so1186 e7e2b2707
6. ws/1179-payout-so1173-fix d58a535de (migrasi kerja 0708-0709)
7. ws/1198-reseal-so1196 dacdbc33f (migrasi kerja 0720; menggantikan ws/1189 yang DITAHAN)

Jangan ikutkan: ws/1172 dan ghostex/1183 (ditahan, diganti ws/1201), ws/1189, ws/1190 (diganti ws/1199). Batch99 (sesudah ini): ws/1191 (basenya int/batch97 lama yang memuat 1172: cherry-pick commit milik 1191 saja), ws/1199, ws/1201, ws/1192.

## Catatan
- Perbaikan train sendiri di jalur uang/akses: satu subagent architect xhigh sebelum mendarat (seperti 75799a6a3).
- Saran dari batch97 yang boleh ikut bila kecil: TEN-06 Q39 (`platform-org-api`) pakai tenant sendiri.
- Tunggu job heavy dengan Bash run_in_background satu notifikasi; tanpa Monitor/loop foreground; tanpa laporan antara.
- Selesai: push m1, tulis baris Batch98 di merge-queue, hapus worktree int/batch98, lapor sekali (SHA m1, cabang masuk, migrasi, gate, keputusan per berkas, subagent total/puncak).
