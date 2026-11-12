# 555 Merge train batch48k
Peran: merge train (~/.agents/team/roles/merge-train.md). Ikuti pola docs/briefs/542-merge-train-batch48j.md dan pelajaran batch48i/48j di docs/PROGRESS.md (renumber migrasi, `when` naik, FK inline bila FORCE RLS, upgrade dari DB m1).
Basis: origin/milestone/m1 e9bbd9ea (migrasi terakhir 0289). Cabang integrasi int/batch48k.
1. Gabung urut (semua sudah direview + second opinion): ws/fix-ykk88-c79uy 346df155, ws/hris-misc 1bcead9d, ws/ws07-tax-reports b4d72985 (migrasi sementara 0357-0359 perlu dicek bentrok), ws/ws08-crm 1b0ba72b, ws/ws06-purchasing 9378da96 (typecheck api/shared belum pernah jalan: jalankan di sini).
2. Renumber semua migrasi cabang ke atas 0289, `when` naik monoton. Bukti upgrade dari DB m1.
3. Gate: eslint/prettier berkas berubah, tsc shared/api/web, test terarah area, lalu SATU `heavy pnpm check` penuh. Kegagalan yang hanya flaky di beban penuh dan lulus sendiri 2x: catat, jangan menahan (kartu legend-bi7yu dan flaky edge-catalog sudah ada). Hijau: fast-forward + push milestone/m1 (bukan main). Hapus worktree cabang yang sudah tergabung.
Konflik isi (bukan migrasi): jangan putuskan sendiri untuk uang/akses, laporkan.
Lapor dengan angka subagent, hash m1 baru, dan yang belum hijau.
