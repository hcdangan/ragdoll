import type { ReactElement, ReactNode } from "react";

import { t } from "@/lib/i18n";

/** Consistent page header used by the three workspace routes. */
export function PageHeader({
  titleKey,
  subtitleKey,
  actions,
}: {
  readonly titleKey: "create.title" | "evaluate.title" | "chat.title";
  readonly subtitleKey: "create.subtitle" | "evaluate.subtitle" | "chat.subtitle";
  readonly actions?: ReactNode;
}): ReactElement {
  return (
    <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-3xl font-extrabold sm:text-4xl">{t(titleKey)}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">{t(subtitleKey)}</p>
      </div>
      {actions === undefined ? null : <div className="shrink-0">{actions}</div>}
    </div>
  );
}
