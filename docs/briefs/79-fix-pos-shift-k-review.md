# Brief: engineer — perbaikan review K ws/pos-shift (580d0db)

Peran: `~/.agents/team/roles/engineer.md`. Worktree `.worktrees/pos-shift`, cabang `ws/pos-shift`. Jangan baca `.env*`, jangan `pkill`.

## Temuan reviewer Opus
1. Sedang — `services/pos-cash-guard.ts:69-82`: shift terbuka dicari per kasir+outlet, `caller.deviceId` diabaikan; `computeShiftAggregates` (`pos-shift-support.ts:259-274`) hitung tunai per kasir, bukan per laci. Kasir login di perangkat B / back-office tanpa token perangkat bisa terima tunai yang tercatat di shift A. Fix: tunai wajib `caller.deviceId`, guard filter `posShifts.deviceId = caller.deviceId`, simpan `shift_id` (atau device) di tender/refund/void, agregat per shift.
2. Sedang — `services/pos-order-corrections.ts:230-239`, `:446-451`: refund/void tunai tidak cek isi laci → kas seharusnya negatif → `submitPosShiftCount` 409 (`expectedCashOf` RangeError), shift dan Tutup Hari macet. Fix: dalam lock shift, hitung kas seharusnya sebelum insert; tolak 409 bila tunai > kas laci.
3. Rendah — `services/pos-shift.service.ts:886`, `:1172`: persetujuan PIN menyimpan `approvalRequestId` UUID dari klien tanpa cek. Fix: simpan `ulidToUuid(override.id)`.
4. Rendah — `services/pos-shift.service.ts:526-530`: penolakan kas keluar/setoran > kas laci bocorkan kas seharusnya (melanggar hitung buta POS-03), tanpa jejak. Fix: catat penolakan di audit + pesan umum.
5. Migration bentrok dengan main (0063–0067): merge `main`, renumber via drizzle-kit.

## Temuan architect
(menyusul)

## Bukti selesai
Test regresi per temuan; gerbang penuh; reviewer subagent konteks segar; commit lokal. Laporan: SHA, test, migration lama→baru. Catatan: UI `ui/pos-kasir-shift` mengikuti kontrak cabang ini; laporkan bila kontrak berubah (mis. tunai wajib deviceId).
