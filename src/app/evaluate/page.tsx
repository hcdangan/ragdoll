import type { Metadata } from "next";
import type { ReactElement } from "react";

import { PageHeader } from "@/components/layout/page-header";
import { EvaluationDashboard } from "@/components/evaluate/evaluation-dashboard";
import { t } from "@/lib/i18n";

export const metadata: Metadata = {
  title: t("evaluate.title"),
  description: t("evaluate.subtitle"),
};

/**
 * Duration granted to the evaluation Server Action on a hosted platform.
 *
 * The suite spends roughly eight provider calls per sampled question, and a
 * self-hosted model can take a minute to load on its own, so the platform default
 * (60s on Vercel Hobby) aborts legitimate runs. Five minutes is the Pro ceiling —
 * the client gives up at the same moment and says so, rather than leaving a spinner
 * and no explanation. Must stay a literal: Next reads it statically.
 * (`LIMITS.evaluationTimeoutMs` mirrors this value.)
 */
export const maxDuration = 300;

/** Evaluation route. The dashboard itself detects whether a pipeline exists. */
export default function EvaluatePage(): ReactElement {
  return (
    <>
      <PageHeader titleKey="evaluate.title" subtitleKey="evaluate.subtitle" />
      <EvaluationDashboard />
    </>
  );
}
