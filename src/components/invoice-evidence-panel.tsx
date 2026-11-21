"use client";

import { useLocale } from "@/lib/i18n/provider";
import type { EvidenceProvider, InvoiceEvidenceStatus } from "@/lib/models";
import { invoiceService } from "@/lib/services";
import { Database, FileCheck2, RefreshCw, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";

type PanelState =
  | { kind: "loading" }
  | { kind: "ready"; status: InvoiceEvidenceStatus }
  | { kind: "error" };

function providerDisclosure(
  provider: EvidenceProvider,
  t: (key: string) => string,
): Readonly<{ title: string; description: string }> {
  switch (provider) {
    case "local-test-only":
      return {
        title: t("Local test provider"),
        description: t(
          "Evidence was prepared and persisted locally. Synthetic test bytes were used; no real cloud KMS operation occurred. No Arbitrum transaction has been verified.",
        ),
      };
    case "gcp-cloud-kms":
      return {
        title: t("Google Cloud KMS metadata"),
        description: t(
          "Genuine Google Cloud KMS provider metadata is recorded. This does not prove registry anchoring.",
        ),
      };
    case "aws-kms":
      return {
        title: t("AWS KMS metadata"),
        description: t(
          "Genuine AWS KMS provider metadata is recorded. This does not prove registry anchoring.",
        ),
      };
  }
}

/**
 * Product-facing, authenticated status panel. It consumes only the public
 * commitment endpoint and deliberately has no evidence decryption capability.
 */
export function InvoiceEvidencePanel({
  invoiceId,
  refreshKey,
}: {
  invoiceId: string;
  /** Refetch after the invoice lifecycle creates a newly persisted record. */
  refreshKey: string;
}) {
  const { t, date } = useLocale();
  const [state, setState] = useState<PanelState>({ kind: "loading" });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void invoiceService
      .evidence(invoiceId, controller.signal)
      .then((status) => {
        if (!controller.signal.aborted) setState({ kind: "ready", status });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: "error" });
      });
    return () => controller.abort();
  }, [invoiceId, refreshKey, retry]);

  if (state.kind === "loading")
    return (
      <section
        className="panel evidence-panel"
        aria-labelledby="evidence-status-title"
        data-testid="invoice-evidence-panel"
      >
        <div className="row">
          <h2 id="evidence-status-title">{t("Evidence status")}</h2>
          <Database size={19} aria-hidden="true" />
        </div>
        <div className="evidence-loading" role="status">
          <span className="evidence-pulse" aria-hidden="true" />
          {t("Loading evidence status…")}
        </div>
      </section>
    );

  if (state.kind === "error")
    return (
      <section
        className="panel evidence-panel evidence-unavailable"
        aria-labelledby="evidence-status-title"
        data-testid="invoice-evidence-panel"
      >
        <div className="row">
          <h2 id="evidence-status-title">{t("Evidence status")}</h2>
          <ShieldAlert size={19} aria-hidden="true" />
        </div>
        <p role="alert">
          {t(
            "Evidence status is unavailable. No persistence or anchoring result is shown until the authorized status read succeeds.",
          )}
        </p>
        <button
          className="text-link"
          onClick={() => {
            setState({ kind: "loading" });
            setRetry((value) => value + 1);
          }}
        >
          <RefreshCw size={15} /> {t("Try again")}
        </button>
      </section>
    );

  if (state.status.state === "missing")
    return (
      <section
        className="panel evidence-panel evidence-empty"
        aria-labelledby="evidence-status-title"
        data-testid="invoice-evidence-panel"
      >
        <div className="row">
          <h2 id="evidence-status-title">{t("Evidence status")}</h2>
          <Database size={19} aria-hidden="true" />
        </div>
        <strong>{t("No evidence record")}</strong>
        <p>{t("No evidence record has been persisted for this invoice.")}</p>
      </section>
    );

  const { evidence } = state.status;
  const provenance = providerDisclosure(evidence.provenance.provider, t);
  const outbox =
    evidence.outboxSubmissionState === "pending"
      ? {
          label: t("Awaiting submission"),
          description: t(
            "A pending outbox record establishes that submission is still awaiting work.",
          ),
        }
      : evidence.outboxSubmissionState
        ? {
            label: t("Outbox state: {state}", {
              state: evidence.outboxSubmissionState,
            }),
            description: t(
              "This is an operational outbox state only. It does not verify anchoring.",
            ),
          }
        : {
            label: t("No outbox record"),
            description: t("No outbox record is stored for this evidence."),
          };

  return (
    <section
      className="panel evidence-panel"
      aria-labelledby="evidence-status-title"
      data-testid="invoice-evidence-panel"
    >
      <div className="row">
        <h2 id="evidence-status-title">{t("Evidence status")}</h2>
        <FileCheck2 size={19} aria-hidden="true" />
      </div>
      <div className="evidence-status-line">
        <span className="evidence-status-dot" aria-hidden="true" />
        <strong>{t("Evidence persisted")}</strong>
        <span>{outbox.label}</span>
      </div>
      <p className="evidence-status-copy">{outbox.description}</p>

      <div className="evidence-anchor-note" role="note">
        <ShieldAlert size={17} aria-hidden="true" />
        <div>
          <strong>{t("Anchoring not verified")}</strong>
          <p>
            {t(
              "No independently verified transaction receipt and registry event are persisted. This evidence is not presented as submitted, confirmed, or anchored.",
            )}
          </p>
        </div>
      </div>

      <dl className="evidence-fields">
        <div>
          <dt>{t("Evidence public ID")}</dt>
          <dd className="mono">{evidence.publicEvidenceId}</dd>
        </div>
        <div>
          <dt>{t("Payload commitment")}</dt>
          <dd className="mono">{evidence.payloadHash}</dd>
        </div>
        <div>
          <dt>{t("Previous payload hash")}</dt>
          <dd className="mono">{evidence.previousPayloadHash}</dd>
        </div>
        <div>
          <dt>{t("Evidence kind / schema")}</dt>
          <dd>
            {evidence.evidenceKind} / {evidence.evidenceSchemaVersion}
          </dd>
        </div>
        <div>
          <dt>{t("Chain ID / registry")}</dt>
          <dd className="mono">
            {evidence.chainId} / {evidence.registryAddress}
          </dd>
        </div>
        <div>
          <dt>{t("Sequence")}</dt>
          <dd className="mono">{evidence.sequence}</dd>
        </div>
        <div>
          <dt>{t("Recorded provider")}</dt>
          <dd>{provenance.title}</dd>
        </div>
        <div>
          <dt>{t("Persisted")}</dt>
          <dd>{date(evidence.createdAt, true)}</dd>
        </div>
      </dl>

      <div className="evidence-disclosure">
        <strong>{provenance.title}</strong>
        <p>{provenance.description}</p>
      </div>
      <p className="evidence-commitment-note">
        {t(
          "This payload hash commits to the prepared evidence record. It does not reveal the private payload and does not prove an on-chain transaction or registry anchoring.",
        )}
      </p>
    </section>
  );
}
