import Image from "next/image";
import Link from "next/link";
import type { ReactElement } from "react";

import { t } from "@/lib/i18n";

/**
 * Brand lockup.
 *
 * The cat is a light illustration on a white field, so it is always placed on a
 * white plate — in both themes, which is why the plate is `bg-white` and not the
 * theme-aware `bg-surface`. Dropped straight onto dark teal it stopped reading as
 * a logo at all; the asset itself is generated with its white field baked in (see
 * `tools/slice-assets.mjs`), so the plate only rounds the corners.
 *
 * The wordmark is re-typeset from the logo's own two-tone treatment rather than
 * shipped as a raster, so it stays crisp at any size. Logotypes are exempt from
 * the WCAG contrast minimums, which is what lets "doll" keep the brand blue that
 * body text never uses.
 */

export const BRAND_LOGO_SRC = "/brand/ragdoll-logo.png";
export const BRAND_CAT_SRC = "/brand/ragdoll-cat.png";

/** Aspect ratio of the generated cat asset, so next/image never distorts it. */
const CAT_WIDTH = 314;
const CAT_HEIGHT = 306;

/** White field behind the mark. Literal white on purpose: see the note above. */
const PLATE = "flex items-center justify-center overflow-hidden rounded-2xl bg-white";

export function Wordmark({
  size = "md",
  withTagline = false,
}: {
  readonly size?: "sm" | "md" | "lg";
  readonly withTagline?: boolean;
}): ReactElement {
  const scale = {
    sm: "text-2xl",
    md: "text-3xl",
    lg: "text-4xl sm:text-5xl",
  }[size];

  return (
    <span className="flex flex-col">
      {/* Marked as a logotype: WCAG's contrast minimums exempt logos and brand
          names, which is what lets "doll" keep the brand blue on a light field. */}
      <span
        data-logotype="true"
        className={`font-display font-extrabold leading-none tracking-tight ${scale}`}
      >
        <span className="text-navy-900">RAG</span>
        <span className="text-cyan-500">doll</span>
      </span>
      {withTagline ? (
        <span className="mt-1.5 text-xs font-medium uppercase tracking-[0.22em] text-ink">
          {t("app.tagline")}
        </span>
      ) : null}
    </span>
  );
}

/** Header lockup: cat on its plate plus wordmark, linking home. */
export function BrandLockup(): ReactElement {
  return (
    <Link
      href="/"
      className="group flex items-center gap-3 rounded-xl py-1 pl-1 pr-2 transition-colors hover:bg-surface-muted"
      aria-label={t("app.name")}
    >
      <span
        className={`${PLATE} h-14 w-14 shrink-0 p-1.5 shadow-card ring-1 ring-line transition-transform duration-300 ease-brand group-hover:-translate-y-0.5`}
      >
        <Image
          src={BRAND_CAT_SRC}
          alt=""
          width={CAT_WIDTH}
          height={CAT_HEIGHT}
          priority
          className="h-full w-full object-contain"
        />
      </span>
      <Wordmark size="md" />
    </Link>
  );
}

/** The RAGdoll cat, used as the assistant avatar in chat. */
export function CatAvatar({
  size = 44,
  thinking = false,
  className = "",
}: {
  readonly size?: number;
  readonly thinking?: boolean;
  readonly className?: string;
}): ReactElement {
  return (
    // No percentage padding here: percentage padding resolves against the
    // *containing block's* width, so `p-[7%]` inside a 34px avatar inherited a
    // 50px inset from the chat column and blew the box up to 99px — with the
    // image squeezed to nothing. The generated asset carries its own white
    // margin, so `object-contain` in a square plate is all the inset needed.
    <span
      className={`${PLATE} relative shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      <Image
        src={BRAND_CAT_SRC}
        alt={t("chat.avatarAlt")}
        width={CAT_WIDTH}
        height={CAT_HEIGHT}
        className={`h-full w-full object-contain ${thinking ? "animate-cat-bob" : ""}`}
      />
      {thinking ? (
        <span
          className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-cyan-500 border-t-transparent bg-white"
          style={{ animation: "spin 0.9s linear infinite" }}
          aria-hidden
        />
      ) : null}
    </span>
  );
}
