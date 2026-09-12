import { z } from "zod";

export const RowSchema = z.object({
  rate: z.number(),
  taxable_value: z.number().nullable().default(0),
  igst: z.number().nullable().default(0),
  cgst: z.number().nullable().default(0),
  sgst: z.number().nullable().default(0),
});

export const HsnSchema = z.object({
  hsn: z.string().nullable().default(""),
  description: z.string().nullable().default(""),
  uqc: z.string().nullable().default(""),
  quantity: z.number().nullable().default(0),
  rate: z.number().nullable().default(0),
  taxable_value: z.number().nullable().default(0),
  igst: z.number().nullable().default(0),
  cgst: z.number().nullable().default(0),
  sgst: z.number().nullable().default(0),
  cess: z.number().nullable().default(0),
});

export const InvoiceSchema = z.object({
  invoice_no: z.string().nullable(),
  invoice_date: z.string().nullable(),
  supplier_gstin: z.string().nullable().default(null),
  customer_name: z.string().nullable(),
  customer_gstin: z.string().nullable(),
  place_of_supply: z.string().nullable(),
  invoice_value: z.number().nullable(),
  rows: z.array(RowSchema).default([]),
  hsn: z.array(HsnSchema).default([]),
});

export type ExtractedInvoice = z.infer<typeof InvoiceSchema>;

export type ExtractInvoiceResult =
  | { ok: true; invoice: ExtractedInvoice }
  | {
      ok: false;
      code:
        | "AI_NOT_CONFIGURED"
        | "AI_CREDITS_EXHAUSTED"
        | "AI_RATE_LIMIT"
        | "AI_GATEWAY_ERROR"
        | "AI_EMPTY_RESPONSE"
        | "AI_INVALID_JSON";
      message: string;
    };

export const ExtractInvoiceInput = z.object({
  fileName: z.string().trim().min(1).max(255),
  text: z.string().trim().min(1).max(45000),
});

export type ExtractInvoiceInput = z.infer<typeof ExtractInvoiceInput>;
