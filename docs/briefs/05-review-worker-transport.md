# Brief: review — legend-18qw worker event transport (ws/worker-transport)

## Peran

Baca peranmu (`~/.agents/team/roles/reviewer.md` untuk agent Claude, `~/.agents/team/roles/second-opinion.md` untuk agent Codex), lalu ikuti. Hanya membaca dan menjalankan test; tidak mengubah kode.

## Repo

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/worker-transport`, cabang `ws/worker-transport`, commit `b22d549`. Diff: `git diff main...ws/worker-transport` (24 file).

## Konteks

Menutup penghalang rilis `legend-18qw`: transport event worker yang terautentikasi (lewat edge link `/api/edge-link` yang sudah ada), ack idempoten via `domain_event_consumptions`, gap replay via tabel baru `domain_event_gap_requests` (migrasi `0061`, `0062` dengan RLS tenant), penerima notifikasi dari data server (akun banned dikecualikan), adapter email Brevo di balik interface. Keputusan desain: `docs/DECISIONS.md` (entri terbaru). Aturan repo: `docs/plan/AGENT_PLAYBOOK.md`, `AGENTS.md` bagian Security rules.

## Fokus (area sensitif: auth, migrasi, data pribadi)

1. Isolasi tenant: RLS di `0062`, query tanpa filter tenant, kebocoran penerima lintas tenant.
2. Auth transport: bisakah event palsu/tenant lain masuk diproses?
3. Idempotensi dan urutan: race antara klaim, ack, dan gap; event diproses dua kali atau macet selamanya.
4. Migrasi: aman di DB yang sudah berisi data, reversible, index cukup.
5. Rahasia: `BREVO_API_KEY` tidak pernah di-log; data pribadi penerima (email) tidak di-log.
6. Fail-closed: config kurang tetap menolak start.

## Bukti selesai

- Agent Claude: jalankan `heavy pnpm check` lewat subagent `test-runner` (Colima: `~/.claude/scripts/colima-up`), laporkan hasilnya.
- Tiap temuan: `path:line`, tingkat (blocker/major/minor), skenario gagal konkret, usulan fix. Tanpa pujian, tanpa gaya.

## Laporan

Daftar temuan urut keparahan, hasil test, dan kesimpulan: aman di-merge / perlu fix dulu.
