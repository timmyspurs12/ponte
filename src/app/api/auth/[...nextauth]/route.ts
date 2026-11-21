import { authHandler } from "@/auth";
import {
  isProductionRuntime,
  readProductionAuthConfig,
} from "@/server/auth-config";

export const runtime = "nodejs";

function unavailable() {
  return Response.json(
    { error: { code: "AUTH_NOT_CONFIGURED" } },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

async function handler(
  request: Request,
  context: { params: Promise<{ nextauth: string[] }> },
) {
  // Do not let missing/invalid production settings reach Auth.js' generic
  // provider errors, and never substitute the local development token.
  if (isProductionRuntime() && !readProductionAuthConfig())
    return unavailable();
  try {
    return await authHandler(request, context);
  } catch {
    return Response.json(
      { error: { code: "AUTH_UNAVAILABLE" } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export { handler as GET, handler as POST };
