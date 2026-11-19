# 1153 Second opinion refund ronde 16 (1144 echo hold, SO 15)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran.

Fokus (sesudah `git fetch origin`, kecualikan `':!**/meta/*snapshot.json'`): `git diff origin/ws/1139-refund-ronde14-fix..origin/ws/1144-refund-hold-echo` (head 41b89605d). Ronde 15: `docs/qa/second-opinion-refund-ronde15-1143.md`.
Isi: hold menit 0 ditutup hanya bila R yang cocok menutup penuh (refund id + payment ref sama, hold <= R); echo > R / payment lain / saklar mati = hold terbuka + satu alert id stabil; payment id bertentangan/tak terbaca tidak jatuh ke reference intent (`payment_id_unusable`); gerbang 26ro5 tidak melaporkan `fact_shared` untuk hold yang ditutup otomatis.
Sedang diperbaiki (jangan dilaporkan): hold echo kecil ditutup saat R masih `approved` (aturan baru: tutup hanya saat R final sukses). Diterima CTO (jangan dilaporkan): payload tersimpan sebelum 1144 tanpa `payment_id_unusable`; penanda `auto_closed` bergantung teks catatan.
Cari: temuan ronde 15 benar tertutup; refund keluar melebihi pembayaran (dashboard + manual + echo); hold ditutup tanpa uang benar kembali tercatat; hold dihitung ganda atau tidak dihitung di ruang refund per order; lintas tenant/integrasi; retry payload tersimpan.
Hasil: tulis `docs/qa/second-opinion-refund-ronde16-1153.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain.
