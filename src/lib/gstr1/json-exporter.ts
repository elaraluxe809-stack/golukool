import type { InvoiceRecord } from "./parser";
import { isValidGstin } from "./states";

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/;

const MONTHS: Record<string, string> = {
  JAN: "01", JANUARY: "01", FEB: "02", FEBRUARY: "02", MAR: "03", MARCH: "03",
  APR: "04", APRIL: "04", MAY: "05", JUN: "06", JUNE: "06", JUL: "07", JULY: "07",
  AUG: "08", AUGUST: "08", SEP: "09", SEPT: "09", SEPTEMBER: "09",
  OCT: "10", OCTOBER: "10", NOV: "11", NOVEMBER: "11", DEC: "12", DECEMBER: "12",
};

function normalizeDate(d: string | null | undefined): string | null {
  if (!d) return null;
  const s = d.trim();
  let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);
  if (m) {
    const yy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return formatDate(m[1], m[2], yy);
  }
  m = s.match(/^(\d{1,2})[-\/\s]([A-Za-z]+)[-\/\s](\d{2}|\d{4})$/);
  if (m) {
    const mm = MONTHS[m[2].toUpperCase()];
    if (mm) {
      const yy = m[3].length === 2 ? `20${m[3]}` : m[3];
      return formatDate(m[1], mm, yy);
    }
  }
  m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return formatDate(m[3], m[2], m[1]);
  return null;
}

function formatDate(day: string, month: string, year: string): string | null {
  const dd = Number(day);
  const mm = Number(month);
  const yyyy = Number(year);
  if (yyyy < 1900 || mm < 1 || mm > 12 || dd < 1) return null;
  const daysInMonth = new Date(yyyy, mm, 0).getDate();
  if (dd > daysInMonth) return null;
  return `${String(dd).padStart(2, "0")}-${String(mm).padStart(2, "0")}-${String(yyyy).padStart(4, "0")}`;
}

function fpFromDate(d: string | null | undefined): string | null {
  const n = normalizeDate(d);
  if (!n) return null;
  const m = n.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  return m ? `${m[2]}${m[3]}` : null;
}

function posCode(place: string | null | undefined, gstin: string | null | undefined): string | null {
  if (place) {
    const m = place.match(/^(\d{1,2})/);
    if (m) return m[1].padStart(2, "0");
  }
  if (gstin) return gstin.slice(0, 2);
  return null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface JsonExportOptions {
  supplierGstin: string;
  filingPeriod?: string;
}

export function buildGstr1Json(records: InvoiceRecord[], opts: JsonExportOptions) {
  const supplierGstin = opts.supplierGstin.trim().toUpperCase();
  if (!isValidGstin(supplierGstin)) {
    throw new Error("Invalid supplier GSTIN. Enter a valid 15-character GSTIN.");
  }
  const supplierStateCode = supplierGstin.slice(0, 2);
  const b2bRecords = records.filter((record) => record.category === "B2B");
  const validationErrors: string[] = [];
  const preparedInvoices: Array<{
    ctin: string;
    invoice: {
      inum: string;
      idt: string;
      val: number;
      pos: string;
      rchrg: "N";
      inv_typ: "R";
      itms: Array<{ num: number; itm_det: Record<string, number> }>;
    };
  }> = [];

  for (const record of b2bRecords) {
    const invoiceLabel = record.invoiceNumber?.trim() || record.fileName || "Unnamed invoice";
    const ctin = record.customerGstin?.trim().toUpperCase() ?? "";
    const invoiceDate = normalizeDate(record.invoiceDate);
    const pos = posCode(record.placeOfSupply, ctin);
    const invoiceValue = record.invoiceValue;
    const reasons: string[] = [];

    if (!ctin || !isValidGstin(ctin)) reasons.push("recipient GSTIN is missing or invalid");
    if (!record.invoiceNumber?.trim()) reasons.push("invoice number is missing");
    if (!invoiceDate) reasons.push("invoice date is missing or invalid (expected DD-MM-YYYY)");
    if (typeof invoiceValue !== "number" || !Number.isFinite(invoiceValue)) {
      reasons.push("invoice value is missing or invalid");
    }
    if (!pos || !/^\d{2}$/.test(pos)) reasons.push("place of supply is missing or invalid");
    if (!record.rateSplits.length) reasons.push("no taxable value or GST rate rows found");

    const interstate = pos !== null && pos !== supplierStateCode;
    const items: Array<{ num: number; itm_det: Record<string, number> }> = [];

    record.rateSplits.forEach((split, index) => {
      const taxableValue = split.taxableValue;
      const rate = split.rate;
      const igst = split.igst;
      const cgst = split.cgst;
      const sgst = split.sgst;
      if (![taxableValue, rate, igst, cgst, sgst].every((value) => typeof value === "number" && Number.isFinite(value))) {
        reasons.push(`GST row ${index + 1} contains a missing or invalid number`);
        return;
      }
      if (taxableValue < 0 || rate < 0 || igst < 0 || cgst < 0 || sgst < 0) {
        reasons.push(`GST row ${index + 1} contains a negative amount or rate`);
        return;
      }

      if (interstate && (cgst > 0 || sgst > 0)) {
        reasons.push(`tax type mismatch — seller state ${supplierStateCode} and POS ${pos} require IGST only`);
      } else if (!interstate && igst > 0) {
        reasons.push(`tax type mismatch — seller state ${supplierStateCode} and POS ${pos} require CGST + SGST`);
      } else if (!interstate && rate > 0 && taxableValue > 0 && (cgst === 0 || sgst === 0)) {
        reasons.push(`GST row ${index + 1} requires both CGST and SGST for intrastate supply`);
      } else if (interstate && rate > 0 && taxableValue > 0 && igst === 0) {
        reasons.push(`GST row ${index + 1} requires IGST for interstate supply`);
      }

      if (taxableValue <= 0) return;
      const itmDet: Record<string, number> = {
        txval: round2(taxableValue),
        rt: rate,
      };
      if (interstate) {
        itmDet.iamt = round2(igst);
      } else {
        itmDet.camt = round2(cgst);
        itmDet.samt = round2(sgst);
      }
      itmDet.csamt = 0;
      items.push({ num: Math.round(rate * 100) + index + 1, itm_det: itmDet });
    });

    if (items.length === 0 && record.rateSplits.length > 0) {
      reasons.push("no GST rows with a positive taxable value to export");
    }
    if (reasons.length > 0) {
      validationErrors.push(`${invoiceLabel}: ${[...new Set(reasons)].join("; ")}`);
      continue;
    }

    // All required values were checked above; only validated values enter the export.
    if (invoiceDate && pos && typeof invoiceValue === "number" && ctin) {
      preparedInvoices.push({
        ctin,
        invoice: {
          inum: record.invoiceNumber?.trim() ?? "",
          idt: invoiceDate,
          val: round2(invoiceValue),
          pos,
          rchrg: "N",
          inv_typ: "R",
          itms: items,
        },
      });
    }
  }

  if (validationErrors.length > 0) {
    throw new Error(`B2B JSON was not exported because these invoices need attention:\n\n${validationErrors.join("\n")}`);
  }

  const requestedPeriod = opts.filingPeriod?.trim();
  if (requestedPeriod && (!/^\d{6}$/.test(requestedPeriod) || Number(requestedPeriod.slice(0, 2)) < 1 || Number(requestedPeriod.slice(0, 2)) > 12)) {
    throw new Error("Filing period must be a valid MMYYYY value.");
  }
  const fp = requestedPeriod || preparedInvoices
    .map(({ invoice }) => fpFromDate(invoice.idt))
    .find((value): value is string => Boolean(value)) || "";
  const b2bBlock = new Map<string, typeof preparedInvoices>();
  for (const prepared of preparedInvoices) {
    const group = b2bBlock.get(prepared.ctin) ?? [];
    group.push(prepared);
    b2bBlock.set(prepared.ctin, group);
  }

  return {
    gstin: supplierGstin,
    fp,
    version: "GST3.2.4",
    hash: "hash",
    b2b: Array.from(b2bBlock, ([ctin, invoices]) => ({
      ctin,
      inv: invoices.map(({ invoice }) => invoice),
    })),
  };
}

export async function exportGstr1Json(records: InvoiceRecord[], opts: JsonExportOptions): Promise<void> {
  let payload: ReturnType<typeof buildGstr1Json>;
  try {
    payload = buildGstr1Json(records, opts);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to validate B2B invoices.";
    window.alert(message);
    return;
  }
  if (payload.b2b.length === 0) {
    window.alert("No valid B2B invoices are available to export.");
    return;
  }
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `gstr1_${payload.fp || "return"}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
