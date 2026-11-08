# Brief: engineer — legend-b0au, legend-94qt, legend-0gy1

## Peran
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/AGENT_PLAYBOOK.md`, `docs/plan/contracts.md`. Prosedur migration: `/Users/ifanshori99/Projects/legend super app/HANDOFF.md` §5.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/pos-payment-fixes`, cabang `ws/pos-payment-fixes` (dari `main` terbaru). Jangan pindah cabang.

## Tujuan
Selesaikan tiga bead POS follow-up dari review uang: `legend-b0au` (siklus tender QRIS: payment.expired/failed ke tender POS, batalkan link WS-05 saat tender pending di-void), `legend-94qt` (serialisasi pemakaian DP reservasi lintas order satu sesi meja, cegah terpakai dua kali), `legend-0gy1` (kontrak approval POS membawa id pos_override). Detail: `bd show <id>`. Area uang: race condition wajib dites (transaksi bersamaan).

## Kartu
`legend-b0au`, `legend-94qt`, `legend-0gy1` (jalankan tiap perintah untuk ketiganya). Di awal: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan bahasa biasa>"`.

## Cepat
Founder minta cepat. Pecah kerja dan spawn subagent bertipe (implementer, test-writer, Explore) paralel dalam satu giliran; file tidak bertumpuk. Jangan menunggu tanpa kerja.

## Catatan paralel
Tiga engineer lain bekerja paralel di cabang lain (POS shift kasir, nomor struk, hardening edge, UI order pelanggan). Kode tender/approval POS bisa bersinggungan dengan shift kasir: jangan refactor file bersama, ubah seminimal mungkin. Bila butuh migration: generate dengan drizzle-kit seperti biasa; nomor bisa bentrok saat merge, CTO yang menangani urutan (jangan edit `_journal.json` manual). Jangan sentuh file di luar domain bead.

## Scope
- Boleh diubah: kode, test, dan docs domain bead ini.
- Jangan disentuh: `apps/web/src/routes/_customer/` (UI order pelanggan sedang dibangun), `design/`, provisioning role DB. Rahasia: jangan baca `.env*`.

## Bukti selesai
- Test baru untuk perilaku nyata, isolasi tenant, dan kasus gagal.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus. `git status` bersih.
- Subagent reviewer konteks segar atas diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal, pesan merujuk `legend-b0au, legend-94qt, legend-0gy1`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, commit, migration (nomor), bead lanjutan, risiko, kebutuhan dari CTO.
