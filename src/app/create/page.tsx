import type { Metadata } from "next";
import type { ReactElement } from "react";

import { PageHeader } from "@/components/layout/page-header";
import { RagCreationForm } from "@/components/create/rag-creation-form";
import { t } from "@/lib/i18n";

export const metadata: Metadata = {
  title: t("create.title"),
  description: t("create.subtitle"),
};

/** RAG creation route. Interaction lives in the client form; the shell is static. */
export default function CreatePage(): ReactElement {
  return (
    <>
      <PageHeader titleKey="create.title" subtitleKey="create.subtitle" />
      <RagCreationForm />
    </>
  );
}
