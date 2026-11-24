import { ZodError } from "zod";
import { ApiError, execute } from "@/server/service";
import { mapEvidenceError } from "@/server/evidence/error-boundary";
export const runtime = "nodejs";
async function handler(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const requestId = crypto.randomUUID();
  try {
    const path = (await params).path;
    const data = await execute(request, path);
    const created =
      request.method === "POST" &&
      (path.length === 1 || ["quotes", "payments"].includes(path[2]));
    return Response.json(
      { data, requestId },
      { status: created ? 201 : 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // Evidence/provider exceptions must be normalized before the generic branch
    // below: its raw-error logging remains unchanged for unrelated operations.
    const evidenceError = mapEvidenceError(error);
    const mappedError = evidenceError ?? error;
    const pgCode = (mappedError as { code?: string }).code;
    const status =
      mappedError instanceof ApiError
        ? mappedError.status
        : mappedError instanceof ZodError
          ? 422
          : pgCode === "23505"
            ? 409
            : 500;
    const code =
      mappedError instanceof ApiError
        ? mappedError.code
        : mappedError instanceof ZodError
          ? "VALIDATION_ERROR"
          : pgCode === "23505"
            ? "DUPLICATE_REFERENCE"
            : "INTERNAL_ERROR";
    if (status === 500 && !evidenceError)
      console.error("API request failed", requestId, error);
    return Response.json(
      { error: { code }, requestId },
      {
        status,
        headers: {
          "Cache-Control": "no-store",
          ...(status === 429 ? { "Retry-After": "60" } : {}),
        },
      },
    );
  }
}
export { handler as GET, handler as POST, handler as PATCH };
