import type { Metadata } from "next";
import type { ReactElement } from "react";

import { PageHeader } from "@/components/layout/page-header";
import { EvaluationDashboard } from "@/components/evaluate/evaluation-dashboard";
import { t } from "@/lib/i18n";

export const metadata: Metadata = {
  title: t("evaluate.title"),
  description: t("evaluate.subtitle"),
};

/** Evaluation route. The dashboard itself detects whether a pipeline exists. */
export default function EvaluatePage(): ReactElement {
  return (
    <>
      <PageHeader titleKey="evaluate.title" subtitleKey="evaluate.subtitle" />
      <EvaluationDashboard />
    </>
  );
}
