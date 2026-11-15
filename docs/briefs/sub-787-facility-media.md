# Brief 787: real photo + signature upload on facility screens

Beads: legend-wf37, legend-xxx6. Base: ws/media-screens-upload (stock screens already wired, commit 94a165b19 — copy its pattern).

## Reference pattern (do not re-invent)

- Client: `apps/web/src/features/storage/{api,hooks,queries,image}.ts` — `uploadStorageFile({purpose, sourceKind, outletId, file, signal})`, `normalizeImageFile(file)`, `useUploadStorageFile()`, `useStorageObjectUrl(id)`.
- UI: `apps/web/src/features/ws06-inventory/components/photo-field.tsx` (`PhotoField`, `StoragePhoto`, `photoUploadErrorKey`) and its use in `waste-form-dialog.tsx:161` and `ws06-purchasing/components/petty-page.tsx`.
- Behaviour required: uploading state (busy indicator, submit disabled until upload done), failure message from API error (413 fileTooLarge, 415/422 fileWrongType, 503 scanner unavailable, network) with "Coba lagi" retry, AbortController on unmount/replace, submit sends the real `id` returned by the API. No data URL or random id ever sent. No third-party service (founder Q30: scanning stays on our server).
- Mock mode (`API_MOCK` / `?mock=`): the storage client already handles mock; make each feature's `mock.ts` accept the minted ids.

## New source kinds (contract slice, one implementer)

All purpose `receipt` (private evidence photo, same as `waste_log`):

- `cleaning_task` — cleaning completion photo.
- `maintenance_ticket` — breakdown ticket photo.
- `checklist_evidence` — checklist item photo AND signature image (signature canvas exported to PNG Blob).
  Files: `packages/shared/src/storage/index.ts` (enum + `storageSourceKindPurpose`), `apps/api/src/services/core-storage-access.ts` (`storageSourcePermissionMap`: upload = the permission code(s) the matching facility route already requires; read = same plus the manager/review codes of that feature), `apps/api/src/db/schema/core-storage.ts` check constraint, then `pnpm db:generate` → rename to `0373_storage_facility_source_kinds.sql` (fix `drizzle/meta` journal tag too), inspect SQL (only DROP/ADD of `core_storage_objects_source_kind_check`). Plus API test: crew with the facility permission can upload each kind; crew without it gets 403; read rules.

## Screens (one implementer each, do not touch other screens' files)

1. Cleaning: `apps/web/src/features/facility-staff/components/cleaning-dialog.tsx` (lines ~127, 225-228), `features/facility-staff/mock.ts`. sourceKind `cleaning_task`.
2. Breakdown ticket: `apps/web/src/features/operations-equipment/components/ticket-form-dialog.tsx` (~145-147) + its mock. sourceKind `maintenance_ticket`.
3. Checklist: `apps/web/src/features/operations-checklist/components/checklist-item-card.tsx` (~92, 130-131, 190-194), `signature-field.tsx` (export canvas to PNG Blob → upload; typed name alone is not a signature image — keep existing rule for name-only if the API allows it, else require ink). sourceKind `checklist_evidence`.
   Copy: Indonesian, via the existing i18n catalog of each feature (no hard-coded strings outside the catalog). Reuse `PhotoField` if it fits; if it lives in ws06-inventory and must be shared, import it, do not copy it.

## Tests (test-writer)

- Fail-first unit/source test like `tests/media-screens-upload.test.mjs` (read it): asserts the 3 components call `uploadStorageFile` with the right sourceKind, never `newIdempotencyKey()` for a media id, and handle retry.
- E2E mock: extend `e2e/legend-1oi9.mock.spec.ts`, `legend-cz9g.mock.spec.ts`, `legend-td4f.mock.spec.ts` (or one new `e2e/legend-wf37.mock.spec.ts`): pick photo → upload → submit; route-intercept storage upload to 413 → error + retry shown. Do NOT run e2e (agent runs it once at the end).

## Rules

- Run nothing heavy yourself (no tsc, vitest, e2e, build) unless told; agent holds the heavy token. Prettier on your files is fine: `pnpm exec prettier --write <files>`.
- Do not commit. Report changed files + anything uncertain.

## Round 2 fixes (ui-auditor findings)

Shared `PhotoField` new optional props (owner: implementer A; B and C only pass them): `required?: boolean` (sets `aria-required` on input + visible required marker, no "(opsional)"), `capture?: "environment" | "user"` (passed to input), `contextLabel?: string` (appended to button aria-labels, e.g. "Pilih foto — Lantai bar"). Also A: status text in an always-mounted `aria-live="polite"` container (text changes, node stays); Remove button label during upload = "Batalkan unggah" (catalog key).

- A (photo-field.tsx + ticket-form-dialog.tsx + ops-equipment.ts catalog): ticket missing-photo error shown via PhotoField `photoError` next to the field (not footer alert), focus moves to field; upload-failed case says upload failed, not "lampirkan"; `required` on; `capture="environment"`; delete unused keys `ticketForm.photoChoose/photoSelected/photoAlt`.
- B (cleaning-dialog.tsx + facility-staff.ts catalog): when photo upload failed, show sentence next to the disabled Complete button ("Hapus atau unggah ulang foto untuk menyelesaikan."); confirm outlet can be null — if yes show reason, else drop the `!outlet` branch; `capture="environment"`; fix hint to match reality (image resized automatically, no "maks 5 MB" lie).
- C (checklist-item-card.tsx + signature-field.tsx + ops-checklist.ts catalog + DESIGN tokens file): (1) no raw hex — add tokens `--signature-ink` / `--signature-paper` (fixed black/white, not theme-dependent; export must be legible) in the tokens css and read via getComputedStyle; `node scripts/ci/color.mjs` must pass. (2) lock pad + Clear while uploading/saving (`disabled` prop, pointer-events-none, aria-disabled) and re-check revision after upload. (3)+(4) keyboard alternative: if no ink but a typed name, render the name onto the canvas (script-like system font, token ink) and upload that image as the signature; so typed name works again and the name field is live; drop duplicated "(opsional)" from the catalog string (FormField adds it). (5) PhotoField `contextLabel={item label}`, `capture="environment"`.
