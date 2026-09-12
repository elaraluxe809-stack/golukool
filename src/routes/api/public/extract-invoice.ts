import { createFileRoute } from "@tanstack/react-router";
import { ExtractInvoiceInput } from "@/lib/gstr1/extract.shared";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export const Route = createFileRoute("/api/public/extract-invoice")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
      POST: async ({ request }) => {
        try {
          const input = ExtractInvoiceInput.parse(await request.json());
          const { runInvoiceExtraction } = await import("@/lib/gstr1/extract.server");
          const result = await runInvoiceExtraction(input);
          const status = result.ok
            ? 200
            : result.code === "AI_CREDITS_EXHAUSTED"
              ? 402
              : result.code === "AI_RATE_LIMIT"
                ? 429
                : result.code === "AI_NOT_CONFIGURED"
                  ? 503
                  : 502;
          return Response.json(result, { status, headers: corsHeaders });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Invalid extraction request";
          return Response.json(
            { ok: false, code: "AI_GATEWAY_ERROR", message },
            { status: 400, headers: corsHeaders },
          );
        }
      },
    },
  },
});
