export type Locale = "pt-BR" | "en-US";
export function formatNumber(value: number, locale: Locale, digits = 2) {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}
export function formatMoney(value: number, locale: Locale, currency = "BRL") {
  // USDG is a token symbol, not an ISO 4217 currency or a claim of USD redemption.
  if (currency === "USDG") return formatNumber(value, locale);
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(
    value,
  );
}
export function formatDate(value: string, locale: Locale, timestamp = false) {
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  return (
    new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "UTC",
      ...(timestamp
        ? ({
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          } as const)
        : {}),
    }).format(date) + (timestamp ? " UTC" : "")
  );
}
