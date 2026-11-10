import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CoreError } from "@starter/shared/core";
import {
  duitkuBaseUrl,
  duitkuGetPaymentMethods,
  duitkuInquiry,
  duitkuMethodCategory,
  duitkuTransactionStatus,
  parseDuitkuCallback,
  signCallback,
  signGetPaymentMethod,
  signInquiry,
  signTransactionStatus,
  verifyDuitkuCallback,
  type DuitkuCredentials,
} from "../services/payment-duitku-wire";

const creds: DuitkuCredentials = {
  merchantCode: "DS1234",
  apiKey: "key-current",
  environment: "sandbox",
};
const previous: DuitkuCredentials = { ...creds, apiKey: "key-previous" };

const hmac = (message: string, key: string) =>
  createHmac("sha256", key).update(message).digest("hex");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
const mockFetch = (response: Response | (() => Response)) =>
  vi.fn(async () => (typeof response === "function" ? response() : response));
const asFetch = (fn: ReturnType<typeof mockFetch>) =>
  fn as unknown as typeof fetch;

async function expectUnavailable(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CoreError);
  expect((error as CoreError).code).toBe("SERVICE_UNAVAILABLE");
}

describe("duitku base url", () => {
  it("picks sandbox and production hosts", () => {
    expect(duitkuBaseUrl("sandbox")).toBe(
      "https://sandbox.duitku.com/webapi/api/merchant/",
    );
    expect(duitkuBaseUrl("production")).toBe(
      "https://passport.duitku.com/webapi/api/merchant/",
    );
  });
});

describe("duitku signatures", () => {
  it("matches HMAC-SHA256 vectors from the docs formulas", () => {
    expect(signGetPaymentMethod(creds, 10000, "2026-11-10 10:00:00")).toBe(
      hmac("DS12341000" + "02026-11-10 10:00:00", "key-current"),
    );
    expect(signInquiry(creds, "ORD-1", 15000)).toBe(
      hmac("DS1234ORD-115000", "key-current"),
    );
    expect(signTransactionStatus(creds, "ORD-1")).toBe(
      hmac("DS1234ORD-1", "key-current"),
    );
    expect(signCallback(creds, "15000", "ORD-1")).toBe(
      hmac("DS123415000ORD-1", "key-current"),
    );
  });

  it("is lowercase hex of 64 chars", () => {
    expect(signInquiry(creds, "ORD-1", 15000)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("duitkuGetPaymentMethods", () => {
  it("posts a signed request and parses the list", async () => {
    const fetchFn = mockFetch(() =>
      jsonResponse({
        responseCode: "00",
        responseMessage: "SUCCESS",
        paymentFee: [
          {
            paymentMethod: "SP",
            paymentName: "SHOPEEPAY QRIS",
            paymentImage: "https://img/sp.png",
            totalFee: "700",
          },
          {
            paymentMethod: "BC",
            paymentName: "BCA Virtual Account",
            paymentImage: "",
            totalFee: "0",
          },
        ],
      }),
    );
    const methods = await duitkuGetPaymentMethods({
      creds,
      amountIdr: 10000,
      datetime: "2026-11-10 10:00:00",
      fetch: asFetch(fetchFn),
    });
    expect(methods).toEqual([
      {
        code: "SP",
        name: "SHOPEEPAY QRIS",
        imageUrl: "https://img/sp.png",
        totalFee: 700,
      },
      { code: "BC", name: "BCA Virtual Account", imageUrl: null, totalFee: 0 },
    ]);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://sandbox.duitku.com/webapi/api/merchant/paymentmethod/getpaymentmethod",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      merchantcode: "DS1234",
      amount: 10000,
      datetime: "2026-11-10 10:00:00",
      signature: signGetPaymentMethod(creds, 10000, "2026-11-10 10:00:00"),
    });
  });

  it("rejects a non-integer amount before any request", async () => {
    const fetchFn = mockFetch(() => jsonResponse({}));
    await expect(
      duitkuGetPaymentMethods({
        creds,
        amountIdr: 100.5,
        datetime: "2026-11-10 10:00:00",
        fetch: asFetch(fetchFn),
      }),
    ).rejects.toBeInstanceOf(CoreError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("treats a malformed list as unavailable", async () => {
    await expectUnavailable(
      duitkuGetPaymentMethods({
        creds,
        amountIdr: 10000,
        datetime: "2026-11-10 10:00:00",
        fetch: asFetch(mockFetch(() => jsonResponse({ paymentFee: "nope" }))),
      }),
    );
  });
});

const inquiryInput = {
  creds,
  merchantOrderId: "ORD-1",
  amountIdr: 15000,
  paymentMethod: "SP",
  productDetails: "Order ORD-1",
  email: "guest@example.com",
  customerVaName: "  A very long customer name here  ",
  callbackUrl: "https://api.example.com/cb",
  returnUrl: "https://app.example.com/ret",
  expiryPeriodMinutes: 30,
};

describe("duitkuInquiry", () => {
  it("posts a signed inquiry and maps the answer", async () => {
    const fetchFn = mockFetch(() =>
      jsonResponse({
        merchantCode: "DS1234",
        reference: "DS1234REF",
        paymentUrl: "https://sandbox.duitku.com/pay/abc",
        qrString: "000201...",
        amount: "15000",
        statusCode: "00",
        statusMessage: "SUCCESS",
      }),
    );
    const result = await duitkuInquiry({
      ...inquiryInput,
      fetch: asFetch(fetchFn),
    });
    expect(result).toEqual({
      reference: "DS1234REF",
      paymentUrl: "https://sandbox.duitku.com/pay/abc",
      vaNumber: null,
      qrString: "000201...",
      amountIdr: 15000,
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://sandbox.duitku.com/webapi/api/merchant/v2/inquiry",
    );
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      merchantCode: "DS1234",
      paymentAmount: 15000,
      paymentMethod: "SP",
      merchantOrderId: "ORD-1",
      expiryPeriod: 30,
      customerVaName: "A very long customer",
      signature: signInquiry(creds, "ORD-1", 15000),
    });
    expect(body.customerVaName.length).toBeLessThanOrEqual(20);
  });

  it("uses the production host for production credentials", async () => {
    const fetchFn = mockFetch(() =>
      jsonResponse({
        statusCode: "00",
        reference: "R",
        paymentUrl: "https://passport.duitku.com/pay/x",
        vaNumber: "8001234",
      }),
    );
    const result = await duitkuInquiry({
      ...inquiryInput,
      creds: { ...creds, environment: "production" },
      fetch: asFetch(fetchFn),
    });
    expect(result.vaNumber).toBe("8001234");
    expect((fetchFn.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://passport.duitku.com/webapi/api/merchant/v2/inquiry",
    );
  });

  it("refuses an answer whose amount differs from the request", async () => {
    await expectUnavailable(
      duitkuInquiry({
        ...inquiryInput,
        fetch: asFetch(
          mockFetch(() =>
            jsonResponse({
              statusCode: "00",
              reference: "R",
              paymentUrl: "https://x/pay",
              amount: "15700",
            }),
          ),
        ),
      }),
    );
  });

  it("maps a non-integer request amount to a validation error", async () => {
    await expect(
      duitkuInquiry({
        ...inquiryInput,
        amountIdr: 10.5,
        fetch: asFetch(mockFetch(() => jsonResponse({}))),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("treats HTTP 5xx, HTTP 4xx and a network error as unavailable", async () => {
    await expectUnavailable(
      duitkuInquiry({
        ...inquiryInput,
        fetch: asFetch(mockFetch(() => jsonResponse({ Message: "boom" }, 503))),
      }),
    );
    await expectUnavailable(
      duitkuInquiry({
        ...inquiryInput,
        fetch: asFetch(mockFetch(() => jsonResponse({ Message: "bad" }, 400))),
      }),
    );
    await expectUnavailable(
      duitkuInquiry({
        ...inquiryInput,
        fetch: (async () => {
          throw new Error("ECONNRESET secret-key");
        }) as unknown as typeof fetch,
      }),
    );
  });

  it("treats a failure statusCode or missing reference as unavailable", async () => {
    await expectUnavailable(
      duitkuInquiry({
        ...inquiryInput,
        fetch: asFetch(
          mockFetch(() =>
            jsonResponse({ statusCode: "01", reference: "R", paymentUrl: "u" }),
          ),
        ),
      }),
    );
    await expectUnavailable(
      duitkuInquiry({
        ...inquiryInput,
        fetch: asFetch(
          mockFetch(() => jsonResponse({ statusCode: "00", paymentUrl: "u" })),
        ),
      }),
    );
  });

  it("treats a non-JSON answer as unavailable", async () => {
    await expectUnavailable(
      duitkuInquiry({
        ...inquiryInput,
        fetch: asFetch(
          mockFetch(() => new Response("<html>", { status: 200 })),
        ),
      }),
    );
  });

  it("does not leak the api key or body in the thrown message", async () => {
    const error = await duitkuInquiry({
      ...inquiryInput,
      fetch: asFetch(
        mockFetch(() => jsonResponse({ Message: "key-current leaked" }, 500)),
      ),
    }).catch((e: unknown) => e as Error);
    expect(error.message).not.toContain("key-current");
    expect(error.message).not.toContain("leaked");
  });
});

describe("duitkuTransactionStatus", () => {
  const call = (body: unknown, status = 200) =>
    duitkuTransactionStatus({
      creds,
      merchantOrderId: "ORD-1",
      fetch: asFetch(mockFetch(() => jsonResponse(body, status))),
    });

  it("maps 00, 01 and 02", async () => {
    const base = {
      merchantOrderId: "ORD-1",
      reference: "REF",
      amount: "15000",
    };
    expect(await call({ ...base, statusCode: "00" })).toEqual({
      statusCode: "00",
      status: "paid",
      reference: "REF",
      amountIdr: 15000,
    });
    expect((await call({ ...base, statusCode: "01" })).status).toBe("pending");
    expect(
      (await call({ ...base, statusCode: "02", amount: "15000.00" })).status,
    ).toBe("failed");
  });

  it("posts a signed request", async () => {
    const fetchFn = mockFetch(() =>
      jsonResponse({ merchantOrderId: "ORD-1", statusCode: "00", amount: "1" }),
    );
    await duitkuTransactionStatus({
      creds,
      merchantOrderId: "ORD-1",
      fetch: asFetch(fetchFn),
    });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://sandbox.duitku.com/webapi/api/merchant/transactionStatus",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      merchantCode: "DS1234",
      merchantOrderId: "ORD-1",
      signature: signTransactionStatus(creds, "ORD-1"),
    });
  });

  it("refuses an answer about another order", async () => {
    await expectUnavailable(
      call({ merchantOrderId: "ORD-2", statusCode: "00", amount: "15000" }),
    );
  });

  it("refuses unknown status codes and unreadable amounts", async () => {
    await expectUnavailable(
      call({ merchantOrderId: "ORD-1", statusCode: "99", amount: "15000" }),
    );
    await expectUnavailable(
      call({ merchantOrderId: "ORD-1", statusCode: "00", amount: "15000.50" }),
    );
    await expectUnavailable(
      call({ merchantOrderId: "ORD-1", statusCode: "00" }),
    );
  });

  it("treats 5xx as unavailable", async () => {
    await expectUnavailable(call({}, 502));
  });
});

describe("parseDuitkuCallback", () => {
  const fields = {
    merchantCode: "DS1234",
    amount: "15000",
    merchantOrderId: "ORD-1",
    resultCode: "00",
    reference: "REF",
    signature: signCallback(creds, "15000", "ORD-1"),
  };

  it("accepts the documented fields and drops unknown keys", () => {
    const parsed = parseDuitkuCallback({ ...fields, extra: "x" });
    expect(parsed).toMatchObject(fields);
    expect(parsed).not.toHaveProperty("extra");
  });

  it("rejects a missing required field or a non-string value", () => {
    expect(parseDuitkuCallback({ ...fields, signature: undefined })).toBeNull();
    expect(parseDuitkuCallback({ ...fields, amount: 15000 })).toBeNull();
    expect(parseDuitkuCallback({ ...fields, merchantOrderId: "" })).toBeNull();
    expect(parseDuitkuCallback(null)).toBeNull();
  });
});

describe("verifyDuitkuCallback", () => {
  const build = (
    key = creds.apiKey,
    overrides: Record<string, string> = {},
  ) => {
    const fields = {
      merchantCode: "DS1234",
      amount: "15000",
      merchantOrderId: "ORD-1",
      resultCode: "00",
      ...overrides,
    };
    const signature = signCallback(
      { merchantCode: fields.merchantCode, apiKey: key },
      fields.amount,
      fields.merchantOrderId,
    );
    return parseDuitkuCallback({ signature, ...fields })!;
  };

  it("accepts a valid signature and exposes the amount", () => {
    expect(
      verifyDuitkuCallback({
        creds: [creds],
        fields: build(),
        expectedAmountIdr: 15000,
      }),
    ).toEqual({
      ok: true,
      amountIdr: 15000,
    });
  });

  it("accepts a signature made with the previous secret", () => {
    expect(
      verifyDuitkuCallback({
        creds: [creds, previous],
        fields: build("key-previous"),
      }),
    ).toEqual({ ok: true, amountIdr: 15000 });
  });

  it("rejects a previous secret that is no longer listed", () => {
    expect(
      verifyDuitkuCallback({ creds: [creds], fields: build("key-previous") }),
    ).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a wrong signature", () => {
    expect(
      verifyDuitkuCallback({ creds: [creds], fields: build("other-key") }),
    ).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const tampered = { ...build(), signature: "0".repeat(64) };
    expect(verifyDuitkuCallback({ creds: [creds], fields: tampered }).ok).toBe(
      false,
    );
    const short = { ...build(), signature: "abc" };
    expect(verifyDuitkuCallback({ creds: [creds], fields: short }).ok).toBe(
      false,
    );
  });

  it("accepts an uppercase hex signature", () => {
    const fields = build();
    expect(
      verifyDuitkuCallback({
        creds: [creds],
        fields: { ...fields, signature: fields.signature.toUpperCase() },
      }).ok,
    ).toBe(true);
  });

  it("rejects a wrong merchant code, even with a valid signature for it", () => {
    expect(
      verifyDuitkuCallback({
        creds: [creds],
        fields: build(creds.apiKey, { merchantCode: "DS9999" }),
      }),
    ).toEqual({ ok: false, reason: "wrong_merchant" });
  });

  it("rejects a signature over a different amount text", () => {
    const fields = { ...build(), amount: "1500" };
    expect(verifyDuitkuCallback({ creds: [creds], fields })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects non-integer amounts even when signed", () => {
    for (const amount of ["15000.00", "15,000", "-1", "1e3", " 15000"]) {
      expect(
        verifyDuitkuCallback({
          creds: [creds],
          fields: build(creds.apiKey, { amount }),
        }),
      ).toEqual({ ok: false, reason: "bad_amount" });
    }
  });

  it("rejects an amount that differs from the expected one", () => {
    expect(
      verifyDuitkuCallback({
        creds: [creds],
        fields: build(),
        expectedAmountIdr: 15700,
      }),
    ).toEqual({ ok: false, reason: "amount_mismatch" });
  });
});

describe("duitkuMethodCategory", () => {
  it("maps codes to categories", () => {
    expect(duitkuMethodCategory("SP")).toBe("qris");
    expect(duitkuMethodCategory("NQ")).toBe("qris");
    expect(duitkuMethodCategory("BC")).toBe("va");
    expect(duitkuMethodCategory("M2")).toBe("va");
    expect(duitkuMethodCategory("OV")).toBe("ewallet");
    expect(duitkuMethodCategory("VC")).toBe("card");
    expect(duitkuMethodCategory("FT")).toBe("retail");
    expect(duitkuMethodCategory("DN")).toBe("paylater");
  });

  it("falls back to other for unknown codes", () => {
    expect(duitkuMethodCategory("ZZ")).toBe("other");
    expect(duitkuMethodCategory("")).toBe("other");
  });
});
