# Run 3 — second opinion refund tier

Scope: hanya `ceaab8fe..b169986a` pada `ws/refund-tier`, worktree `.worktrees/refund-tier`. Review statis read-only; satu-satunya berkas yang ditulis adalah laporan ini.

## Temuan

- `apps/api/drizzle/0135_system_approval_requester.sql:64` — **P2, I15:** `user_role_guard` hanya berjalan pada `UPDATE`; raw SQL dapat menyisipkan akun baru dengan `banned = true`, `ban_expires = NULL`, dan `role = 'admin'` tanpa penolakan, sehingga akun mendapat role global saat ban aktif. Tidak ada constraint atau trigger lain yang menutup jalur ini. Jaga `INSERT` juga, dengan penanganan `OLD` yang sesuai untuk operasi tersebut; tambahkan regresi penyisipan akun berban dengan role.
- `apps/api/drizzle/0135_system_approval_requester.sql:84` — **P2, I15:** Guard assignment hanya berjalan pada `INSERT` atau perubahan `user_id`; setelah akun kasir diban dan assignment lamanya dipertahankan, `UPDATE role_assignments SET role_id = <supervisor satu tenant> WHERE id = <assignment>` memberi role supervisor tanpa memicu guard. FK dan RLS mengizinkan perubahan satu tenant ini. Jaga perubahan role, perluasan cakupan, dan pengaktifan/perpanjangan masa berlaku pada akun berban, sambil tetap mengizinkan pencabutan; tambahkan regresi perubahan `role_id` setelah ban.

## Hasil pemeriksaan lainnya

- I15 belum terpenuhi sepenuhnya karena dua temuan di atas; penjagaan pada `grantRoleAssignment` dan CLI konsisten dengan ban aktif, termasuk ban yang kedaluwarsa.
- I16 terpenuhi pada skenario yang diperiksa: pengguna dengan alamat lama `system@legend.invalid` tidak lagi menghalangi migrasi, dan baris manusia biasa yang memakai ID cadangan ditolak.
- I17 terpenuhi pada alur yang diperiksa: cursor melewati kandidat gagal/terkunci dan bertahan saat berhenti dini; `lock_timeout` membatasi penantian lock; payout mendapat timer sendiri setelah backfill. Tidak ditemukan defect tambahan pada normalisasi alasan berdasarkan code point dan batas UTF-16.
- Test regresi tersedia di `apps/api/src/test/payment-refund-system-chain.test.ts`: benturan email/adopsi pada baris 920/939; penjagaan role pada 976–1167; cursor/alasan pada 1212/1237/1340/1400; shutdown/lock pada 1178/1281. Dua bypass baru di atas belum tercakup.

## Verifikasi dan batas

- Diff produksi dan kode pendukung yang diperlukan diperiksa; test hanya diperiksa keberadaannya. `git diff --check` pada lima berkas produksi dalam rentang review selesai dengan exit 0.
- Tidak menjalankan test, migrasi, SQL, build, atau layanan. Skenario temuan dibuktikan melalui event trigger, constraint, FK, dan RLS pada kode, bukan eksekusi database.
- Subagent: 3, puncak bersamaan 3. Tidak mengubah kode, melakukan commit, push, atau merge.
