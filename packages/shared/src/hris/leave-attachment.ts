import { z, dataResponseSchema } from "../core/index.ts";
import { defineEndpoint } from "../api/index.ts";
import { storageObjectIdSchema } from "../storage/index.ts";

/** Multipart upload with one binary field named `file` (PDF, JPEG, PNG or WebP; max 10 MiB). */
export const uploadLeaveAttachment = defineEndpoint({
  method: "POST",
  path: "/api/hris/leave/attachments",
  response: dataResponseSchema(
    z.strictObject({ attachmentUploadRef: storageObjectIdSchema }),
  ),
});
