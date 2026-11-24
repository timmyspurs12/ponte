"use client";

import { useLocale } from "@/lib/i18n/provider";
import { FlaskConical } from "lucide-react";

/**
 * Plain-language boundary statement for the synthetic public demo. It states
 * exactly what is fabricated and what never happened, so a first-time visitor
 * cannot mistake the sample records for real financial or blockchain activity.
 */
export function SyntheticDemoNotice({
  variant = "panel",
}: {
  variant?: "panel" | "inline";
}) {
  const { t } = useLocale();
  if (variant === "inline")
    return (
      <p className="synthetic-demo-inline">
        {t(
          "Synthetic demonstration: every supplier, reference and amount below is fabricated sample data.",
        )}
      </p>
    );
  return (
    <section
      className="panel synthetic-demo-notice"
      aria-labelledby="demo-scope-title"
    >
      <div className="row">
        <h2 id="demo-scope-title">{t("Synthetic demonstration")}</h2>
        <FlaskConical size={19} aria-hidden="true" />
      </div>
      <p>
        {t(
          "This workspace contains example records created for demonstration only. Every supplier, invoice reference, amount and route is fabricated sample data.",
        )}
      </p>
      <ul>
        <li>
          {t(
            "No Pix payment was made. No wallet, token transfer, custody or settlement occurred.",
          )}
        </li>
        <li>
          {t(
            "No cloud KMS operation occurred and no blockchain transaction was submitted or verified.",
          )}
        </li>
        <li>
          {t(
            "This demonstration is read-only. Visitors cannot create, change, fund, route or settle anything.",
          )}
        </li>
      </ul>
      <p className="synthetic-demo-scope">
        {t(
          "Financial amounts are illustrative figures in the application's demo units, not real BRL or USDG balances.",
        )}
      </p>
    </section>
  );
}
