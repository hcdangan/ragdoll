"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactElement } from "react";

import { BrandLockup } from "@/components/brand/logo";
import { useTheme, themeToggleLabel } from "@/components/providers/theme-provider";
import {
  IconChat,
  IconGauge,
  IconHome,
  IconMenu,
  IconClose,
  IconMoon,
  IconSun,
  IconWand,
} from "@/components/ui/icons";
import { SessionPill } from "@/components/layout/session-pill";
import { useSession } from "@/hooks/use-session";
import { t, type TranslationKey } from "@/lib/i18n";

/**
 * Primary navigation.
 *
 * Evaluate and Chat are rendered as disabled controls — not hidden links — until
 * a pipeline exists, so the workflow order stays discoverable and screen readers
 * announce *why* a destination is unavailable.
 */

interface NavItem {
  readonly href: string;
  readonly labelKey: TranslationKey;
  readonly icon: (props: { className?: string }) => ReactElement;
  readonly requiresPipeline: boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", labelKey: "nav.home", icon: IconHome, requiresPipeline: false },
  { href: "/create", labelKey: "nav.create", icon: IconWand, requiresPipeline: false },
  { href: "/evaluate", labelKey: "nav.evaluate", icon: IconGauge, requiresPipeline: true },
  { href: "/chat", labelKey: "nav.chat", icon: IconChat, requiresPipeline: true },
];

export function PrimaryNav(): ReactElement {
  const pathname = usePathname();
  const { hasPipeline } = useSession();
  const { theme, toggle } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  const items = NAV_ITEMS.map((item) => {
    const locked = item.requiresPipeline && !hasPipeline;
    const active = pathname === item.href;
    const Icon = item.icon;

    if (locked) {
      return (
        <li key={item.href}>
          <span
            className="nav-link nav-link-disabled"
            aria-disabled="true"
            title={t("nav.lockedHint")}
          >
            <Icon className="h-4 w-4" />
            {t(item.labelKey)}
          </span>
        </li>
      );
    }

    return (
      <li key={item.href}>
        <Link
          href={item.href}
          className={`nav-link ${active ? "nav-link-active" : ""}`}
          aria-current={active ? "page" : undefined}
        >
          <Icon className="h-4 w-4" />
          {t(item.labelKey)}
        </Link>
      </li>
    );
  });

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/85 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        <BrandLockup />

        <nav aria-label={t("nav.primary")} className="ml-2 hidden md:block">
          <ul className="flex items-center gap-1">{items}</ul>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <SessionPill />
          <button
            type="button"
            onClick={toggle}
            className="btn-ghost h-10 w-10 !px-0"
            aria-label={themeToggleLabel(theme)}
            title={themeToggleLabel(theme)}
          >
            {theme === "dark" ? <IconSun /> : <IconMoon />}
          </button>
          <button
            type="button"
            onClick={() => {
              setMenuOpen((open) => !open);
            }}
            className="btn-ghost h-10 w-10 !px-0 md:hidden"
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            aria-label={menuOpen ? t("nav.closeMenu") : t("nav.menu")}
          >
            {menuOpen ? <IconClose /> : <IconMenu />}
          </button>
        </div>
      </div>

      {menuOpen ? (
        <nav
          id="mobile-nav"
          aria-label={t("nav.primary")}
          className="border-t border-line bg-surface px-4 pb-4 pt-2 md:hidden"
        >
          <ul className="flex flex-col gap-1">{items}</ul>
        </nav>
      ) : null}
    </header>
  );
}
