// The JSON contract between the API and the web app. Timestamps cross the wire
// as ISO strings, so these are the shapes the browser actually receives.

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: { field: string; message: string }[];
    /** PAYSLIP_PIN_INVALID (403): attempts left before the PIN locks. */
    remainingAttempts?: number;
    /** PAYSLIP_PIN_LOCKED (423): ISO datetime the lock ends. */
    lockedUntil?: string;
  };
};

export type PageMeta = { limit: number; offset: number; hasMore: boolean };

export type Paginated<T> = { data: T[]; meta: PageMeta };

export type DataResponse<T> = { data: T };

/** Platform-only: the Kirimdev sender number a tenant or outlet sends from. */
export type KirimdevSenderMappingDto = {
  id: string;
  tenantId: string;
  /** null = tenant-wide sender. */
  outletId: string | null;
  phoneNumberId: string;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};
