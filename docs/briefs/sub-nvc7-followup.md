# Brief legend-nvc7 lanjutan: dua temuan second opinion (xzzdq P1, l5tvy P2)

Sumber: `/Users/ifanshori99/Projects/legend super app/legend/docs/qa/second-opinion-hris.md`. Latar: `docs/briefs/sub-nvc7.md`. FE = `apps/web/src/features/ws10-hris-employee/`. Tanpa migrasi, tanpa perubahan API. Komentar yang ada jangan dihapus.

## legend-xzzdq (P1 privasi): ganti akun membuka antrean karyawan sebelumnya

Akar: profil `/api/hris/me` di-cache dengan kunci global `["hris","profile"]` (`FE/queries.ts` `hrisKeys.profile`, staleTime 5 menit); `useMyEmployeeId()` (`FE/hooks.ts`) membaca id karyawan dari profil itu. Logout lalu login akun lain di tab yang sama (tanpa reload) memakai profil akun lama, jadi antrean lokal dan alasan koreksi akun lama terlihat, dan tombol Coba lagi/Ubah/Buang jalan atas nama akun lama.

Perbaikan (implementer P1, file miliknya: `FE/queries.ts`, bagian atas `FE/hooks.ts` hingga `useMyEmployeeId`, hook tindakan `useRetryCorrection` dan `useDiscardCorrection`, file baru `FE/identity.ts`, `apps/web/src/components/sign-out-button.tsx`, `apps/web/src/components/auth-form.tsx`):

1. Kunci profil memuat id user sesi: `hrisKeys.profile(userId)`. `useMyHrisProfile()` mengambil id user dari sesi router (root route context `session`, mis. `useRouteContext({ from: "__root__" })`); tanpa sesi, query mati. Kunci turunan sudah memuat employeeId, jadi berhenti bocor bila profil benar.
2. Bersihkan cache privat saat identitas berganti: setelah sign-out sukses dan setelah sign-in sukses, `queryClient.removeQueries({ queryKey: hrisKeys.all })` (atau `clear()` bila lebih tepat; pilih yang paling sempit yang menutup kebocoran).
3. File baru `FE/identity.ts`: `export function canActOnQueued(row: { employeeId: string }, activeEmployeeId: string | null): boolean` (true hanya bila sama dan tidak null). `useRetryCorrection` dan `useDiscardCorrection` menolak (no-op, tanpa kirim, tanpa hapus) bila `canActOnQueued` false; id aktif dibaca saat tindakan.
4. Pastikan e2e mock tetap jalan (sesi mock punya `user.id`; cek `apps/web/src/lib/session*` dan mock).

Test (test-writer): node (`tests/legend-nv3y.test.mjs`): `hrisKeys.profile("a")` != `hrisKeys.profile("b")` dan keduanya di bawah `hrisKeys.all`; `canActOnQueued` (sama, beda, null); alasan: antrean A tidak muncul lewat `queuedFor(queue, B)`.

## legend-l5tvy (P2): antrean penuh membuang pengajuan baru; Ubah menghilangkan lama dan pengganti

Akar: `trimQueue` (`FE/queue.ts`) membuang entri non-refused lebih dulu; saat 20 entri semua refused, satu-satunya kandidat adalah entri yang baru ditambahkan, tapi `useSubmitCorrection` tetap melapor `queued`. Dialog Ubah (`FE/components/correction-dialog.tsx`) menghapus entri lama setelah kirim/antre sukses, jadi pengganti hilang dan penolakan lama ikut hilang.

Perbaikan (implementer P2, file miliknya: `FE/queue.ts`, `FE/components/correction-dialog.tsx`, `useSubmitCorrection` di `FE/hooks.ts`, katalog `packages/shared/src/i18n/messages/id.ts`):

1. `enqueueCorrection` melempar `CorrectionQueueFullError` (kelas diekspor dari `queue.ts`) bila entri baru tidak bisa disimpan: antrean sudah MAX dan tidak ada entri non-refused untuk dibuang. Tidak ada entri yang dibuang diam-diam. Penolakan yang ada tidak pernah dibuang demi entri baru.
2. `useSubmitCorrection` menerima `replaces?: string` (key entri lama). Jalur offline: `replaceQueuedCorrection(replaces, body, employeeId)` yang atomik (hapus lama + tambah baru dalam satu tulis, tidak pernah melampaui batas). Jalur terkirim: setelah server menerima, hapus entri lama. `replaceQueuedCorrection` hanya mengganti entri milik `employeeId` yang sama. Error antrean penuh dilempar sebagai error mutasi (bukan hasil `queued`).
3. Dialog: hapus pemanggilan `removeQueuedCorrection` setelah sukses; kirim `replaces: editing?.key` ke mutasi. Bila error adalah `CorrectionQueueFullError`, tampilkan teks katalog baru `hris.correction.queueFull`: "Antrean penuh oleh pengajuan yang ditolak. Buang atau ubah salah satunya dulu." (judul memakai `errorTitle` yang ada). Entri lama tetap utuh pada kegagalan.

Test (test-writer, `tests/legend-nv3y.test.mjs`): seed 20 entri refused lalu `enqueueCorrection` baru melempar `CorrectionQueueFullError` dan isi antrean tidak berubah; 19 refused + 1 waiting + entri baru: waiting dibuang, semua refused utuh; `replaceQueuedCorrection` pada antrean 20 refused mengganti satu entri (panjang tetap 20, lama hilang, baru ada), key tak dikenal atau milik karyawan lain: antrean tidak berubah; urutan yang dipakai dialog (replace) tidak pernah kehilangan kedua entri. Perbarui test lama `nvc7 a full queue evicts...` bila perilakunya berubah. Fail-first: tulis dulu, harus gagal sebelum implementasi.
