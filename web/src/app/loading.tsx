import type { ReactElement } from "react";

import { IconSpinner } from "@/components/ui/icons";
import { t } from "@/lib/i18n";

/** Route-group loading state shown while a segment's data resolves. */
export default function SegmentLoading(): ReactElement {
  return (
    <div className="flex items-center gap-3 text-sm text-ink-muted" role="status" aria-live="polite">
      <IconSpinner className="h-4 w-4" />
      {t("a11y.loading")}
    </div>
  );
}
