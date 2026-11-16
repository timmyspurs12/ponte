import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { pool } from "./repository";
import { fail } from "./errors";
const uuid = z.uuid();
export type Context = { business: string; user: string; role: string };
export async function authenticate(request: Request): Promise<Context> {
  // Deliberately unavailable in production, even if the development flags leak.
  if (process.env.NODE_ENV === "production") fail(503, "AUTH_NOT_CONFIGURED");
  if (
    process.env.PONTE_DEV_AUTH !== "1" ||
    !process.env.PONTE_DEV_TOKEN ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(process.env.PONTE_DEV_TOKEN)
  )
    fail(503, "AUTH_NOT_CONFIGURED");
  const raw =
    request.headers.get("authorization")?.replace(/^Bearer /, "") ??
    request.headers
      .get("cookie")
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("ponte-dev-session="))
      ?.slice(18) ??
    "";
  const digest = (s: string) => createHash("sha256").update(s).digest();
  if (!timingSafeEqual(digest(raw), digest(process.env.PONTE_DEV_TOKEN!)))
    fail(401, "UNAUTHENTICATED");
  const business = uuid.parse(process.env.PONTE_DEV_BUSINESS_ID),
    user = uuid.parse(process.env.PONTE_DEV_USER_ID);
  const result = await pool.query(
    "SELECT role FROM memberships WHERE business_id=$1 AND user_id=$2 AND status='active'",
    [business, user],
  );
  if (!result.rowCount) fail(403, "FORBIDDEN");
  const limit = await pool.query(
    "INSERT INTO rate_limits VALUES($1,now(),1) ON CONFLICT(identity) DO UPDATE SET window_start=CASE WHEN rate_limits.window_start < now()-interval '1 minute' THEN now() ELSE rate_limits.window_start END, hits=CASE WHEN rate_limits.window_start < now()-interval '1 minute' THEN 1 ELSE rate_limits.hits+1 END RETURNING hits",
    [`${business}:${user}`],
  );
  if (limit.rows[0].hits > 120) fail(429, "RATE_LIMITED");
  return { business, user, role: result.rows[0].role };
}
