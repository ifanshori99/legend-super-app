import { uploadLeaveAttachment } from "@starter/shared/hris";
import { apiErrorBodySchema } from "@starter/shared/core";
import { API_URL } from "@/lib/env";
import { ApiError, NETWORK_ERROR_MESSAGE } from "@/lib/api/errors";

export async function uploadLeaveFile(file: File): Promise<string> {
  const body = new FormData();
  body.set("file", file);
  let response: Response;
  try {
    response = await fetch(new URL(uploadLeaveAttachment.path, API_URL), {
      method: "POST",
      credentials: "include",
      headers: { accept: "application/json" },
      body,
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", NETWORK_ERROR_MESSAGE);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = apiErrorBodySchema.safeParse(payload);
    const error = parsed.success ? parsed.data.error : undefined;
    throw new ApiError(
      response.status,
      error?.code ?? "HTTP_ERROR",
      error?.message ?? `Request failed with status ${response.status}.`,
      error?.details,
    );
  }
  return uploadLeaveAttachment.response.parse(payload).data.attachmentUploadRef;
}
