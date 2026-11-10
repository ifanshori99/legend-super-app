# Brief: second-opinion — PIN edge membedakan DB edge yang dibangun ulang lewat instance_id (legend-o839h)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/edge-pin-instance`, cabang `ws/edge-pin-instance`.
Rentang diff: `git diff 94d769c6..ws/edge-pin-instance` (base = `integ/m1-batch24` 94d769c6; abaikan `apps/api/drizzle/meta/*.json` dan `docs/`). Jangan pakai `merge-base main`. Migrasi cabang ini `0157_staff_pin_generation_instance` (journal idx 155, when 1794236000000; 0155 payroll dan 0156 write-off struk ada di cabang lain).
Desain: `docs/briefs/sub-edge-pin-instance.md` (bagian Design) di worktree itu.

## Berkas berisiko
- `apps/api/src/edge/access-applier.ts` (`applyStaffPinSet`, `applyStaffPinLocked`, `sameGenerationOrigin`, provenance)
- `apps/api/src/db/schema/device-pin.ts`, `apps/api/drizzle/0157_staff_pin_generation_instance.sql`
- `apps/api/src/services/device-pin.service.ts` (set cloud mengosongkan provenance)
- `apps/api/src/edge/link-server.ts` (header `x-edge-instance` sesudah autentikasi), `apps/api/src/edge/link-client.ts`, `apps/api/src/edge/protocol.ts`, `apps/api/src/edge/runtime.ts`, `apps/api/src/edge/db-link-store.ts`, `apps/api/src/edge/ports.ts`

## Invariant
- Edge yang DB-nya dibangun ulang (node id sama, `edge_nodes.instance_id` baru, sequence mulai lagi dari 1): set PIN dengan kunci (`setAt`) lebih baru diterima cloud tanpa runbook daftar node baru.
- Instance sama dengan sequence lebih rendah atau sama tetap ditolak (legend-rucdm R2); sequence lebih tinggi tetap menang walau kunci lebih tua (jam edge mundur).
- Edge lama tanpa instance id (header tidak dikirim): perilaku sama persis dengan sebelum perubahan.
- Kunci cloud `pin_generation_at` tidak pernah mundur; lock (`staff_pin.locked`) hanya memakai cabang sequence untuk node + instance yang memberi generasi.
- TEN-01/TEN-02: tenant dan outlet hanya dari kredensial edge yang terverifikasi; header instance tidak pernah menjadi dasar akses dan tidak bisa menyentuh baris tenant lain.
- Kompatibilitas: cloud lama mengabaikan header; frame link tidak berubah. Rilis: cloud dulu, lalu edge.
- Instance tidak diketahui (header tidak ada, event parkir yang di-drain, replay konflik oleh supervisor): aturan node-saja persis seperti sebelum perubahan. Drain parkir tidak boleh meminjam instance link yang sedang hidup (review K #2). Baris lama dengan instance null lalu edge mengirim instance: dibandingkan dengan kunci (agar rebuild dari baris lama tidak butuh runbook).
- Batas yang diketahui: event parkir milik DB lama yang dibangun ulang masih memakai aturan node-saja (sama dengan sebelum perubahan). Restore/clone (instance sama) tetap memakai sequence (legend-yd0h8). Celah saat upgrade: baris (node, null) yang kuncinya di depan jam edge menolak satu set/lock sampai jam edge lewat.

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
