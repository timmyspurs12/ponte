import { ptBR } from "./pt-BR";
import type { Locale } from "./format";
export function translate(
  locale: Locale,
  key: string,
  values: Record<string, string | number> = {},
) {
  const message = locale === "pt-BR" ? (ptBR[key] ?? key) : key;
  return message.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name)
      ? String(values[name])
      : match,
  );
}

export const isMessageKey = (key: string) =>
  Object.prototype.hasOwnProperty.call(ptBR, key);
