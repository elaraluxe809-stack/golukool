import { extractInvoiceWithAI } from "./extract.functions";
import { parseInvoicePdf, readPdfText, type InvoiceRecord, type RateSplit } from "./parser";
import { stateFromGstin, normalizePlaceOfSupply, isValidGstin, STATE_CODES } from "./states";

function normalizeGstin(value: string | null | undefined): string | null {
  const gstin = value?.toUpperCase().replace(/\s+/g, "").trim();
  return gstin || null;
}

function stateCodeFromPos(pos: string | null): string | null {
  if (!pos) return null;
  const match = pos.match(/^(\d{2})-/);
  return match?.[1] ?? null;
}

function stateCodeFromGstin(gstin: string | null): string | null {
  return gstin ? gstin.slice(0, 2) : null;
}

export async function parseInvoiceAI(file: File): Promise<InvoiceRecord> {
  const text = (await readPdfText(file)).slice(0, 45000);
  if (!text.trim()) {
    throw new Error("No readable PDF text found. Please upload a text-based invoice PDF.");
  }

  const ai = await extractInvoiceWithAI({
    data: {
      fileName: file.name,
      text,
    },
  });

  if (!ai.ok) {
    if (ai.code === "AI_CREDITS_EXHAUSTED") {
      const fallback = await parseInvoicePdf(file);
      fallback.issues.unshift("AI unavailable: extracted with local parser");
      return fallback;
    }
    throw Object.assign(new Error(ai.message), { code: ai.code });
  }

  const invoice = ai.invoice;

  const rateSplits: RateSplit[] = (invoice.rows ?? []).map((r) => ({
    rate: Number(r.rate) || 0,
    taxableValue: Number(r.taxable_value) || 0,
    igst: Number(r.igst) || 0,
    cgst: Number(r.cgst) || 0,
    sgst: Number(r.sgst) || 0,
  }));

  const hsnItems = (invoice.hsn ?? []).map((h) => ({
    hsn: (h.hsn ?? "").toString().trim(),
    description: (h.description ?? "").toString().trim(),
    uqc: ((h.uqc ?? "").toString().trim() || "OTH").toUpperCase(),
    quantity: Number(h.quantity) || 0,
    rate: Number(h.rate) || 0,
    taxableValue: Number(h.taxable_value) || 0,
    igst: Number(h.igst) || 0,
    cgst: Number(h.cgst) || 0,
    sgst: Number(h.sgst) || 0,
    cess: Number(h.cess) || 0,
  })).filter((h) => h.hsn || h.taxableValue > 0);

  const supplierGstin = normalizeGstin(invoice.supplier_gstin);
  const customerGstin = normalizeGstin(invoice.customer_gstin);

  const category: "B2B" | "B2C" = customerGstin ? "B2B" : "B2C";

  const supplierState = supplierGstin ? stateFromGstin(supplierGstin) : null;
  const normalizedPos = normalizePlaceOfSupply(invoice.place_of_supply);
  const customerStateCode = stateCodeFromGstin(customerGstin);
  const customerState = customerStateCode ? STATE_CODES[customerStateCode] : null;

  // POS is taken from the invoice. Customer GSTIN state is only a transparent
  // fallback when POS is absent; it is never used to replace an explicit POS.
  const placeOfSupply = normalizedPos ?? (
    customerStateCode && customerState
      ? `${customerStateCode}-${customerState}`
      : null
  );

  const supplierStateCode = stateCodeFromGstin(supplierGstin);
  const posStateCode = stateCodeFromPos(placeOfSupply);
  const supplyType: InvoiceRecord["supplyType"] =
    supplierStateCode && posStateCode
      ? supplierStateCode === posStateCode
        ? "Intrastate"
        : "Interstate"
      : "Unknown";

  const rec: InvoiceRecord = {
    fileName: file.name,
    invoiceNumber: invoice.invoice_no?.trim() || null,
    invoiceDate: invoice.invoice_date?.trim() || null,
    customerGstin,
    customerName: invoice.customer_name?.trim() || null,
    placeOfSupply,
    invoiceValue: invoice.invoice_value ?? null,
    supplierGstin,
    supplierState,
    rateSplits,
    hsnItems,
    category,
    supplyType,
    issues: [],
    rawText: text,
  };

  // Deterministic validation. Never silently alter extracted tax amounts.
  if (!rec.invoiceNumber) rec.issues.push("Missing invoice number");
  if (!rec.invoiceDate) rec.issues.push("Missing invoice date");
  if (rec.invoiceValue == null) rec.issues.push("Missing invoice value");
  if (!rec.supplierGstin) rec.issues.push("Missing supplier GSTIN");
  else if (!isValidGstin(rec.supplierGstin)) rec.issues.push("Invalid supplier GSTIN checksum/format");

  if (customerGstin && !isValidGstin(customerGstin)) {
    rec.issues.push("Invalid customer GSTIN checksum/format");
  }

  if (!normalizedPos) {
    rec.issues.push(
      customerGstin
        ? "Place of supply not found; temporarily inferred from customer GSTIN"
        : "Missing place of supply",
    );
  }

  if (!supplierStateCode || !posStateCode) {
    rec.issues.push("Cannot determine supply type: supplier state or place of supply is missing");
  }

  if (rec.rateSplits.length === 0) rec.issues.push("No GST rate/tax amounts detected");

  for (const r of rec.rateSplits) {
    const totalTax = r.igst + r.cgst + r.sgst;
    const expected = (r.taxableValue * r.rate) / 100;
    if (r.taxableValue > 0 && Math.abs(totalTax - expected) > Math.max(2, expected * 0.02)) {
      rec.issues.push(
        `Tax mismatch @${r.rate}%: taxable ${r.taxableValue.toFixed(2)}, tax ${totalTax.toFixed(2)}, expected ~${expected.toFixed(2)}`,
      );
    }
  }

  // Validate tax type against supplier state and POS. Do not rebalance values.
  const hasIgst = rateSplits.some((r) => r.igst > 0);
  const hasCgst = rateSplits.some((r) => r.cgst > 0);
  const hasSgst = rateSplits.some((r) => r.sgst > 0);
  const hasCgstSgst = hasCgst || hasSgst;

  if (supplyType === "Interstate" && hasCgstSgst) {
    rec.issues.push("Interstate supply should use IGST; CGST/SGST detected");
  }
  if (supplyType === "Interstate" && !hasIgst && rec.rateSplits.some((r) => r.taxableValue > 0)) {
    rec.issues.push("Interstate supply has no IGST detected");
  }
  if (supplyType === "Intrastate" && hasIgst) {
    rec.issues.push("Intrastate supply should use CGST+SGST; IGST detected");
  }
  if (supplyType === "Intrastate" && rec.rateSplits.some((r) => r.taxableValue > 0) && (!hasCgst || !hasSgst)) {
    rec.issues.push("Intrastate supply should contain both CGST and SGST");
  }

  // Taxable + tax vs invoice value. Keep a small fixed tolerance for rounding,
  // rather than silently accepting a large percentage difference.
  if (rec.invoiceValue != null && rec.rateSplits.length) {
    const sum = rec.rateSplits.reduce(
      (a, r) => a + r.taxableValue + r.igst + r.cgst + r.sgst,
      0,
    );
    if (Math.abs(sum - rec.invoiceValue) > Math.max(2, Math.min(10, rec.invoiceValue * 0.001))) {
      rec.issues.push(
        `Invoice total mismatch: rows sum ${sum.toFixed(2)} vs invoice value ${rec.invoiceValue.toFixed(2)}`,
      );
    }
  }

  return rec;
}
