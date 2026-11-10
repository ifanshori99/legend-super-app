# Brief: engineer — reservasi mandiri tamu lewat link bertanda tangan (legend-o5gr)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat), lalu ikuti. Konvensi: `AGENTS.md`, `docs/plan/contracts.md`.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/reservation-selfservice`, cabang `ws/reservation-selfservice` (dari `main` 31bf885). Setup: `pnpm install --offline --frozen-lockfile` (gagal: `--prefer-offline`); jangan symlink `node_modules`.

## Tujuan
WS-08, PRD v1.7 §3.22 (Pengingat, DP & Kebijakan): route publik bertanda tangan untuk tamu reservasi: lihat reservasi + snapshot kebijakan, batal sebelum datang memakai `cancellationDepositOutcome` (snapshot RSV-03), minta jadwal ulang. Refund DP diserahkan ke WS-05 lewat jalur refund yang ada (buat permintaan refund; jangan bayar langsung). Detail: `bd show legend-o5gr` dan kontrak `legend-m7ak`.

## Kartu
`legend-o5gr`. Di awal: `ghostex board associate legend-o5gr`, `bd update legend-o5gr --status in_progress`. Saat melapor: status `review` + `bd comment` bahasa biasa.

## Catatan (keamanan, uang)
- Token link: acak kuat, simpan hash saja, terikat satu reservasi + tenant, ada kedaluwarsa (setelah waktu reservasi), bisa dicabut; bandingkan konstan-waktu. Token tidak pernah masuk log (ikuti pola e-receipt publik di `pos-receipt` untuk URL rusak).
- Rate limit route publik. Respons tidak membocorkan data tamu lain atau keberadaan reservasi lain.
- Batal dan jadwal ulang idempoten; batal setelah lewat batas kebijakan mengikuti snapshot, bukan kebijakan terbaru.
- Jadwal ulang = permintaan yang disetujui staf, kecuali kontrak sudah mengatur lain.
- Cabang `ws/refund-approval` (belum merge) mengubah alur refund: panggil satu fungsi layanan refund yang ada di `main`, jangan salin kode cabang itu.
- Tabel baru: `tenant_id` NOT NULL, RLS FORCE, unique termasuk `tenant_id`. Migration via drizzle-kit. Jangan baca `.env*`. Jangan pkill proses test global.

## Scope
- Boleh: schema/service/route/test reservasi publik baru (`*reservation-public*`), kontrak di `packages/shared` bagian reservasi, satu-dua baris registrasi route.
- Jangan: `apps/web/`, POS, payment provider, payroll, akuntansi.

## Bukti selesai
- Test: token valid/invalid/kedaluwarsa/dicabut; token tenant lain ditolak; lihat snapshot kebijakan; batal sebelum batas → hasil DP sesuai snapshot + permintaan refund dibuat sekali; batal dobel idempoten; jadwal ulang tercatat; rate limit; token tidak muncul di log.
- `heavy pnpm check`, `heavy pnpm build`, `pnpm format:check`, `node scripts/ci/color.mjs`, `node scripts/ci/tenant-hardcode.mjs` lulus (satu gerbang penuh setelah perubahan terakhir). `git status` bersih.
- Subagent reviewer konteks segar cek diff; temuan nyata dibetulkan.

## Sebelum melapor
Commit lokal di `ws/reservation-selfservice`, hanya file dalam scope. Pesan commit merujuk legend-o5gr.

## Laporan
Hasil, bukti (perintah dan hasilnya), file berubah, commit, risiko tersisa, yang dibutuhkan dari CTO.
