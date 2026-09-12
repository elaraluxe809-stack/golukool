import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Download, Plus, Trash2 } from "lucide-react";
import type { HsnItem, InvoiceRecord, RateSplit } from "@/lib/gstr1/parser";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v: string) => Number(v.replace(/,/g, "")) || 0;

function parseDate(s: string | null): { y: number; m: number } | null {
  if (!s) return null;
  const t = s.trim();
  let m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) { let y = Number(m[3]); if (y < 100) y += 2000; return { y, m: Number(m[2]) }; }
  m = t.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) return { y: Number(m[1]), m: Number(m[2]) };
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : { y: d.getFullYear(), m: d.getMonth() + 1 };
}

const mKey = (y: number, m: number) => `${MONTHS[m - 1] ?? "Unknown"} ${y}`;

function csvCell(v: string | number | null | undefined): string {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename: string, rows: Array<Array<string | number | null | undefined>>) {
  const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const emptyHsn = (): HsnItem => ({ hsn: "", description: "", uqc: "OTH", quantity: 0, rate: 0, taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });

function cloneRecords(records: InvoiceRecord[]): InvoiceRecord[] {
  return records.map((r) => ({ ...r, rateSplits: r.rateSplits.map((s) => ({ ...s })), hsnItems: (r.hsnItems ?? []).map((h) => ({ ...h })), issues: [...r.issues] }));
}

function sumHsn(items: HsnItem[]) {
  return items.reduce((a, h) => ({
    quantity: a.quantity + Number(h.quantity || 0),
    taxable: a.taxable + Number(h.taxableValue || 0),
    igst: a.igst + Number(h.igst || 0),
    cgst: a.cgst + Number(h.cgst || 0),
    sgst: a.sgst + Number(h.sgst || 0),
    cess: a.cess + Number(h.cess || 0),
  }), { quantity: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
}

function sumRateSplits(record: InvoiceRecord) {
  return record.rateSplits.reduce((a, s) => ({
    taxable: a.taxable + Number(s.taxableValue || 0),
    igst: a.igst + Number(s.igst || 0),
    cgst: a.cgst + Number(s.cgst || 0),
    sgst: a.sgst + Number(s.sgst || 0),
  }), { taxable: 0, igst: 0, cgst: 0, sgst: 0 });
}

function getReconciliation(record: InvoiceRecord) {
  const h = sumHsn(record.hsnItems ?? []);
  const hsnTotal = h.taxable + h.igst + h.cgst + h.sgst + h.cess;
  const invoiceTotal = Number(record.invoiceValue ?? 0);
  const difference = invoiceTotal - hsnTotal;
  return { h, hsnTotal, invoiceTotal, difference, match: Math.abs(difference) <= 1 };
}

export function GstDashboard({ records }: { records: InvoiceRecord[] }) {
  const [edited, setEdited] = useState<InvoiceRecord[]>(() => cloneRecords(records));
  const [currentInvoice, setCurrentInvoice] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    setEdited(cloneRecords(records));
    setCurrentInvoice(0);
    setExportOpen(false);
  }, [records]);

  useEffect(() => {
    if (currentInvoice >= edited.length) setCurrentInvoice(Math.max(0, edited.length - 1));
  }, [edited.length, currentInvoice]);

  const data = useMemo(() => {
    const grand = { taxable: 0, igst: 0, cgst: 0, sgst: 0 };
    const mMap = new Map<string, { y: number; m: number; count: number; taxable: number; igst: number; cgst: number; sgst: number }>();
    const hMap = new Map<string, { qty: number; taxable: number; igst: number; cgst: number; sgst: number; cess: number }>();

    for (const r of edited) {
      const split = sumRateSplits(r);
      grand.taxable += split.taxable; grand.igst += split.igst; grand.cgst += split.cgst; grand.sgst += split.sgst;
      const d = parseDate(r.invoiceDate);
      const key = d ? mKey(d.y, d.m) : "Unknown";
      const bucket = mMap.get(key) ?? { y: d?.y ?? 0, m: d?.m ?? 0, count: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
      bucket.count += 1; bucket.taxable += split.taxable; bucket.igst += split.igst; bucket.cgst += split.cgst; bucket.sgst += split.sgst;
      mMap.set(key, bucket);
      for (const h of r.hsnItems ?? []) {
        const code = (h.hsn || "").trim() || "UNSPECIFIED";
        const bucketHsn = hMap.get(code) ?? { qty: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
        bucketHsn.qty += Number(h.quantity || 0); bucketHsn.taxable += Number(h.taxableValue || 0); bucketHsn.igst += Number(h.igst || 0); bucketHsn.cgst += Number(h.cgst || 0); bucketHsn.sgst += Number(h.sgst || 0); bucketHsn.cess += Number(h.cess || 0);
        hMap.set(code, bucketHsn);
      }
    }

    const monthly = [...mMap.entries()].map(([key, value]) => ({ key, ...value })).sort((a, b) => a.y - b.y || a.m - b.m);
    const hsn = [...hMap.entries()].map(([code, value]) => ({ code, ...value })).sort((a, b) => b.taxable - a.taxable);
    const hsnGrand = hsn.reduce((a, h) => ({ qty: a.qty + h.qty, taxable: a.taxable + h.taxable, igst: a.igst + h.igst, cgst: a.cgst + h.cgst, sgst: a.sgst + h.sgst, cess: a.cess + h.cess }), { qty: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
    const invoiceTotal = edited.reduce((sum, r) => { const s = sumRateSplits(r); return sum + Number(r.invoiceValue ?? s.taxable + s.igst + s.cgst + s.sgst); }, 0);
    const hsnTotal = hsnGrand.taxable + hsnGrand.igst + hsnGrand.cgst + hsnGrand.sgst + hsnGrand.cess;
    return { grand, monthly, hsn, hsnGrand, invoiceTotal, hsnTotal };
  }, [edited]);

  const current = edited[currentInvoice] ?? null;
  const validCount = edited.filter((r) => r.issues.length === 0).length;
  const issueCount = edited.length - validCount;

  const updateInvoice = (index: number, field: keyof InvoiceRecord, value: string | number | null) => {
    setEdited((previous) => previous.map((record, i) => i === index ? { ...record, [field]: value } : record));
  };

  const updateRateSplit = (ri: number, si: number, field: keyof RateSplit, value: number) => {
    setEdited((previous) => previous.map((record, i) => i !== ri ? record : { ...record, rateSplits: record.rateSplits.map((split, splitIndex) => splitIndex === si ? { ...split, [field]: value } : split) }));
  };

  const updateHsn = (ri: number, hi: number, field: keyof HsnItem, value: string | number) => {
    setEdited((previous) => previous.map((record, i) => i !== ri ? record : { ...record, hsnItems: (record.hsnItems ?? []).map((h, j) => j === hi ? { ...h, [field]: value } : h) }));
  };

  const addHsn = (ri: number) => {
    setEdited((previous) => previous.map((record, i) => i === ri ? { ...record, hsnItems: [...(record.hsnItems ?? []), emptyHsn()] } : record));
  };

  const deleteHsn = (ri: number, hi: number) => {
    setEdited((previous) => previous.map((record, i) => i === ri ? { ...record, hsnItems: (record.hsnItems ?? []).filter((_, j) => j !== hi) } : record));
  };

  const exportInvoices = () => downloadCsv("invoice_extraction.csv", [
    ["File", "Invoice No", "Invoice Date", "Supplier GSTIN", "Supplier State", "Customer Name", "Customer GSTIN", "Place of Supply", "Supply Type", "Category", "Invoice Value", "Taxable", "IGST", "CGST", "SGST", "HSN Total", "Difference", "Status"],
    ...edited.map((r) => {
      const split = sumRateSplits(r); const reconciliation = getReconciliation(r);
      return [r.fileName, r.invoiceNumber, r.invoiceDate, r.supplierGstin, r.supplierState, r.customerName, r.customerGstin, r.placeOfSupply, r.supplyType, r.category, r.invoiceValue, split.taxable, split.igst, split.cgst, split.sgst, reconciliation.hsnTotal, reconciliation.difference, reconciliation.match ? "MATCH" : "CHECK"];
    }),
  ]);

  const exportHsn = () => downloadCsv("hsn_extraction.csv", [
    ["File", "Invoice No", "HSN", "Description", "UQC", "Quantity", "Rate", "Taxable Value", "IGST", "CGST", "SGST", "Cess", "Total Value"],
    ...edited.flatMap((r) => (r.hsnItems ?? []).map((h) => [r.fileName, r.invoiceNumber, h.hsn, h.description, h.uqc, h.quantity, h.rate, h.taxableValue, h.igst, h.cgst, h.sgst, h.cess, h.taxableValue + h.igst + h.cgst + h.sgst + h.cess])),
  ]);

  const exportRecon = () => downloadCsv("invoice_hsn_reconciliation.csv", [
    ["Invoice No", "File", "Invoice Value", "HSN Taxable", "HSN IGST", "HSN CGST", "HSN SGST", "HSN Cess", "HSN Total", "Difference", "Status"],
    ...edited.map((r) => { const reconciliation = getReconciliation(r); return [r.invoiceNumber, r.fileName, r.invoiceValue, reconciliation.h.taxable, reconciliation.h.igst, reconciliation.h.cgst, reconciliation.h.sgst, reconciliation.h.cess, reconciliation.hsnTotal, reconciliation.difference, reconciliation.match ? "MATCH" : "CHECK"]; }),
  ]);

  const exportComplete = () => {
    const rows: Array<Array<string | number | null | undefined>> = [["Invoice No", "File", "Invoice Date", "Supplier GSTIN", "Supplier State", "Customer Name", "Customer GSTIN", "Place of Supply", "Supply Type", "Category", "Invoice Value", "Rate", "Rate Taxable", "Rate IGST", "Rate CGST", "Rate SGST", "HSN", "Description", "UQC", "Quantity", "HSN Rate", "HSN Taxable", "HSN IGST", "HSN CGST", "HSN SGST", "HSN Cess", "HSN Total", "Invoice-HSN Difference", "Reconciliation Status"]];
    for (const r of edited) {
      const reconciliation = getReconciliation(r);
      const splits = r.rateSplits.length ? r.rateSplits : [null];
      const items = r.hsnItems?.length ? r.hsnItems : [null];
      const rowCount = Math.max(splits.length, items.length);
      for (let i = 0; i < rowCount; i++) {
        const split = splits[i] ?? null; const h = items[i] ?? null;
        const hsnTotal = h ? Number(h.taxableValue || 0) + Number(h.igst || 0) + Number(h.cgst || 0) + Number(h.sgst || 0) + Number(h.cess || 0) : null;
        rows.push([r.invoiceNumber, r.fileName, r.invoiceDate, r.supplierGstin, r.supplierState, r.customerName, r.customerGstin, r.placeOfSupply, r.supplyType, r.category, r.invoiceValue, split?.rate, split?.taxableValue, split?.igst, split?.cgst, split?.sgst, h?.hsn, h?.description, h?.uqc, h?.quantity, h?.rate, h?.taxableValue, h?.igst, h?.cgst, h?.sgst, h?.cess, hsnTotal, reconciliation.difference, reconciliation.match ? "MATCH" : "CHECK"]);
      }
    }
    downloadCsv("complete_gst_report.csv", rows);
  };

  const kpis = [["Total Invoices", String(edited.length)], ["Total Taxable", fmt(data.grand.taxable)], ["Total IGST", fmt(data.grand.igst)], ["Total CGST", fmt(data.grand.cgst)], ["Total SGST", fmt(data.grand.sgst)], ["Total Invoice Value", fmt(data.invoiceTotal)], ["Total HSN Value", fmt(data.hsnTotal)]];

  return (
    <section className="mt-10 space-y-6">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4 bg-primary px-4 py-4 text-primary-foreground">
          <div><div className="text-xs font-semibold uppercase tracking-wide">Extraction Complete</div><div className="mt-1 text-lg font-bold">{edited.length} invoices processed</div></div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{validCount} Valid</Badge>
            <Badge variant="destructive">{issueCount} Issues</Badge>
            <div className="relative">
              <Button size="sm" variant="secondary" onClick={() => setExportOpen((value) => !value)}><Download className="h-4 w-4" />Export<span className="ml-1">▼</span></Button>
              {exportOpen && <div className="absolute right-0 z-50 mt-2 w-72 rounded-lg border bg-background p-1 text-foreground shadow-lg">
                <ExportOption label="Invoice Extraction (CSV)" onClick={() => { setExportOpen(false); exportInvoices(); }} />
                <ExportOption label="HSN Extraction (CSV)" onClick={() => { setExportOpen(false); exportHsn(); }} />
                <ExportOption label="Invoice + HSN Reconciliation (CSV)" onClick={() => { setExportOpen(false); exportRecon(); }} />
                <ExportOption label="Complete GST Report (CSV)" onClick={() => { setExportOpen(false); exportComplete(); }} />
              </div>}
            </div>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-7">
        {kpis.map(([label, value]) => <Card key={label} className="overflow-hidden"><div className="bg-primary px-3 py-2 text-xs font-medium text-primary-foreground">{label}</div><div className="px-3 py-3 text-lg font-semibold">{value}</div></Card>)}
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div><div className="font-semibold">Invoice {edited.length ? currentInvoice + 1 : 0} of {edited.length}</div><div className="text-xs text-muted-foreground">{current?.fileName ?? "No invoice selected"}</div></div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={currentInvoice === 0} onClick={() => setCurrentInvoice((value) => Math.max(0, value - 1))}><ChevronLeft className="h-4 w-4" />Previous</Button>
            <Button size="sm" variant="outline" disabled={currentInvoice >= edited.length - 1} onClick={() => setCurrentInvoice((value) => Math.min(edited.length - 1, value + 1))}>Next<ChevronRight className="h-4 w-4" /></Button>
          </div>
        </div>

        {current && <div className="grid gap-4 p-4 lg:grid-cols-2">
          <Card className="border">
            <div className="border-b px-4 py-3"><div className="font-semibold">Invoice Details</div><div className="text-xs text-muted-foreground">All extracted invoice values are editable inline.</div></div>
            <div className="grid gap-4 p-4 sm:grid-cols-2">
              <EditableField label="Invoice Number" value={current.invoiceNumber ?? ""} onChange={(value) => updateInvoice(currentInvoice, "invoiceNumber", value || null)} />
              <EditableField label="Invoice Date" value={current.invoiceDate ?? ""} onChange={(value) => updateInvoice(currentInvoice, "invoiceDate", value || null)} />
              <EditableField label="Supplier GSTIN" value={current.supplierGstin ?? ""} mono onChange={(value) => updateInvoice(currentInvoice, "supplierGstin", value.toUpperCase() || null)} />
              <EditableField label="Supplier State" value={current.supplierState ?? ""} onChange={(value) => updateInvoice(currentInvoice, "supplierState", value || null)} />
              <EditableField label="Customer Name" value={current.customerName ?? ""} onChange={(value) => updateInvoice(currentInvoice, "customerName", value || null)} />
              <EditableField label="Customer GSTIN" value={current.customerGstin ?? ""} mono onChange={(value) => updateInvoice(currentInvoice, "customerGstin", value.toUpperCase() || null)} />
              <EditableField label="Place of Supply" value={current.placeOfSupply ?? ""} onChange={(value) => updateInvoice(currentInvoice, "placeOfSupply", value || null)} />
              <EditableNumber label="Invoice Value" value={current.invoiceValue} onChange={(value) => updateInvoice(currentInvoice, "invoiceValue", value)} />
              <div><label className="mb-1 block text-xs font-medium">Category</label><Input value={current.category} disabled /></div>
              <div><label className="mb-1 block text-xs font-medium">Supply Type</label><Input value={current.supplyType} disabled /></div>
            </div>
            <div className="border-t p-4">
              <div className="mb-3 text-sm font-semibold">Tax / Rate Split</div>
              <div className="space-y-3">
                {current.rateSplits.map((split, si) => <div key={si} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-5">
                  <EditableNumber label="Rate %" value={split.rate} onChange={(value) => updateRateSplit(currentInvoice, si, "rate", value ?? 0)} />
                  <EditableNumber label="Taxable" value={split.taxableValue} onChange={(value) => updateRateSplit(currentInvoice, si, "taxableValue", value ?? 0)} />
                  <EditableNumber label="IGST" value={split.igst} onChange={(value) => updateRateSplit(currentInvoice, si, "igst", value ?? 0)} />
                  <EditableNumber label="CGST" value={split.cgst} onChange={(value) => updateRateSplit(currentInvoice, si, "cgst", value ?? 0)} />
                  <EditableNumber label="SGST" value={split.sgst} onChange={(value) => updateRateSplit(currentInvoice, si, "sgst", value ?? 0)} />
                </div>)}
              </div>
            </div>
          </Card>

          <Card className="border">
            <div className="flex items-center justify-between border-b px-4 py-3"><div><div className="font-semibold">HSN Items</div><div className="text-xs text-muted-foreground">Add, edit or delete HSN rows. Totals update immediately.</div></div><Button size="sm" variant="outline" onClick={() => addHsn(currentInvoice)}><Plus className="h-4 w-4" />Add HSN</Button></div>
            <div className="overflow-x-auto">
              <Table><TableHeader><TableRow>{["HSN", "Description", "UQC", "Qty", "Rate", "Taxable", "IGST", "CGST", "SGST", "CESS", "Total", ""].map((label) => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader>
                <TableBody>{(current.hsnItems ?? []).map((h, hi) => {
                  const total = Number(h.taxableValue || 0) + Number(h.igst || 0) + Number(h.cgst || 0) + Number(h.sgst || 0) + Number(h.cess || 0);
                  return <TableRow key={hi}>
                    <TableCell><Input value={h.hsn} onChange={(e) => updateHsn(currentInvoice, hi, "hsn", e.target.value)} className="min-w-24" /></TableCell>
                    <TableCell><Input value={h.description} onChange={(e) => updateHsn(currentInvoice, hi, "description", e.target.value)} className="min-w-40" /></TableCell>
                    <TableCell><Input value={h.uqc} onChange={(e) => updateHsn(currentInvoice, hi, "uqc", e.target.value)} className="min-w-20" /></TableCell>
                    {(["quantity", "rate", "taxableValue", "igst", "cgst", "sgst", "cess"] as const).map((field) => <TableCell key={field}><Input type="number" step="0.01" value={Number(h[field] || 0)} onChange={(e) => updateHsn(currentInvoice, hi, field, num(e.target.value))} className="min-w-20" /></TableCell>)}
                    <TableCell className="whitespace-nowrap text-right font-medium">{fmt(total)}</TableCell>
                    <TableCell><Button size="icon" variant="ghost" onClick={() => deleteHsn(currentInvoice, hi)} aria-label="Delete HSN row"><Trash2 className="h-4 w-4 text-destructive" /></Button></TableCell>
                  </TableRow>;
                })}</TableBody>
              </Table>
            </div>
            <HsnTotals items={current.hsnItems ?? []} />
            <Reconciliation invoice={current} />
          </Card>
        </div>}
      </Card>

      <Card className="overflow-hidden">
        <div className="bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Monthly Invoice Summary</div>
        <Table><TableHeader><TableRow><TableHead>Month</TableHead><TableHead className="text-right">Invoices</TableHead><TableHead className="text-right">Taxable</TableHead><TableHead className="text-right">IGST</TableHead><TableHead className="text-right">CGST</TableHead><TableHead className="text-right">SGST</TableHead><TableHead className="text-right">Total Value</TableHead></TableRow></TableHeader>
          <TableBody>{data.monthly.map((m) => <TableRow key={m.key}><TableCell>{m.key}</TableCell><TableCell className="text-right">{m.count}</TableCell><TableCell className="text-right">{fmt(m.taxable)}</TableCell><TableCell className="text-right">{fmt(m.igst)}</TableCell><TableCell className="text-right">{fmt(m.cgst)}</TableCell><TableCell className="text-right">{fmt(m.sgst)}</TableCell><TableCell className="text-right">{fmt(m.taxable + m.igst + m.cgst + m.sgst)}</TableCell></TableRow>)}
            <TableRow className="bg-green-50 font-semibold dark:bg-green-950/30"><TableCell>Grand Total</TableCell><TableCell className="text-right">{edited.length}</TableCell><TableCell className="text-right">{fmt(data.grand.taxable)}</TableCell><TableCell className="text-right">{fmt(data.grand.igst)}</TableCell><TableCell className="text-right">{fmt(data.grand.cgst)}</TableCell><TableCell className="text-right">{fmt(data.grand.sgst)}</TableCell><TableCell className="text-right">{fmt(data.grand.taxable + data.grand.igst + data.grand.cgst + data.grand.sgst)}</TableCell></TableRow>
          </TableBody>
        </Table>
      </Card>

      <Card className="overflow-hidden">
        <div className="bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">HSN Summary</div>
        <Table><TableHeader><TableRow><TableHead>HSN</TableHead><TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Taxable</TableHead><TableHead className="text-right">IGST</TableHead><TableHead className="text-right">CGST</TableHead><TableHead className="text-right">SGST</TableHead><TableHead className="text-right">CESS</TableHead><TableHead className="text-right">Total Value</TableHead></TableRow></TableHeader>
          <TableBody>{data.hsn.map((h) => <TableRow key={h.code}><TableCell className="font-mono text-xs">{h.code}</TableCell><TableCell className="text-right">{fmt(h.qty)}</TableCell><TableCell className="text-right">{fmt(h.taxable)}</TableCell><TableCell className="text-right">{fmt(h.igst)}</TableCell><TableCell className="text-right">{fmt(h.cgst)}</TableCell><TableCell className="text-right">{fmt(h.sgst)}</TableCell><TableCell className="text-right">{fmt(h.cess)}</TableCell><TableCell className="text-right">{fmt(h.taxable + h.igst + h.cgst + h.sgst + h.cess)}</TableCell></TableRow>)}
            <TableRow className="bg-green-50 font-semibold dark:bg-green-950/30"><TableCell>HSN Grand Total</TableCell><TableCell className="text-right">{fmt(data.hsnGrand.qty)}</TableCell><TableCell className="text-right">{fmt(data.hsnGrand.taxable)}</TableCell><TableCell className="text-right">{fmt(data.hsnGrand.igst)}</TableCell><TableCell className="text-right">{fmt(data.hsnGrand.cgst)}</TableCell><TableCell className="text-right">{fmt(data.hsnGrand.sgst)}</TableCell><TableCell className="text-right">{fmt(data.hsnGrand.cess)}</TableCell><TableCell className="text-right">{fmt(data.hsnTotal)}</TableCell></TableRow>
          </TableBody>
        </Table>
      </Card>
    </section>
  );
}

function ExportOption({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted" onClick={onClick}>{label}</button>;
}

function EditableField({ label, value, onChange, mono = false }: { label: string; value: string; onChange: (value: string) => void; mono?: boolean }) {
  return <div><label className="mb-1 block text-xs font-medium">{label}</label><Input value={value} onChange={(e) => onChange(e.target.value)} className={mono ? "font-mono text-xs" : ""} /></div>;
}

function EditableNumber({ label, value, onChange }: { label: string; value: number | null; onChange: (value: number | null) => void }) {
  return <div><label className="mb-1 block text-xs font-medium">{label}</label><Input type="number" step="0.01" value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : num(e.target.value))} /></div>;
}

function HsnTotals({ items }: { items: HsnItem[] }) {
  const totals = sumHsn(items);
  const total = totals.taxable + totals.igst + totals.cgst + totals.sgst + totals.cess;
  return <div className="grid gap-2 border-t bg-muted/20 p-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
    <SummaryValue label="Taxable" value={totals.taxable} /><SummaryValue label="IGST" value={totals.igst} /><SummaryValue label="CGST" value={totals.cgst} /><SummaryValue label="SGST" value={totals.sgst} /><SummaryValue label="CESS" value={totals.cess} /><SummaryValue label="HSN Total" value={total} />
  </div>;
}

function SummaryValue({ label, value }: { label: string; value: number }) {
  return <div><div className="text-xs text-muted-foreground">{label}</div><div className="font-semibold">{fmt(value)}</div></div>;
}

function Reconciliation({ invoice }: { invoice: InvoiceRecord }) {
  const result = getReconciliation(invoice);
  return <div className="border-t p-4">
    <div className="mb-2 text-sm font-semibold">Invoice vs HSN Reconciliation</div>
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">Invoice Value</div><div className="font-semibold">{fmt(result.invoiceTotal)}</div></div>
      <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">HSN Total</div><div className="font-semibold">{fmt(result.hsnTotal)}</div></div>
      <div className={`rounded-lg border p-3 ${result.match ? "border-emerald-300" : "border-destructive"}`}>
        <div className="text-xs text-muted-foreground">Difference</div>
        <div className="flex items-center gap-2 font-semibold">{result.match ? <Check className="h-4 w-4 text-emerald-600" /> : <AlertTriangle className="h-4 w-4 text-destructive" />}{fmt(result.difference)}<Badge variant={result.match ? "default" : "destructive"}>{result.match ? "MATCH" : "CHECK"}</Badge></div>
      </div>
    </div>
  </div>;
}
