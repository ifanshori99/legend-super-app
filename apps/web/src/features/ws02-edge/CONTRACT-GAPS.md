# Status edge back-office: kontrak yang belum ada (legend-ph62j)

Layar `/kelola/status-edge` (`components/edge-nodes-page.tsx`) memakai tipe lokal di `types.ts` dan `fetchEdgeNodes` di `api.ts`. Di mode mock fungsi itu memanggil `nodes-mock.ts`; di luar mock melempar `ApiError(501, "CONTRACT_PENDING")` dan layar menampilkan "Fitur ini belum tersambung ke server".

| Kebutuhan                                                                                      | Hook                                | Jarak ke kontrak yang ada                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daftar node edge se-tenant: nama node, nama outlet, status tautan cloud, waktu status terakhir | `useEdgeNodes`                      | `getEdgeStatus` hanya menjawab untuk node milik perangkat yang bertanya (satu outlet), tanpa nama node dan tanpa nama outlet. Perlu endpoint cloud daftar node per tenant (izin `report.operational.view`).         |
| Nama node yang dikenali admin teknis ("edge-jakarta-01")                                       | `EdgeNodeRow.name`                  | `edgeNodeSchema` hanya punya `id`, `role`, `version`, `lastHeartbeatAt`. Perlu kolom nama node.                                                                                                                     |
| Peringatan rotasi nomor struk per node                                                         | `EdgeNodesOverview.receiptRunAlert` | `deviceRegistry.receiptRunAlert` dan `receiptRunAlertAt` ada di `getEdgeStatus`, tetapi hanya untuk satu node. Daftar node cloud harus membawa penanda yang sama per node (satu entri per node yang berperingatan). |

## Menu

Entri menu "Status edge" (`nav.ts`) hanya tampil bila `API_MOCK`. Nyalakan untuk semua mode saat API cloud daftar node siap: hapus kondisi `API_MOCK` di `nav.ts`.

## Demo `?demo=` dan `?mock=` (mock)

`?mock=empty|error|offline|slow` (skenario bersama, `lib/mock/control.ts`) berlaku juga di layar ini: `empty` = belum ada node, `error` = baca gagal, `offline` = galat jaringan, `slow` = tertunda 3 detik. `?demo=` tetap didukung.

Tanpa parameter: kondisi peringatan. `normal` (tanpa peringatan), `kosong` (belum ada node), `gagal` (baca gagal), `memuat` (baca tidak pernah selesai), `terputus` (dua node terputus: satu dengan status lama, satu tanpa waktu pembaruan).
