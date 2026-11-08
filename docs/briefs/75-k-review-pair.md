# Brief: review pasangan tingkat K (v3.3) — reviewer Opus + architect

Repo `/Users/ifanshori99/Projects/legend super app/legend`. Baca saja: jangan edit, jangan commit, jangan checkout (pakai `git diff`/`git show <cabang>:<path>`). Jangan baca `.env*`. Jangan jalankan test berat; jangan `pkill`.

## Yang diperiksa
Diff `$(git merge-base main <cabang>)..<cabang>`, abaikan `apps/api/drizzle/meta/**`. Fokus berkas service, route, validator, migration SQL, dan sinkron/offline. Test hanya dibaca bila perlu membuktikan temuan.

## Lensa
- Checklist wajib: `~/.agents/team/review-checklist.md` (akses data antar tenant/outlet, event ganda atau hilang, nomor dokumen offline bolong, dll).
- Lensa penyerang: kasir/staf jahat, tenant lain, request diulang, request paralel, jam/zona waktu, pembulatan Rupiah, idempotency, RLS (`tenant_id` NOT NULL, FORCE RLS), `approval_requests`, migration yang mengubah/menghapus data.
- Invariant bisnis: `docs/PRD.md` bagian domain cabang itu, dan kontrak di `docs/plan/contracts.md`.

## Laporan (maks 25 baris)
Satu baris per temuan: `path:baris` — Tinggi/Sedang/Rendah — masalah — skenario gagal konkret — saran perbaikan. Hanya temuan nyata yang bisa dibuktikan dari kode. Tidak ada temuan: satu baris "tidak ada temuan". Baris terakhir: putusan `LOLOS` atau `PERLU FIX`.
