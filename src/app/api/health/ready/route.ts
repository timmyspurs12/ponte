import { databaseReadinessResponse } from "@/server/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Database readiness only: it never mutates application or tenant state. */
export async function GET(): Promise<Response> {
  return databaseReadinessResponse();
}
