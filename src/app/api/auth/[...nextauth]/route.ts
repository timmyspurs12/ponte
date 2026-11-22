import { NextRequest } from "next/server";
import { handlers } from "@/auth";
import {
  isProductionRuntime,
  readProductionAuthConfig,
} from "@/server/auth-config";

export const runtime = "nodejs";

function unavailable(): Response {
  return Response.json(
    { error: { code: "AUTH_NOT_CONFIGURED" } },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

async function handler(
  request: Request,
  _context?: { params: Promise<{ nextauth: string[] }> },
): Promise<Response> {
  // Do not let a missing or invalid production policy reach Auth.js' generic
  // error object, where a consumer might mistake that object for a session.
  // Development authentication never uses this OAuth handler.
  if (isProductionRuntime() && readProductionAuthConfig() === null)
    return unavailable();
  try {
    const nextRequest =
      request instanceof NextRequest ? request : new NextRequest(request);
    return request.method === "POST"
      ? await handlers.POST(nextRequest)
      : await handlers.GET(nextRequest);
  } catch {
    return Response.json(
      { error: { code: "AUTH_UNAVAILABLE" } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

// These wrappers preserve a fail-closed configuration boundary around the
// official Auth.js v5 `handlers` export.
export { handler as GET, handler as POST };
