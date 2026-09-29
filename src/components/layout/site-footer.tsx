import Link from "next/link";
import type { ReactElement } from "react";

import { t } from "@/lib/i18n";

/** Site footer with the licence notice the home page is required to surface. */
export function SiteFooter(): ReactElement {
  return (
    <footer className="mt-16 border-t border-line bg-surface">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          <span className="font-semibold text-ink">{t("app.name")}</span> · {t("app.tagline")}
        </p>
        <p className="text-ink-subtle">
          {t("home.license.title")} · MIT · © 2026 Harley Dangan ·{" "}
          <Link
            className="font-medium text-ink underline decoration-cyan-500 decoration-2 underline-offset-2 hover:decoration-4"
            href="https://github.com/hcdangan/ragdoll/blob/main/LICENSE"
            rel="noreferrer noopener"
            target="_blank"
          >
            {t("home.license.link")}
          </Link>
        </p>
      </div>
    </footer>
  );
}
