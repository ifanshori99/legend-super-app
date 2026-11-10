# Brief: engineer — perbaikan temuan Codex profit share distribusi (legend-33im6)

## Peran
Baca `~/.agents/team/roles/engineer.md` lalu ikuti. Uang dan akses: kerja dengan Opus high.

## Worktree
`.worktrees/8s992` (cabang ws/8s992-profit-rules, HEAD 0033ea1d). Commit di cabang yang sama.

## Tujuan
Tutup 5 temuan second-opinion Codex (brief 377 dan 379). Tiap temuan: test gagal-dulu, lalu fix.
1. P1 `apps/api/src/services/profit-share-distribution.service.ts:1128`: approval melewati matriks; pengguna selain pembuat yang punya izin approve bisa menyetujui nominal yang butuh approver tertentu atau beberapa tingkat. Fix: saat submit buka approval chain dari matriks approval yang sudah ada (pakai service approval yang dipakai modul lain, jangan buat baru); status `approved` hanya setelah chain selesai.
2. P2 `profit-share-distribution.service.ts:803`: clawback parsial berulang mengembalikan pajak melebihi potongan. Contoh: distribusi Rp1.000.000 pajak 10%, koreksi -Rp499.995 dua kali lalu -Rp5, total pajak kembali Rp100.001; koreksi -Rp5 menghasilkan pajak positif dan melanggar constraint. Fix: alokasi kumulatif, pengembalian pajak dibatasi sisa potongan; koreksi terakhir mengambil sisa persis.

3. P1 `apps/api/src/services/profit-share-registry.service.ts:430` (Codex 379): mengganti `userId` penerima langsung mengalihkan akses statement historis (Alice dibayar, registry diganti ke Bob, Bob baca riwayat Alice). Fix: perubahan penerima diversikan dan lewat approval; distribusi dan statement menyimpan identitas penerima saat itu; otorisasi statement memakai identitas historis.
4. P1 `apps/api/drizzle/0219_profit_share.sql:215` (Codex 379): migrasi mewajibkan tabel dokumen pemegang saham kosong; satu dokumen sah sebelum upgrade menggagalkan seluruh migrasi. Fix: backfill entitas dan pemetaan referensi lama sebelum FK, tanpa menghapus dokumen. 0219 belum masuk milestone/m1, jadi boleh diperbaiki di 0219 sendiri; catat di laporan supaya merge train mereset DB dev. Test: migrasi di DB yang sudah berisi dokumen.
5. P2 `apps/api/src/services/profit-share-statement.service.ts:50` (Codex 379): konfigurator penerbit statement tidak pernah dipanggil; pembayaran sukses tetapi PDF gagal 503 dan `statement_file_key` NULL. Fix: pasang adapter storage/email di bootstrap API; test jalur router bawaan menghasilkan file key.

## Cakupan
Berkas di atas, test-nya, helper langsung. Migrasi bila wajib: 0252, jangan menomori ulang.

## Bukti
- Test baru tiap skenario gagal sebelum fix, lulus sesudah; test profit share lain tetap hijau.
- `heavy` typecheck api, test file profit share. Batas Retro 11: 2x gagal typecheck, baca log.
- Satu subagent architect xhigh mereview diff fix.

## Laporan
Commit SHA, test ditambah, hasil typecheck/test, temuan architect dan penanganannya.
