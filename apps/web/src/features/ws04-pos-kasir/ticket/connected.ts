import { API_MOCK } from "@/lib/api/mock-flag";

/**
 * The ticket sale only runs in mock mode until the contract has a payment
 * (see ../CONTRACT-GAPS.md). Kept in its own light file so the nav entry can
 * read it without loading the mock engine.
 */
export const TICKET_SALE_CONNECTED = API_MOCK;
