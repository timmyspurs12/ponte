import { sameOrigin } from "@/server/security";
import { timingSafeEqual, createHash } from "node:crypto";
export async function GET() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.PONTE_DEV_AUTH !== "1"
  )
    return new Response("Not found", { status: 404 });
  return new Response(
    '<!doctype html><html lang="en"><title>PONTE local access</title><body><h1>PONTE · Local simulation access</h1><p>Development only. Enter the token from your local environment.</p><form method="post"><label>Development token <input name="token" type="password" required minlength="32" autocomplete="off"></label><button>Continue</button></form></body></html>',
    { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } },
  );
}
export async function POST(request: Request) {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.PONTE_DEV_AUTH !== "1" ||
    !process.env.PONTE_DEV_TOKEN
  )
    return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  if (!sameOrigin(request)) return new Response("Forbidden", { status: 403 });
  if (Number(request.headers.get("content-length") ?? 0) > 1024)
    return new Response("Too large", { status: 413 });
  const text = await request.text();
  if (text.length > 1024) return new Response("Too large", { status: 413 });
  const token = new URLSearchParams(text).get("token") ?? "";
  const hash = (s: string) => createHash("sha256").update(s).digest();
  if (
    !/^[A-Za-z0-9_-]{32,128}$/.test(process.env.PONTE_DEV_TOKEN) ||
    !timingSafeEqual(hash(token), hash(process.env.PONTE_DEV_TOKEN))
  )
    return new Response("Unauthorized", { status: 401 });
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/app",
      "Cache-Control": "no-store",
      "Set-Cookie": `ponte-dev-session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${url.protocol === "https:" || request.headers.get("origin")?.startsWith("https:") ? "; Secure" : ""}`,
    },
  });
}
