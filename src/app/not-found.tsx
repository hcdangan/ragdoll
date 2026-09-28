import Link from "next/link";
import type { ReactElement } from "react";

import { IconHome, IconWand } from "@/components/ui/icons";
import { t } from "@/lib/i18n";

/** 404 surface: keeps the shell and offers the two useful next steps. */
export default function NotFound(): ReactElement {
  return (
    <div className="card mx-auto max-w-lg p-8 text-center">
      <h1 className="text-2xl font-bold">{t("error.notFound")}</h1>
      <p className="mt-2 text-sm text-ink-muted">{t("app.description")}</p>
      <div className="mt-6 flex justify-center gap-3">
        <Link href="/" className="btn-secondary">
          <IconHome className="h-4 w-4" />
          {t("nav.home")}
        </Link>
        <Link href="/create" className="btn-primary">
          <IconWand className="h-4 w-4" />
          {t("home.cta.create")}
        </Link>
      </div>
    </div>
  );
}
