# 1194 Second opinion akses ronde 2 (delta fix 1183 atas SO 1181)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran.

Konteks: temuan ronde 1 di `docs/qa/second-opinion-akses-1181.md`. Fix: `git fetch origin`, lalu `git diff origin/ws/1172-access-audit-guard...origin/ghostex/1183-fix-so1181-akses -- apps/api` (head c3d5ca1bc). Bila nama base tidak ada, pakai `git merge-base` dengan `origin/milestone/m1`.
Isi: legend-ig3dg (offboarding hitung ulang access.role.assign sesudah advisory lock, jam DB), legend-2n5qj (changeOwner re-check platform_admins + umur MFA jam DB sesudah lockOwnerChanges). Race sisa registry sudah diterima CTO (bead legend-qdmbp).
Cari: eskalasi akses, izin basi sesudah cabut, Owner baru tanpa hak, aktor salah di audit, lintas tenant, bypass MFA.
Hasil: tulis `docs/qa/second-opinion-akses-1194.md` di folder utama (P0-P3, berkas:baris, skenario, usul test; nyatakan tiap temuan 1181 tertutup/belum). JANGAN commit, JANGAN edit file lain.
