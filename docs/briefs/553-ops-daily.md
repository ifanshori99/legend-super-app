# 553 — Paket B: operasi harian dan replay offline

Acuan: `docs/briefs/552-triage-result.md` di checkout induk, Paket B; kelima kartu dibaca melalui `bd --readonly show`. Tidak mengubah status Beads.

## Basis dan batas kerja

Worktree `.worktrees/ops-daily`, cabang `ws/ops-daily`, basis awal `ede015c9`, lalu rebase ke `origin/milestone/m1@e9bbd9ea` sebelum handover. Checklist-engine sudah masuk melalui port `3b4adcd3`, perbaikan `c715ba3a`, dan merge `da6418bf`; ketiganya diverifikasi sebagai ancestor m1. Ref lama `e3ac2efb` bukan ancestor langsung.

Tabel triage menyebut file utama. Tambahan schema, RLS, route, caller, dan teks domain operations diperlukan untuk kartu serta migrasi 0386–0388 yang secara eksplisit ditugaskan. File bersama ditangani berurutan: close, actor binding, kemudian prep. Test domain boleh berubah; registry dan konfigurasi e2e global tetap milik A.

Core storage (`core-storage.routes.ts`, `core-storage-access.ts`) tetap milik C. Tidak mengubah payroll, pajak/akuntansi, CRM, inventory/purchasing, edge, HRIS, atau UI 539. Pembacaan katalog inventory dari service operations tidak mengubah domain inventory.

## Kartu dan hasil implementasi

| Kartu       | Hasil                                                                    | Checkpoint                                         |
| ----------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| legend-ga0n | Antrean persisten dan replay terikat tenant/user/outlet                  | `0abf6824`                                         |
| legend-do1o | Shelf-life per outlet/item dan use-by hasil server                       | `cec2eb82` + `f26f3114` dan commit integrasi akhir |
| legend-7j4e | Close handover persisten setelah acknowledge                             | `6163067a`                                         |
| legend-wf37 | Transport media operations belum tersedia dalam kontrak storage yang sah | Tertahan pada C/integrator                         |
| legend-8erc | Dua workaround aria-label di start-run dialog dihapus                    | `2a79b63d`                                         |

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
- Rantai snapshot 0289 → 0386 → 0387 valid. Journal when 1794451493865 dan 1794451816536 lebih besar daripada basis terbaru 1794416400000.
- Nomor 0388 tidak dipakai. `pnpm db:generate` akhir exit 0 tanpa migrasi tambahan: `/tmp/553-rebase-generate-empty.log`.

## Verifikasi dan review

- Test gagal-dulu direkam sebelum implementasi tiap fitur. Empat regresi review juga direproduksi: fingerprint legacy mengembalikan 409, stale queue menimpa data dengan 200, migration owner non-superuser terkena 42501 karena FORCE RLS, dan predicate form menolak expiry DST yang sah.
- Setelah fix: Pada basis terbaru: API 124/124 + root 38/38 = 162 test unik dalam 17 file, tanpa skip. Log `/tmp/553-rebase-final-tests.log`. Hasil basis lama disimpan pada log verify-final/related-regressions.
- Eslint 39 file dan Prettier 44 file exit 0 setelah perubahan source terakhir. Daftar file tersimpan di `/tmp/553-all-code-files0` dan `/tmp/553-all-changed-files0`.
- Satu architect native mereview area checklist, close, shelf-life, migrasi, dan empat fix terakhir. Tidak ada temuan terbuka. Rechain ke 0289 juga diperiksa: semua tabel/journal upstream tetap utuh; 42 file produk/test/SQL identik dengan versi yang sudah direview. Laporan `/tmp/553-architect-review.md`.
- Typecheck shared, API, dan web lulus pada basis terbaru. Browser terarah: `legend-td4f.mock.spec.ts` dan `legend-d983.mock.spec.ts` serta `legend-cz9g.mock.spec.ts`; 39 kasus unik lulus: 38 pada run utama dan satu kasus prep pada rerun setelah selector test diperjelas. Tidak ada perubahan produk di antara run. Log `/tmp/553-rebase-final-typechecks.log`, `/tmp/553-rebase-final-browser.log`, dan `/tmp/553-rebase-prep-browser-retry.log`. Semua job selesai dan port 3283 tertutup.
- Gate penuh pnpm check, suite penuh, build production, dan verifikasi production tidak dijalankan thread ini.
- Subagent: 11 total, puncak 6 bersamaan. Tiga Explore, satu test-writer, lima implementer, satu test-runner, satu architect. Token heavy di test_runner; subagent lain hanya membaca, mengedit, dan mereview.

## Dependency nyata legend-wf37

Kontrak storage saat ini belum mempunyai source-kind/izin operations. Document tanpa source-kind membutuhkan hr.employee.manage; receipt tanpa source-kind ditolak. Mengubah consumer saja tidak memungkinkan staf operations mengunggah bukti secara sah. Tidak menyamarkan media sebagai HRIS, menu, atau purchasing.

C/integrator perlu menentukan source-kind private document beserta izin upload/read pada outlet. Usulan teknis yang belum menjadi kontrak: checklist_evidence dengan ops.checklist.complete, breakdown_evidence dengan ops.equipment.maintain, facility_cleaning_evidence dengan facility.booth.operate. Pemilik C perlu menyinkronkan shared/storage/index.ts, core-storage-access.ts, constraint db/schema/core-storage.ts, dan migrasi dari rentangnya sendiri. B tetap hanya konsumen upload generik.

Cakupan kartu juga memerlukan caller `features/facility-staff/components/cleaning-dialog.tsx` yang berada di luar batas consumer B saat ini. Kontrak/caller meminta POST `/api/facility/cleaning-tasks/:taskId/complete`, tetapi router facility yang terdaftar tidak mempunyai handler tersebut. Service `facility-units.service.ts` menyatakan task cleaning belum diimplementasikan dan mengembalikan `cleaningTask: null`. Jadi integrator juga perlu menetapkan pemilik backend cleaning-complete; upload consumer saja tidak cukup. Bukti statis: shared/facility/endpoints.ts:264, routes/facility.routes.ts, services/facility-units.service.ts:2–4,88–89.

Setelah kontrak tersedia, satu helper multipart di `features/facility-admin/api.ts` dapat dipakai checklist, breakdown, dan cleaning. Gunakan cookie, biarkan browser menetapkan Content-Type multipart, parse respons shared, simpan hanya ID hasil server, dan cegah write domain bila upload gagal. Tanda tangan harus menghasilkan PNG Blob nyata, termasuk alternatif nama. Rincian proposal: `/tmp/553-wf37-report.md`.

## Perintah dan bukti akhir

- Directed tests: `LEGEND_TEST_FILES` berisi 12 file API operations/migration dan lima file root terkait, `LEGEND_TEST_DB_NAME=ops_daily_rebase_final heavy pnpm test`; 162/162, tanpa skip. Daftar lengkap dan perintah pada `/tmp/553-test-runner-report.md`.
- Typecheck: `heavy bash /tmp/553-ops-daily-typecheck-shared-api-web.sh`, berisi `pnpm --filter @starter/shared typecheck`, API, lalu web; exit 0.
- Browser: `LEGEND_MOCK_PORT=3283 heavy pnpm exec playwright test --config=playwright.mock.config.ts e2e/legend-td4f.mock.spec.ts e2e/legend-d983.mock.spec.ts e2e/legend-cz9g.mock.spec.ts`; 38 lulus. Kasus prep lulus pada rerun `e2e/legend-d983.mock.spec.ts --grep legend-do1o` setelah hanya selector test diperjelas. Total 39 kasus unik lulus, termasuk offline/reconnect nyata, handover, dan 390/1440 terang/gelap.
- `pnpm db:generate`: exit 0, No schema changes, nothing to migrate.
- Final `pnpm exec eslint` atas file source/test berubah dan `pnpm exec prettier --ignore-unknown --check` atas file yang didukung; hasil akhir dicatat di PROGRESS. SQL dibuktikan dengan migrasi database nyata, termasuk owner tanpa SUPERUSER/BYPASSRLS.

Tidak ada job background tersisa. Upload produksi wf37 dan full release gate tetap belum diverifikasi.
