# legend-k2l lanjutan: profil member di merge, arah merge, throttle email

Peran: engineer (baca berkas peran dan "Paralel dulu" di TEAM.md). Tingkat K (auth, data pribadi): satu subagent architect review.
Basis: `git worktree add .worktrees/k2l-2 -b ws/k2l-followup ws/ws01-k2l` (cf37290d), lalu `git merge --no-ff milestone/m1` (berisi 111j profil member, e15950fe). Konflik migrasi: k2l tetap 0204 sementara, m1 berakhir idx 208; geser k2l ke ujung (0220 sementara, `when` di atas m1) agar `db:generate` kosong. Jangan checkout folder utama. Jangan push.

## Keputusan CTO
Arah merge ikut kontrak `planIdentityMerge`: **akun lama tersisa** (akun yang sudah memegang WhatsApp/identitas lebih dulu). Alasan: kontrak sumber kebenaran; akun lama memegang riwayat (pesanan, poin, voucher), referensi luar tetap stabil, lebih sedikit baris dipindah. Sesi login diterbitkan ulang ke akun yang tersisa. Perbarui dokumen desain yang menyebut U tersisa supaya sama dengan kontrak.

## Kerja (test gagal-dulu tiap butir)
1. Balik arah merge sesuai keputusan di atas; audit merge mencatat akun asal dan akun tersisa.
2. Sambung bagian yang menunggu 290a memakai kode 111j di m1: `moveMemberProfiles`, `onWhatsAppVerified`, `recordMemberConsent`, `app.member_profiles_of_user`. Ubah `it.todo` profil jadi test nyata. Ledger poin append-only: pindah kepemilikan lewat entri, bukan update/hapus baris lama.
3. Throttle per alamat email untuk permintaan link (selain per IP dan per browser). Jawaban tetap sama (tidak membocorkan alamat terdaftar).
4. Login lewat email menulis audit login seperti jalur lain.
5. Typecheck, test terkait, `db:generate` kosong, e2e lewat `heavy`. Architect review delta, temuan nyata dibetulkan.
6. Commit lokal, `bd comment legend-k2l`, update `docs/PROGRESS.md`.

Kunci SMTP SumoPod dan Google OAuth belum ada; test tetap pakai transport tiruan. Jangan ekspansi array zsh `${(@f)...}`. Jangan pkill proses lain.

## Laporan
Sekali di akhir: SHA, nomor migrasi, test gagal-dulu per butir, temuan architect, sisa TBD.
