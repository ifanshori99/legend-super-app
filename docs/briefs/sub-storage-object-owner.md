# Sub-brief: storage object owner and source (legend-pszrm)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/storage-object-owner`
(branch `ws/storage-object-owner`). Work only there. Do not commit, push, or run
`pnpm check` / full `pnpm test`. Targeted tests only:
`bash -c 'cd "<worktree>" && pwd && LEGEND_TEST_FILES="src/test/<file>.test.ts" pnpm test'`.
Typecheck/build are run once at the end by the engineer, not by you.

## Goal

`core_storage_objects` records who owns an object and which feature document
uses it. Read access to a private object is decided per object id:

1. The owner (`owner_user_id` = caller) can always read it.
2. Otherwise the caller needs a review code **for the object's `source_kind`**
   over the object's outlet (`snapshot.allows(code, {type:"outlet", id})`).
   `purchasing.invoice.match` does NOT read a reimbursement receipt, etc.
3. `source_kind IS NULL` (legacy or unclassified upload): only the strict
   manager codes in `storageLegacyReadMap[purpose]`.
4. Object of another tenant, missing object, outlet outside the tenant org: deny.

## Shapes (owned by the engineer; already written, import them)

`packages/shared/src/storage/index.ts` (subpath `@starter/shared/storage`):

```ts
export const storageSourceKindSchema = z.enum([
  "purchase_invoice",
  "goods_receipt",
  "expense",
  "cash_deposit",
  "reimbursement", // receipt
  "attendance", // selfie
  "employee_document",
  "employment_contract",
  "leave_request", // document
  "menu_item", // menu_photo
]);
export type StorageSourceKind = z.infer<typeof storageSourceKindSchema>;
/** The purpose each source kind belongs to. */
export const storageSourceKindPurpose: Record<
  StorageSourceKind,
  StoragePurpose
>;
/** Kind used when an upload names none (only purposes with one obvious kind). */
export const storageDefaultSourceKind: Partial<
  Record<StoragePurpose, StorageSourceKind>
>;
// = { selfie: "attendance", menu_photo: "menu_item" }
// uploadStorageMetadataSchema gains `sourceKind: storageSourceKindSchema.optional()`
// and refuses a sourceKind whose purpose differs from `purpose`.
```

DB (`apps/api/src/db/schema/core-storage.ts`), all nullable:
`ownerUserId: text("owner_user_id")`, `sourceKind: varchar("source_kind", {length: 32})`,
`sourceId: uuid("source_id")`. Check: `source_id IS NULL OR source_kind IS NOT NULL`.

## Section A — implementer: `apps/api/src/services/core-storage.ts` + `apps/api/src/routes/core-storage.routes.ts`

- `Authorization` type becomes
  `(action, purpose, outletId, target?: { objectId?: string; sourceKind?: StorageSourceKind | null }) => Promise<boolean>`.
  Export it as `StorageAuthorization`.
- `uploadStorage` deps gain `actorUserId: string` (verified session user id).
  Resolve `sourceKind = input.sourceKind ?? storageDefaultSourceKind[input.purpose] ?? null`;
  call `authorize("upload", purpose, outletId, { sourceKind })`; insert
  `ownerUserId: deps.actorUserId, sourceKind, sourceId: null`. Return value adds nothing.
- `signedStorageUrl` calls `authorize("read", purpose, outletId, { objectId: id })`.
- New export `linkStorageObjectSource(tx, { tenantId, objectId, sourceKind, sourceId, ownerUserId? })`:
  one `UPDATE ... RETURNING id` setting `source_kind`, `source_id`, and `owner_user_id`
  (only when `ownerUserId` is given) WHERE tenant + id + `purpose = storageSourceKindPurpose[kind]`
  - `source_id IS NULL` + `(source_kind IS NULL OR source_kind = kind)`. Zero rows ->
    `throw new CoreError("VALIDATION", "The file cannot be attached here.")` (check the
    CoreError code union for the right validation code). `tx` is the caller's tenant transaction.
- Routes: resolver result type gains `actorUserId: string`; upload passes it as
  `deps.actorUserId`. Multer limits: `fields: 3`, `parts: 4` (new `sourceKind` field).
  Router stays unmounted.

## Section B — implementer: `apps/api/src/services/core-storage-access.ts`

- Replace `storagePermissionMap` with:
  - `storageSourcePermissionMap: Record<StorageSourceKind, { upload: PermissionCode[]; read: PermissionCode[] }>`:
    purchase_invoice up [purchasing.request.create, purchasing.invoice.match] read [purchasing.invoice.match];
    goods_receipt up [inventory.stock.receive] read [purchasing.invoice.match, inventory.stock.receive];
    expense up [accounting.expense.request] read [accounting.expense.approve];
    cash_deposit up [accounting.cash_deposit.record] read [accounting.reconcile];
    reimbursement up [self.reimbursement.request] read [hr.reimbursement.approve];
    attendance up [self.attendance.clock] read [hr.attendance.manage, hr.attendance_correction.approve];
    employee_document and employment_contract up [hr.employee.manage] read [hr.employee.view];
    leave_request up [self.leave.request] read [hr.leave.approve];
    menu_item up [menu.item.manage] read [menu.item.view].
  - `storageLegacyUploadMap[purpose]` = the old per-purpose upload lists (upload with no kind).
  - `storageLegacyReadMap[purpose]` (strict): selfie [hr.attendance.manage], document
    [hr.employee.manage], receipt [accounting.reconcile], menu_photo [menu.item.manage].
- Resolver: actor = `getAuth(req).user.id`; return `actorUserId`.
  - Read request (`req.params.objectId` is a string): validate it with
    `storageObjectIdSchema`; load the row (`tenantId, outletId, id, purpose, ownerUserId, sourceKind`)
    with `withTenant(db, establishScopedTenantContext(tenant, {kind:"tenant"}), ...)`
    filtered by tenant + id. Missing / not allowed -> the same `PERMISSION_DENIED`
    AccessError as today (no existence oracle). Allowed -> scope `{kind:"outlets", outletIds:[row.outletId]}`.
  - `authorize("read", ...)`: requires `target.objectId` equal (case-insensitive) to the loaded
    row id, purpose and outlet equal to the row's, then rules 1–4 of the Goal.
    Kind present but not matching the row purpose -> deny.
  - Upload: scope = outlets where any upload code for the purpose (union over its kinds and the
    legacy list) is allowed; `authorize("upload", purpose, outlet, {sourceKind})` checks the
    kind's upload codes (or the legacy list when kind is null) and kind/purpose agreement.
- Keep the header comment accurate. Keep error texts.

## Section C — implementer: linkers (fill the columns only)

Call `linkStorageObjectSource` inside the existing transaction where the document row is inserted:

- `apps/api/src/services/hris-contract.service.ts`: employee document insert (~L606) ->
  kind `employee_document`, sourceId = new document id, ownerUserId = the employee's `userId`
  when not null. Contract insert with `fileObjectId` (~L537) -> `employment_contract`, same owner rule.
- `apps/api/src/services/hris-leave-request.service.ts`: when a leave request stores
  `attachmentKey` (~L836) -> kind `leave_request`, sourceId = leave request id, ownerUserId = requester.
  Also in `assertAttachmentUsable` (~L460): refuse an object whose `owner_user_id` is set and
  differs from the requesting user (update the comment at ~L456).
- Do not change permissions, payroll, or UI. Run the existing tests of the files you touched.

## Section D — test-writer: `apps/api/src/test/core-storage-access.test.ts`

Existing tests use a fake object id for reads; reads now need a real row. Seed rows with
the owner pool (`asOwner`) into `core_storage_objects` with owner/source columns. Keep every
existing scenario's intent; update to the new map names. Add (each refusal with a positive control):

- Purchasing reviewer (`purchasing.invoice.match`, outlet A) refused a `reimbursement` receipt at A;
  allowed a `purchase_invoice` receipt at A.
- Reimbursement approver (`hr.reimbursement.approve` at A) reads a reimbursement receipt at A;
  refused the same kind at outlet B.
- Employee (only `self.attendance.clock` + `self.reimbursement.request`) reads own selfie and own
  receipt; refused another user's selfie/receipt.
- Object of the second tenant (`createSecondTenant`) refused even for a tenant-wide grant.
- Legacy row (all three columns null): refused for `hr.attendance_correction.approve` and
  `purchasing.invoice.match`; allowed for `hr.attendance.manage` (selfie) and `accounting.reconcile` (receipt).
- Upload: sourceKind `reimbursement` needs `self.reimbursement.request`; `purchasing.request.create`
  cannot upload as `reimbursement`; mismatched kind/purpose refused.
- Catalog test: every code in the three maps exists in `PERMISSION_CODES`.

## Section E — test-writer: `core-storage-service.test.ts`, `core-storage-routes.test.ts`, `core-storage-schema.test.ts`

Update for `actorUserId` and the new `authorize` target. Add: upload stores `owner_user_id` =
actor and default kind (`selfie` -> `attendance`, receipt with no kind -> null);
`linkStorageObjectSource` sets kind/id/owner once, refuses a second link, refuses wrong purpose,
refuses another tenant's object; schema test for the new columns and check constraint.

## Round 2 (architect findings + typecheck)

`linkStorageObjectSource` (engineer, done) now takes `outletId: string` (required: the object's
outlet must equal it) and `allowUnowned?: boolean` (default false: the object's `owner_user_id`
must equal `actorUserId`; true also accepts a null owner). Receipts now need a `sourceKind` on
upload (`storageLegacyUploadMap.receipt = []`).

### F1 — implementer: link callers + uploadStorage callers

- `hris-contract.service.ts`: both link calls pass `outletId: employee.homeOutletId`, no `allowUnowned`.
- `hris-leave-request.service.ts`: link call passes `outletId: own.homeOutletId` (or the variable
  holding the requester's home outlet) and `allowUnowned: true` (its 24 h freshness check covers legacy rows).
- `menu-media.service.ts` (~L136) and `menu-print.service.ts` (~L453): pass `actorUserId` in the
  `uploadStorage` deps (the function's verified actor argument). menu-media: no kind change
  (menu_photo defaults to `menu_item`). menu-print: leave the kind unset.

### F2 — test-writer: fixtures and tests

- `core-storage-access.test.ts` ~L456-458: typecheck error, readonly tuples passed to `string[]`;
  widen the helper parameter to `readonly string[]`. Upload of a receipt with no kind is now refused for everyone.
- `hris-db.test.ts`, `hris-leave-attachment-db.test.ts`, `core-storage-service.test.ts`: link calls
  need `outletId`; HR links of a null-owner object are now refused (seed HR fixtures with
  `owner_user_id` = the HR actor); add: object at another outlet than the employee's home outlet is refused;
  leave still accepts a fresh null-owner object at the home outlet.

### F3 — implementer: backfill in `apps/api/drizzle/0177_storage_object_owner.sql` (append only)

Follow the FORCE-RLS lift pattern of `0171_access_perm_backfill.sql` (NO FORCE then FORCE back, per
table touched, statement-breakpoints) for `core_storage_objects`, `employment_contracts`,
`employee_documents`, `leave_requests`, `employees` — only lift tables that have FORCE (check the
earlier migrations). Then fill legacy links, each only `WHERE o.source_id IS NULL`, one row per
object (`DISTINCT ON (tenant_id, object id)` ordered by created/uploaded time, id):

1. `employment_contracts.file_object_id` -> kind `employment_contract`, source = contract id;
2. `employee_documents.storage_object_id` -> `employee_document`, source = document id;
3. `leave_requests.attachment_key` (varchar; match `o.id::text = lower(attachment_key)`) -> `leave_request`.
   Owner = `employees.user_id` of the row's employee when not null, else keep. Also require
   `o.purpose = 'document'`. Do not touch the generated statements above. Run
   `LEGEND_TEST_FILES="src/test/migration-force-rls-guard.test.ts src/test/migration-fk-force-rls.test.ts src/test/core-storage-schema.test.ts"`.

## Round 3 (architect verify)

`allowUnowned` is removed: `linkStorageObjectSource` always requires `owner_user_id = actorUserId`.
Leave `assertAttachmentUsable` now refuses any object whose owner is not the requester (null
included). Reason: the unowned printed-menu PDF (`actorUserId: null`) could be claimed as a leave attachment.

### G — test-writer

Update `core-storage-service.test.ts` (drop `allowUnowned` from the `link` helper; the unowned case is
refused with no opt-in) and `hris-leave-attachment-db.test.ts` (fresh null-owner object at the home
outlet is now refused 422, nothing created; seed fixtures that must pass with `owner_user_id` = requester).
Add one leave test: an unowned `document` object (like a menu-print render) is refused.
