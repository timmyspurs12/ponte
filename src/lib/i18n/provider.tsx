"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { Globe2 } from "lucide-react";
import { formatDate, formatMoney, formatNumber, type Locale } from "./format";
import { translate } from "./messages";
const Context = createContext<{
  locale: Locale;
  setLocale: (l: Locale) => void;
}>({ locale: "pt-BR", setLocale: () => {} });
export function LocaleProvider({
  children,
  initialLocale,
}: {
  children: React.ReactNode;
  initialLocale: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  function setLocale(value: Locale) {
    setLocaleState(value);
    document.cookie = `ponte-locale=${value}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return (
    <Context.Provider value={{ locale, setLocale }}>
      {children}
    </Context.Provider>
  );
}
export function useLocale() {
  const { locale, setLocale } = useContext(Context);
  return {
    locale,
    setLocale,
    t: (key: string, values?: Record<string, string | number>) =>
      translate(locale, key, values),
    money: (value: number, currency = "BRL") =>
      formatMoney(value, locale, currency),
    number: (value: number, digits = 2) => formatNumber(value, locale, digits),
    date: (value: string, timestamp = false) =>
      formatDate(value, locale, timestamp),
  };
}
export function LanguageSelector() {
  const { locale, setLocale, t } = useLocale();
  return (
    <label className="language-selector">
      <Globe2 size={14} aria-hidden="true" />
      <span className="sr-only">{t("Language")}</span>
      <select
        aria-label={t("Language")}
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
      >
        <option value="pt-BR" lang="pt-BR">
          Português (Brasil)
        </option>
        <option value="en-US" lang="en">
          English
        </option>
      </select>
    </label>
  );
}
export function SkipLink() {
  const { t } = useLocale();
  return (
    <a className="skip" href="#main">
      {t("Skip to content")}
    </a>
  );
}
