import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import type { ReactElement, ReactNode } from "react";

import { SiteFooter } from "@/components/layout/site-footer";
import { PrimaryNav } from "@/components/layout/primary-nav";
import { QueryProvider } from "@/components/providers/query-provider";
import { ThemeProvider, themeBootstrapScript } from "@/components/providers/theme-provider";
import { t } from "@/lib/i18n";

import "./globals.css";

/**
 * Root layout.
 *
 * Server Component by default; only the interactive leaves (nav, theme, query
 * provider) are client components. Fonts are self-hosted by next/font, which
 * keeps `font-src 'self'` in the CSP and removes a third-party request.
 */

const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const display = Space_Grotesk({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: {
    default: `${t("app.name")} — ${t("app.tagline")}`,
    template: `%s · ${t("app.name")}`,
  },
  description: t("app.description"),
  applicationName: t("app.name"),
  authors: [{ name: "Harley Dangan" }],
  other: { license: "MIT" },
  icons: {
    icon: [
      { url: "/brand/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/brand/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/brand/icon-192.png", sizes: "192x192" }],
  },
  openGraph: {
    title: `${t("app.name")} — ${t("app.tagline")}`,
    description: t("app.description"),
    images: [{ url: "/brand/ragdoll-logo.png", width: 579, height: 474, alt: t("app.name") }],
    type: "website",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f1e7" },
    { media: "(prefers-color-scheme: dark)", color: "#09171f" },
  ],
};

export default function RootLayout({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${display.variable} ${mono.variable}`}>
      <head>
        {/* Applies the stored theme before first paint to avoid a flash. */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body className="flex min-h-dvh flex-col font-sans">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-navy-900 focus:px-4 focus:py-2 focus:text-cream-50"
        >
          {t("nav.skipToContent")}
        </a>
        <ThemeProvider>
          <QueryProvider>
            <PrimaryNav />
            <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
              {children}
            </main>
            <SiteFooter />
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
