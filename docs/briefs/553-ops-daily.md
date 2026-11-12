# 553 — Paket B: operasi harian dan replay offline

Acuan: `docs/briefs/552-triage-result.md` di checkout induk, Paket B; kelima kartu dibaca melalui `bd --readonly show`. Tidak mengubah status Beads.

## Basis dan batas kerja

Worktree `.worktrees/ops-daily`, cabang `ws/ops-daily`, basis `origin/milestone/m1@ede015c9`. Checklist-engine sudah masuk melalui port `3b4adcd3`, perbaikan `c715ba3a`, dan merge `da6418bf`; ketiganya diverifikasi sebagai ancestor m1. Ref lama `e3ac2efb` bukan ancestor langsung.

Tabel triage menyebut file utama. Tambahan schema, RLS, route, caller, dan teks domain operations diperlukan untuk kartu serta migrasi 0386–0388 yang secara eksplisit ditugaskan. File bersama ditangani berurutan: close, actor binding, kemudian prep. Test domain boleh berubah; registry dan konfigurasi e2e global tetap milik A.

Core storage (`core-storage.routes.ts`, `core-storage-access.ts`) tetap milik C. Tidak mengubah payroll, pajak/akuntansi, CRM, inventory/purchasing, edge, HRIS, atau UI 539. Pembacaan katalog inventory dari service operations tidak mengubah domain inventory.

## Kartu dan hasil implementasi

| Kartu       | Hasil                                                                    | Checkpoint                 |
| ----------- | ------------------------------------------------------------------------ | -------------------------- |
| legend-ga0n | Antrean persisten dan replay terikat tenant/user/outlet                  | `cebe5855`                 |
| legend-do1o | Shelf-life per outlet/item dan use-by hasil server                       | Commit kartu ini (lihat git log)      |
| legend-7j4e | Close handover persisten setelah acknowledge                             | `a6374b68`                 |
| legend-wf37 | Transport media operations belum tersedia dalam kontrak storage yang sah | Tertahan pada C/integrator |
| legend-8erc | Dua workaround aria-label di start-run dialog dihapus                    | `20fd36f9`                 |

Semua checkpoint lokal; tidak push, merge, membuat PR, atau menghapus worktree/cabang.

## Invariant yang dibuktikan

- Antrean: maksimum 100 jawaban per tenant/user/outlet; key dan isi jawaban tetap saat retry; FIFO; storage gagal atau penuh menolak secara jelas tanpa membuang jawaban lama. Pending berbeda dari konfirmasi server.
- Web Locks melindungi mutasi read/modify/write storage, tanpa menahan lock selama request jaringan. Browser tanpa Web Locks menolak antrean offline secara jelas; pengiriman online langsung tetap tersedia.
- Scope aktif diperiksa sebelum kirim. `expectedActorUserId` dibekukan dari scope tersimpan dan dibandingkan dengan actor sesi di server sebelum replay atau mutasi. Actor tidak ditetapkan dari input. Antrean legacy diperkaya dari actor tersimpan, bukan actor sesi saat ini.
- Metadata actor dihilangkan sepenuhnya dari content fingerprint, mempertahankan key lama. Replay key yang telah berhasil didahulukan; jawaban antrean dengan key berbeda tidak boleh menimpa hasil item yang lebih baru. Konflik 409 tetap tersimpan dan terlihat.
- Foto/tanda tangan offline tetap diblokir. Tidak menganggap preview atau ID lokal sebagai bukti yang sudah diunggah.
- Shelf-life: setting operasi per tenant/outlet/item, tanpa perubahan tabel inventory. Server menghitung useBy dari producedAt ditambah durasi dalam menit. Setting yang hilang atau expiry kiriman yang tidak sesuai ditolak. Nilai ISO dipertahankan untuk validasi; waktu lokal outlet hanya untuk input/tampilan, termasuk jam DST berulang. Label lama tidak dihitung ulang saat setting berubah.
- Close: hanya acknowledged dapat closed; actor/waktu penutup tersimpan bersama state dan audit. Izin outlet diperiksa sebelum replay. Fingerprint close memasukkan aksi sehingga key acknowledge tidak dapat dipakai sebagai close. Closed tidak dapat dibuka ulang melalui acknowledge.

## Migrasi

- `0386_shift_handover_close`: metadata penutup dan constraint status/acknowledgement/closure. Snapshot hanya mengubah public.shift_handovers.
- `0387_prep_item_shelf_life`: tabel public.prep_item_settings, lima FK inline dalam CREATE TABLE, tenant/outlet FORCE RLS. Snapshot hanya menambah tabel tersebut.
- Rantai snapshot 0286 → 0386 → 0387 valid. Journal when 1794451493865 dan 1794451816536 lebih besar daripada basis 1794416100000.
- Nomor 0388 tidak dipakai. `db:generate` pernah kosong setelah schema disinkronkan; pemeriksaan kosong akhir dilakukan runner.

## Verifikasi dan review

- Test gagal-dulu direkam sebelum implementasi tiap fitur. Empat regresi review juga direproduksi: fingerprint legacy mengembalikan 409, stale queue menimpa data dengan 200, migration owner non-superuser terkena 42501 karena FORCE RLS, dan predicate form menolak expiry DST yang sah.
- Setelah fix: API 63/63 + root 34/34 = 97/97, tanpa skip. Log `/tmp/553-verify-final-after-review-tests.log`.
- Eslint 39 file dan Prettier 44 file exit 0 setelah perubahan source terakhir. Daftar file tersimpan di `/tmp/553-all-code-files0` dan `/tmp/553-all-changed-files0`.
- Satu architect native mereview area checklist, close, shelf-life, migrasi, dan empat fix terakhir. Tidak ada temuan terbuka. Laporan `/tmp/553-architect-review.md`.
- Typecheck shared → API → web sedang antre sebagai satu job heavy terurut. Browser terarah: `legend-td4f.mock.spec.ts` dan `legend-d983.mock.spec.ts` serta `legend-cz9g.mock.spec.ts`; hasil akhir dicatat di PROGRESS sebelum handover.
- Gate penuh pnpm check, suite penuh, build production, dan verifikasi production tidak dijalankan thread ini.
- Subagent: 11 total, puncak 6 bersamaan. Tiga Explore, satu test-writer, lima implementer, satu test-runner, satu architect. Token heavy di test_runner; subagent lain hanya membaca, mengedit, dan mereview.

## Dependency nyata legend-wf37

Kontrak storage saat ini belum mempunyai source-kind/izin operations. Document tanpa source-kind membutuhkan hr.employee.manage; receipt tanpa source-kind ditolak. Mengubah consumer saja tidak memungkinkan staf operations mengunggah bukti secara sah. Tidak menyamarkan media sebagai HRIS, menu, atau purchasing.

C/integrator perlu menentukan source-kind private document beserta izin upload/read pada outlet. Usulan teknis yang belum menjadi kontrak: checklist_evidence dengan ops.checklist.complete, breakdown_evidence dengan ops.equipment.maintain, facility_cleaning_evidence dengan facility.booth.operate. Pemilik C perlu menyinkronkan shared/storage/index.ts, core-storage-access.ts, constraint db/schema/core-storage.ts, dan migrasi dari rentangnya sendiri. B tetap hanya konsumen upload generik.

Cakupan kartu juga memerlukan caller `features/facility-staff/components/cleaning-dialog.tsx` yang berada di luar batas consumer B saat ini. Pemetaan menemukan `completeCleaningTask` di kontrak/mock tetapi belum menemukan implementasi API produksi; integrator perlu menetapkan pemilik transport tersebut.

Setelah kontrak tersedia, satu helper multipart di `features/facility-admin/api.ts` dapat dipakai checklist, breakdown, dan cleaning. Gunakan cookie, biarkan browser menetapkan Content-Type multipart, parse respons shared, simpan hanya ID hasil server, dan cegah write domain bila upload gagal. Tanda tangan harus menghasilkan PNG Blob nyata, termasuk alternatif nama. Rincian proposal: `/tmp/553-wf37-report.md`.
