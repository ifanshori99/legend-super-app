import type { ApiErrorBody } from "@starter/shared/types";

// A failed API call, carrying the API's error envelope. Kept free of framework
// imports and of TypeScript-only syntax (no parameter properties), so the mock
// runtime and the unit tests load it directly with native Node type stripping.
export class ApiError extends Error {
  status: number;
  code: string;
  details?: ApiErrorBody["error"]["details"];

  constructor(
    status: number,
    code: string,
    message: string,
    details?: ApiErrorBody["error"]["details"],
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const NETWORK_ERROR_MESSAGE =
  "We couldn't reach the server. Check your connection and try again.";
