import {
  ExtractInvoiceInput,
  InvoiceSchema,
  type ExtractInvoiceResult,
} from "./extract.shared";

const SYSTEM_PROMPT = `You are an Indian GST Invoice Extraction Engine.

Your task is to extract invoice information accurately. Never invent or guess values.

Rules:
1. Never guess any value. If a field is not readable or not present, return null.
2. Read every field exactly as printed.
3. Preserve Invoice Number / GSTIN / Customer Name / Invoice Date exactly.
4. Extract the SELLER/SUPPLIER GSTIN separately from the BUYER/CUSTOMER GSTIN. Never copy the customer GSTIN into supplier_gstin.
5. supplier_gstin must be the GSTIN belonging to the invoice issuer/seller/supplier. customer_gstin must be the GSTIN belonging to the recipient/buyer/customer.
6. Detect Place of Supply from the invoice. Do not infer it from customer GSTIN when the invoice explicitly states a different POS.
7. Detect whether the invoice actually shows IGST or CGST+SGST; do not change or rebalance tax amounts.
8. Group invoice according to GST Rate for "rows".
9. Also extract every HSN/SAC line item into "hsn": one entry per line item.
   - hsn: the HSN or SAC code as printed (digits only if possible).
   - description: item description text.
   - uqc: unit of measure printed on the line (e.g. NOS, KGS, PCS, MTR, BAG). If absent use "OTH".
   - quantity: numeric quantity of that line.
   - rate: GST rate % of that line (0/3/5/12/18/28).
   - taxable_value: taxable amount of that line.
   - igst / cgst / sgst / cess: tax amounts of that line (0 if not applicable).
10. Verify Taxable + GST = Invoice Total.
11. Return JSON only. Missing fields = null. No explanations.

Return this exact JSON shape:
{
  "invoice_no": "",
  "invoice_date": "",
  "supplier_gstin": "",
  "customer_name": "",
  "customer_gstin": "",
  "place_of_supply": "",
  "invoice_value": 0,
  "rows": [
    { "rate": 18, "taxable_value": 0, "igst": 0, "cgst": 0, "sgst": 0 }
  ],
  "hsn": [
    { "hsn": "", "description": "", "uqc": "", "quantity": 0, "rate": 18, "taxable_value": 0, "igst": 0, "cgst": 0, "sgst": 0, "cess": 0 }
  ]
}`;

function stripJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) return text.slice(first, last + 1);
  return text.trim();
}

function repairTruncatedJson(text: string): string {
  let s = text.trim();
  const first = s.indexOf("{");
  if (first > 0) s = s.slice(first);
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastSafe = 0;

  for (let i = 0; i < s.length; i += 1) {
    const character = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') {
        inString = false;
        lastSafe = i + 1;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      stack.push(character);
      lastSafe = i + 1;
    } else if (character === "}" || character === "]") {
      stack.pop();
      lastSafe = i + 1;
    } else if (character === ",") {
      lastSafe = i;
    } else if (!/\s/.test(character)) {
      lastSafe = i + 1;
    }
  }

  let output = s.slice(0, lastSafe);
  if (inString) {
    const quote = output.lastIndexOf('"');
    if (quote !== -1) output = output.slice(0, quote);
    output = output.replace(/,?\s*"[^"]*"\s*:\s*$/, "").replace(/,\s*$/, "");
  }
  output = output.replace(/[,:]\s*$/, "");

  const remaining: string[] = [];
  let stringOpen = false;
  let stringEscaped = false;
  for (const character of output) {
    if (stringOpen) {
      if (stringEscaped) stringEscaped = false;
      else if (character === "\\") stringEscaped = true;
      else if (character === '"') stringOpen = false;
    } else if (character === '"') stringOpen = true;
    else if (character === "{" || character === "[") remaining.push(character);
    else if (character === "}" || character === "]") remaining.pop();
  }
  while (remaining.length) {
    output += remaining.pop() === "{" ? "}" : "]";
  }
  return output;
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function runInvoiceExtraction(
  input: ExtractInvoiceInput,
): Promise<ExtractInvoiceResult> {
  const lovableKey = process.env["LOVABLE_API_KEY"];
  if (!lovableKey) {
    return {
      ok: false,
      code: "AI_NOT_CONFIGURED",
      message: "Lovable AI is not configured on the hosted backend.",
    };
  }

  const invoiceText = input.text.trim().slice(0, 45000);
  const userPrompt = `Extract invoice fields from this invoice text (file: ${input.fileName}). Return JSON only.\n\n${invoiceText}`;
  const maxAttempts = 8;
  let response: Response | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": lovableKey,
        "X-Lovable-AIG-SDK": "vercel-ai-sdk",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        max_tokens: 8192,
      }),
    });

    if ((response.status !== 429 && response.status < 500) || attempt === maxAttempts) break;
    const retryAfter = Number(response.headers.get("retry-after")) || 0;
    const wait = retryAfter > 0
      ? retryAfter * 1000
      : Math.min(60000, 2000 * 2 ** (attempt - 1)) + Math.random() * 750;
    await sleep(wait);
  }

  if (!response) {
    return { ok: false, code: "AI_GATEWAY_ERROR", message: "Lovable AI did not return a response." };
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    if (response.status === 402) {
      return {
        ok: false,
        code: "AI_CREDITS_EXHAUSTED",
        message: "Lovable AI credits are exhausted. Add credits in workspace billing.",
      };
    }
    if (response.status === 429) {
      return {
        ok: false,
        code: "AI_RATE_LIMIT",
        message: "Lovable AI rate limit reached. Please retry in a moment.",
      };
    }
    return {
      ok: false,
      code: "AI_GATEWAY_ERROR",
      message: `Lovable AI error ${response.status}: ${errorText.slice(0, 300)}`,
    };
  }

  const gatewayJson = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = gatewayJson.choices?.[0]?.message?.content ?? "";
  if (!raw) return { ok: false, code: "AI_EMPTY_RESPONSE", message: "Lovable AI returned an empty response." };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJson(raw));
  } catch {
    try {
      parsed = JSON.parse(repairTruncatedJson(stripJson(raw)));
    } catch {
      return {
        ok: false,
        code: "AI_INVALID_JSON",
        message: `Lovable AI returned invalid JSON: ${raw.slice(0, 200)}`,
      };
    }
  }

  const invoice = InvoiceSchema.safeParse(parsed);
  if (!invoice.success) {
    return {
      ok: false,
      code: "AI_INVALID_JSON",
      message: "Lovable AI returned JSON that does not match the invoice structure.",
    };
  }
  return { ok: true, invoice: invoice.data };
}
