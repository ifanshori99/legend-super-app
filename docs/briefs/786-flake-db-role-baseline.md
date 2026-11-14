# 786 Flake: db-role-provisioning-baseline vs zoqc_aux roles (legend-cwz62)
Peran: engineer (Codex, kartu S, flake/test). Effort medium. Basis: worktree dari origin/milestone/m1. Hanya berkas test/harness; jangan ubah kode produk atau batas RAM.
Masalah: `bd show legend-cwz62`. Di run penuh, tests/db-role-provisioning-baseline.test.mjs (legend-2ywn) mengaudit role cluster saat tests/db-role-provisioning.test.mjs membuat role zoqc_aux_<hash> (pesan: "application role is a member of unexpected roles: zoqc_aux_<hash>" / "has or inherits superuser").
Arah: isolasi (role sementara diberi prefix yang diabaikan baseline hanya bila milik run test, atau kedua test diserialkan lewat lock/advisory lock), bukan melonggarkan audit untuk role sungguhan.
Bukti: reproduksi race dulu (jalankan dua berkas bersamaan berulang sampai merah), lalu fix, lalu 10x bersamaan hijau. Root node:test terkait lewat heavy (jalur ringan bila cocok). prettier/eslint. Satu reviewer subagent.
Commit+push ke cabang kerja, jangan merge. Lapor: berkas, bukti reproduksi, angka subagent.
