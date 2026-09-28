import type { Metadata } from "next";
import Link from "next/link";
import type { ReactElement } from "react";

import { Wordmark } from "@/components/brand/logo";
import { IconChat, IconDatabase, IconGauge, IconSparkle, IconWand } from "@/components/ui/icons";
import { t } from "@/lib/i18n";

export const metadata: Metadata = {
  title: t("nav.home"),
  description: t("app.description"),
};

const FEATURES = [
  { icon: IconWand, titleKey: "home.feature.pipeline.title", bodyKey: "home.feature.pipeline.body" },
  { icon: IconGauge, titleKey: "home.feature.evaluate.title", bodyKey: "home.feature.evaluate.body" },
  { icon: IconChat, titleKey: "home.feature.chat.title", bodyKey: "home.feature.chat.body" },
] as const;

const STEPS = [
  { titleKey: "home.how.step1.title", bodyKey: "home.how.step1.body" },
  { titleKey: "home.how.step2.title", bodyKey: "home.how.step2.body" },
  { titleKey: "home.how.step3.title", bodyKey: "home.how.step3.body" },
] as const;

/**
 * Landing page.
 *
 * Server Component: nothing here is interactive beyond links, so it renders to
 * static HTML with no client JavaScript of its own.
 */
export default function HomePage(): ReactElement {
  return (
    <div className="space-y-16">
      <section className="grid items-center gap-10 lg:grid-cols-[1.15fr_1fr]">
        <div>
          <p className="badge-brand">
            <IconSparkle className="h-3.5 w-3.5" />
            {t("home.hero.eyebrow")}
          </p>
          <h1 className="mt-4 text-4xl font-extrabold leading-[1.05] sm:text-5xl">
            {t("home.hero.title")}
          </h1>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-ink-muted">
            {t("home.hero.subtitle")}
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link href="/create" className="btn-primary">
              <IconWand className="h-4 w-4" />
              {t("home.cta.create")}
            </Link>
            <Link href="/chat" className="btn-secondary">
              <IconChat className="h-4 w-4" />
              {t("home.cta.chat")}
            </Link>
            <Link href="/evaluate" className="btn-ghost">
              <IconGauge className="h-4 w-4" />
              {t("home.cta.evaluate")}
            </Link>
          </div>
        </div>

        <div className="card overflow-hidden bg-grid-fade p-6">
          <Wordmark size="lg" withTagline />
          <p className="mt-5 text-sm leading-relaxed text-ink-muted">{t("app.description")}</p>
          <dl className="mt-6 grid grid-cols-2 gap-3 text-sm">
            <Stat title="Providers" value="4" />
            <Stat title="Embedding models" value="6" />
            <Stat title="RAG metrics" value="8" />
            <Stat title="PDFs / session" value="3" />
          </dl>
        </div>
      </section>

      <section aria-labelledby="features-heading">
        <h2 id="features-heading" className="text-2xl font-bold">
          {t("home.features.title")}
        </h2>
        <ul className="mt-6 grid gap-4 md:grid-cols-3">
          {FEATURES.map((feature) => {
            const Icon = feature.icon;
            return (
              <li key={feature.titleKey} className="card p-5">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-100 text-cyan-600">
                  <Icon width={20} height={20} />
                </span>
                <h3 className="mt-3 text-base font-semibold">
                  {t(feature.titleKey as "home.feature.pipeline.title")}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                  {t(feature.bodyKey as "home.feature.pipeline.body")}
                </p>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="how-heading">
        <h2 id="how-heading" className="text-2xl font-bold">
          {t("home.how.title")}
        </h2>
        <ol className="mt-6 grid gap-4 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.titleKey} className="card-muted p-5">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-navy-900 font-mono text-sm font-semibold text-cream-50">
                {index + 1}
              </span>
              <h3 className="mt-3 text-base font-semibold">
                {t(step.titleKey as "home.how.step1.title")}
              </h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                {t(step.bodyKey as "home.how.step1.body")}
              </p>
            </li>
          ))}
        </ol>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="card p-5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <IconDatabase className="h-4 w-4 text-cyan-500" />
            {t("home.stack.title")}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">{t("home.stack.body")}</p>
        </div>
        <div className="card p-5">
          <h2 className="text-base font-semibold">{t("home.license.title")}</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">{t("home.license.body")}</p>
          <Link
            className="mt-3 inline-flex text-sm font-semibold text-cyan-600 underline decoration-cyan-400/60 underline-offset-2 hover:text-cyan-500"
            href="https://github.com/hcdangan/ragdoll/blob/main/LICENSE"
            rel="noreferrer noopener"
            target="_blank"
          >
            {t("home.license.link")}
          </Link>
        </div>
      </section>
    </div>
  );
}

function Stat({ title, value }: { readonly title: string; readonly value: string }): ReactElement {
  return (
    <div className="rounded-xl border border-line bg-surface/70 px-3 py-2.5">
      <dt className="text-xs uppercase tracking-wide text-ink-subtle">{title}</dt>
      <dd className="font-mono text-lg font-semibold text-ink">{value}</dd>
    </div>
  );
}
