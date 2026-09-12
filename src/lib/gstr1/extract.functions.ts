import { createServerFn } from "@tanstack/react-start";
import { ExtractInvoiceInput, type ExtractInvoiceResult } from "./extract.shared";

export type { ExtractedInvoice, ExtractInvoiceResult } from "./extract.shared";

export const extractInvoiceWithAI = createServerFn({ method: "POST" })
  .inputValidator((value: unknown) => ExtractInvoiceInput.parse(value))
  .handler(async ({ data }) => {
    const { runInvoiceExtraction } = await import("./extract.server");
    return runInvoiceExtraction(data) satisfies Promise<ExtractInvoiceResult>;
  });
