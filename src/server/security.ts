/** Compare browser Origin to the actual Host, not Next's internal bind address.
 * Forwarded-Host is deliberately not trusted. Production auth remains disabled.
 */
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // Non-browser/Bearer clients; browser cookies are SameSite=Strict.
  try {
    const parsed = new URL(origin);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      parsed.host === (request.headers.get("host") ?? new URL(request.url).host)
    );
  } catch {
    return false;
  }
}
