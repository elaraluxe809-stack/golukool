import {
  ExtractInvoiceInput,
  InvoiceSchema,
  type ExtractInvoiceResult,
} from "./extract.shared";

export type { ExtractedInvoice, ExtractInvoiceResult } from "./extract.shared";

/**
 * Stable Lovable Cloud endpoint used by every frontend deployment, including
 * Vercel. The managed LOVABLE_API_KEY exists only in Lovable Cloud and is
 * never required by, or exposed to, the frontend deployment.
 */
export const LOVABLE_INVOICE_EXTRACTION_ENDPOINT =
  "https://project--5821de24-3b30-4f87-9e9b-6f9a9863e549-dev.lovable.app/api/public/extract-invoice";

export async function extractInvoiceWithAI({
  data,
}: {
  data: unknown;
}): Promise<ExtractInvoiceResult> {
  const input = ExtractInvoiceInput.parse(data);

  try {
    const response = await fetch(LOVABLE_INVOICE_EXTRACTION_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    const payload: unknown = await response.json();
    if (payload && typeof payload === "object" && "ok" in payload) {
      const result = payload as {
        ok: unknown;
        invoice?: unknown;
        code?: unknown;
        message?: unknown;
      };

      if (result.ok === true) {
        const invoice = InvoiceSchema.safeParse(result.invoice);
        if (invoice.success) return { ok: true, invoice: invoice.data };
        return {
          ok: false,
          code: "AI_INVALID_JSON",
          message: "Lovable Cloud returned invoice data in an unexpected format.",
        };
      }

      if (result.ok === false && typeof result.code === "string" && typeof result.message === "string") {
        const validCodes = new Set([
          "AI_NOT_CONFIGURED",
          "AI_CREDITS_EXHAUSTED",
          "AI_RATE_LIMIT",
          "AI_GATEWAY_ERROR",
          "AI_EMPTY_RESPONSE",
          "AI_INVALID_JSON",
        ]);
        if (validCodes.has(result.code)) {
          return result as ExtractInvoiceResult;
        }
      }
    }

    return {
      ok: false,
      code: "AI_GATEWAY_ERROR",
      message: `Lovable Cloud extraction failed with status ${response.status}.`,
    };
  } catch {
    return {
      ok: false,
      code: "AI_GATEWAY_ERROR",
      message: "Could not reach the Lovable Cloud invoice extraction service.",
    };
  }
}
