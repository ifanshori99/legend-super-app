# Brief: fix putaran 4 — ws/db-role-provisioning (verifikasi second-opinion Codex)

Cabang `ws/db-role-provisioning` (HEAD 46ede00), worktree `.worktrees/db-role-provisioning`. Kartu legend-zoqc. CLOSED: H2, M1, M2, N1. Pastikan `node_modules` worktree bukan symlink (legend-meki). Merge `main` dulu.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (file tidak bertumpuk). Tiap fix butuh test regresi PostgreSQL nyata yang gagal sebelum fix.

## Kerjakan
1. **N2 role.ts:36** — guard memakai fungsi/katalog tanpa schema; worker bisa membuat `pgboss.pg_has_role(...)` yang mengembalikan false, dan URL admin dengan `options=-c search_path=pgboss,pg_catalog` lolos guard. Fix: qualify semua fungsi/katalog di guard worker dan aplikasi dengan `pg_catalog.`; regresi function shadowing.
2. **H3 provision-roles.ts:584** — cek keterjangkauan tabel `pgboss` mengabaikan grant per kolom. Fix: tambah `has_any_column_privilege` untuk SELECT/INSERT/UPDATE.
3. **H3 provision-roles.ts:595** — tabel pengecualian RLS hanya dicek flag-nya; policy UPDATE permissive `USING(true)` di `tenant_domains` lolos. Fix: verifikasi policy tulis tabel pengecualian (tolak permissive tanpa pembatas tenant) atau tambah policy restrictive pembatas tenant untuk tiap operasi tulis.
4. **Baru provision-roles.ts:526** — audit tidak mencakup `pg_parameter_acl`; `GRANT SET ON PARAMETER session_replication_role TO PUBLIC` lolos. Fix: audit hak efektif SET/ALTER SYSTEM pada parameter administratif, termasuk lewat PUBLIC dan membership.
5. **Bukan di sini:** H1 sisa (denylist fungsi admin, mis. `pg_switch_wal`) dicatat sebagai bead legend-2ywn. Jangan dikerjakan sekarang.

## Bukti selesai
Test provisioning dan role lulus, `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check` lulus, `git status` bersih, subagent reviewer konteks segar cek diff. Commit lokal merujuk legend-zoqc. Jangan push, jangan merge. Lapor per temuan: fix, test, commit.
