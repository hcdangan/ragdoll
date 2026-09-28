import Image from "next/image";
import Link from "next/link";
import type { ReactElement } from "react";

import { t } from "@/lib/i18n";

/**
 * Brand lockup.
 *
 * The wordmark is re-typeset from the logo's own two-tone treatment ("RAG" in
 * deep navy, "doll" in cyan) rather than shipped as a raster, so it stays crisp
 * at any size and inverts with the theme. The raster master is kept for the cat
 * avatar and the favicon, where the illustration is the point.
 */

export const BRAND_LOGO_SRC = "/brand/ragdoll-logo.png";
export const BRAND_CAT_SRC = "/brand/ragdoll-cat.png";

export function Wordmark({
  size = "md",
  withTagline = false,
}: {
  readonly size?: "sm" | "md" | "lg";
  readonly withTagline?: boolean;
}): ReactElement {
  const scale = {
    sm: "text-xl",
    md: "text-2xl",
    lg: "text-4xl sm:text-5xl",
  }[size];

  return (
    <span className="flex flex-col">
      <span className={`font-display font-extrabold leading-none tracking-tight ${scale}`}>
        <span className="text-navy-900">RAG</span>
        <span className="text-cyan-500">doll</span>
      </span>
      {withTagline ? (
        <span className="mt-1 text-xs font-medium uppercase tracking-[0.22em] text-ink-subtle">
          {t("app.tagline")}
        </span>
      ) : null}
    </span>
  );
}

/** Header lockup: cat glyph plus wordmark, linking home. */
export function BrandLockup(): ReactElement {
  return (
    <Link
      href="/"
      className="group flex items-center gap-2.5 rounded-xl px-1.5 py-1 transition-colors hover:bg-surface-muted"
      aria-label={t("app.name")}
    >
      <Image
        src={BRAND_CAT_SRC}
        alt=""
        width={36}
        height={38}
        priority
        className="h-9 w-auto transition-transform duration-300 ease-brand group-hover:-translate-y-0.5"
      />
      <Wordmark size="sm" />
    </Link>
  );
}

/** The RAGdoll cat, used as the assistant avatar in chat. */
export function CatAvatar({
  size = 32,
  thinking = false,
  className = "",
}: {
  readonly size?: number;
  readonly thinking?: boolean;
  readonly className?: string;
}): ReactElement {
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center ${className}`}
      style={{ width: size, height: size }}
    >
      <Image
        src={BRAND_CAT_SRC}
        alt={t("chat.avatarAlt")}
        width={size * 2}
        height={Math.round(size * 2.1)}
        className={`h-full w-full object-contain ${thinking ? "animate-cat-bob" : ""}`}
      />
      {thinking ? (
        <span
          className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-surface border-t-cyan-500 bg-transparent"
          style={{ animation: "spin 0.9s linear infinite" }}
          aria-hidden
        />
      ) : null}
    </span>
  );
}
