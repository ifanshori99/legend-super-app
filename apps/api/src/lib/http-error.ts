// Expected HTTP failures. The error handler turns these into the shared JSON
// envelope: { error: { code, message } }.
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public context?: {
      acknowledgedBy: { displayName: string };
      acknowledgedAt: string;
    },
  ) {
    super(message);
    this.name = "HttpError";
  }
}
