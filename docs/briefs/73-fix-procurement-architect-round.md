# Brief: engineer — perbaikan procurement dari second-opinion architect (ws/procurement)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/contracts.md`.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/procurement`, cabang `ws/procurement` (ae09d1d). Jangan pindah cabang. Jangan pkill proses test global.

## Temuan yang wajib dibetulkan (architect, 2026-11-08)
1. Sedang — `purchasing-flow.shared.ts:356-363` menelan `APPROVAL_POLICY_MISSING` (juga policy rusak, `platform-approval.service.ts:587-588`) lalu jatuh ke approve manual satu orang. Biarkan error naik (409 policy belum diatur); approve manual hanya untuk `{required:false}`. Test: tanpa policy → 409; policy multi-level tetap multi-level.
2. Sedang — revoke link / close / cancel PO tidak menghentikan email supplier yang antre; worker (`worker/purchasing-po-email.job.ts:133-148`) membuat link baru tiap retry; PDF publik hanya blok `cancelled` (`purchasing-send.service.ts:725`). Dalam transaksi revoke/close/cancel tandai delivery antre `failed`; job hanya kirim untuk status `sent`/`partially_received`; PDF publik tolak juga `closed`; retry tidak mencetak link baru. Test: kirim → revoke → jalankan job → tidak terkirim.
3. Rendah — kolom nominal PDF (`purchasing-po-pdf.ts:136-143`, `:267-274`) bertabrakan untuk ≥ Rp100 jt. Lebarkan/fit; test 10 digit.
4. Rendah — job email memanggil provider di dalam transaksi DB (`job:118-164`). Pindahkan panggilan provider ke luar transaksi atau pastikan adapter dedupe by `reference` dengan test.
5. Rendah — tambah test: `legend_app` UPDATE/DELETE riwayat harga supplier → 42501.
6. Rendah — betulkan komentar `purchasing-send.service.ts:15-16` (DTO memang memuat email penerima).
7. Keputusan founder Q11: batal/tutup PO dan batal PR hanya oleh pembuat dokumen atau pemegang izin approve terkait (`purchasing.order.approve` / setara untuk PR) di outlet itu; lainnya 403. Test.

## Bukti selesai
- Test untuk tiap butir; `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus (satu gerbang penuh setelah perubahan terakhir). `git status` bersih. Reviewer subagent konteks segar cek diff.

## Laporan
Per butir: apa yang diubah dan test-nya; bukti gerbang; commit; risiko tersisa.
