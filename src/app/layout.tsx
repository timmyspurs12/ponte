import { translate } from "@/lib/i18n/messages";
import { cookies } from "next/headers";
import { LocaleProvider, SkipLink } from "@/lib/i18n/provider";
import type { Metadata } from "next";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./globals.css";
export async function generateMetadata(): Promise<Metadata> {
  const locale =
    (await cookies()).get("ponte-locale")?.value === "en-US"
      ? "en-US"
      : "pt-BR";
  return {
    title: translate(locale, "PONTE — A better way across borders"),
    description: translate(
      locale,
      "Explore a frontend demonstration of Pix-to-USDG business settlement. No real funds are moved.",
    ),
  };
}
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale =
    (await cookies()).get("ponte-locale")?.value === "en-US"
      ? "en-US"
      : "pt-BR";
  return (
    <html lang={locale} data-scroll-behavior="smooth">
      <body>
        <LocaleProvider initialLocale={locale}>
          <SkipLink />
          {children}
        </LocaleProvider>
      </body>
    </html>
  );
}
