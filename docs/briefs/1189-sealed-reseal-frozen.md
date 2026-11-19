# 1189 Reseal kolom tersegel yang beku (engineer Sonnet, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.
Base: `milestone/m1` (2b23b324f). Cabang: `ws/1189-sealed-reseal-frozen`. Tingkat K (migrasi, kunci enkripsi): satu architect xhigh. Nomor migrasi kerja: 0720-0722 saja (merge train menomori ulang saat landing).

## Kartu (`bd show <id>`)
1. `legend-4vfmn`: 4 kolom beku (orders.payment_link_token_sealed, orders.claim_token_sealed, pos_order_tenders.payment_link_token_sealed, apology_vouchers.code_sealed) belum bisa di-reseal karena trigger POS-04/revoke 0212. Keputusan CTO (sudah final): fungsi SECURITY DEFINER sempit yang hanya menulis ulang envelope tersegel dengan plaintext sama (cek decrypt(new)=decrypt(old) di aplikasi, dan di DB hanya kolom sealed itu yang boleh berubah; kolom lain identik), tanpa melonggarkan trigger/append-only untuk kolom lain. Owner fungsi dan GRANT EXECUTE hanya ke peran job reseal.
2. `legend-49onu`: baris frozen (apology_vouchers.code_sealed, token order selesai) menahan pensiun kunci selamanya. Pakai jalur fungsi kartu 1 di job reseal yang ada (cari dengan `git grep -n reseal origin/milestone/m1 -- apps/api/src`, runbook 1014). Tanpa menghapus data, tanpa kehilangan voucher aktif.

## Batas
Kunci lama tidak boleh dipensiunkan sebelum remaining==0 (job menghitung baris frozen juga). Jangan ubah nilai plaintext, status voucher, atau kolom uang. Jangan sentuh payment-webhook*, reservation-*, payroll-payout*.

## Bukti selesai
Test gagal-dulu: (a) reseal baris beku sukses, plaintext sama, kolom lain tidak berubah; (b) panggilan fungsi dengan plaintext beda ditolak; (c) UPDATE langsung kolom lain di baris beku tetap ditolak trigger; (d) peran app biasa tidak bisa EXECUTE; (e) remaining menghitung baris beku lalu 0 sesudah job; (f) isolasi tenant. `pnpm db:generate` kosong. Typecheck api sekali lewat heavy. Prettier + eslint. Architect xhigh, temuan dibetulkan. Commit, push, tutup kartu. Tunggu job heavy dengan Bash run_in_background satu notifikasi.

## Laporan
SHA, migrasi dipakai, kartu ditutup, subagent total dan puncak, gate, yang belum teruji. Lapor sekali.
