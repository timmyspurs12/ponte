export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Process liveness only: it intentionally has no database or provider work. */
export async function GET(): Promise<Response> {
  return Response.json(
    { status: "ok" },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
