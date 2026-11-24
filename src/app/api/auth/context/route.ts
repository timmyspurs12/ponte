import { ApiError } from "@/server/errors";
import { publicAuthenticationContext } from "@/server/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const requestId = crypto.randomUUID();
  try {
    const data = await publicAuthenticationContext(request);
    // Authentication without an active applicable membership is still a 403.
    // The tiny safe data projection exists only so the UI can name the signed-in
    // account in its access-denied state; it contains no business/resource data.
    return Response.json(
      {
        data,
        requestId,
        ...(data.access ? {} : { error: { code: "FORBIDDEN" } }),
      },
      {
        status: data.access ? 200 : 403,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500;
    const code = error instanceof ApiError ? error.code : "INTERNAL_ERROR";
    return Response.json(
      { error: { code }, requestId },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
