"use client";

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import { runEvaluationAction } from "@/app/actions/evaluate";
import { InlineNotice, SectionHeading } from "@/components/ui/feedback";
import { IconAlert, IconGauge, IconRefresh, IconSpinner } from "@/components/ui/icons";
import { useNotices } from "@/components/providers/notice-provider";
import { useSession } from "@/hooks/use-session";
import { t } from "@/lib/i18n";
import { EVALUATION_METRICS, type EvaluationMetric, type EvaluationReport, type MetricResult } from "@/lib/types";

/**
 * Evaluation dashboard.
 *
 * The whole suite runs server-side in one Server Action because the metric
 * definitions and the target answers must come from the same index. The panel
 * therefore shows a progress list that advances as each metric's turn arrives,
 * rather than fake percentages: the engine returns a complete report, and the UI
 * reveals it one row at a time so the wait is legible.
 */

const SAMPLE_CHOICES = [2, 4, 6, 8] as const;

const formatScore = (score: MetricResult["score"]): string =>
  score === "N/A" ? t("evaluate.na") : score.toFixed(3);

const scoreTone = (score: MetricResult["score"]): string => {
  if (score === "N/A") {
    return "text-ink-subtle";
  }
  if (score >= 0.75) {
    return "text-success";
  }
  if (score >= 0.5) {
    return "text-warning";
  }
  return "text-danger";
};

export function EvaluationDashboard(): ReactElement {
  const { hasPipeline, canEvaluate, pipeline } = useSession();
  // A failed run is reported through the fixed notification stack: the dashboard
  // is long, and the run button sits above a table and an arbitrary number of
  // samples, so an inline banner is not reliably on screen.
  const { notify } = useNotices();
  const [report, setReport] = useState<EvaluationReport | null>(null);
  const [running, setRunning] = useState(false);
  const [revealed, setRevealed] = useState<number>(EVALUATION_METRICS.length);
  const [sampleCount, setSampleCount] = useState<number>(4);

  const run = useCallback(async () => {
    setRunning(true);
    setRevealed(0);
    try {
      const result = await runEvaluationAction({ sampleCount });
      if (!result.ok) {
        notify({
          tone: "danger",
          title: t("evaluate.title"),
          message: t("evaluate.failed", { message: result.error.message }),
        });
        return;
      }
      setReport(result.data);
    } finally {
      setRunning(false);
    }
  }, [notify, sampleCount]);

  // Rows are revealed one at a time once a report lands, so the table fills in as
  // a visible sequence rather than snapping from "no data" to eight numbers.
  // Driving it from an interval (rather than awaiting inside the action) keeps the
  // progress animation independent of network timing.
  useEffect(() => {
    if (report === null) {
      return;
    }
    const total = report.metrics.length;
    const timer = window.setInterval(() => {
      setRevealed((current) => {
        if (current >= total) {
          window.clearInterval(timer);
          return current;
        }
        return current + 1;
      });
    }, 80);
    return () => {
      window.clearInterval(timer);
    };
  }, [report]);

  const metrics = useMemo<readonly MetricResult[]>(
    () =>
      report?.metrics ??
      EVALUATION_METRICS.map((metric) => ({
        metric,
        score: "N/A" as const,
        samples: 0,
        reason: "",
        skippedReason: undefined,
      })),
    [report],
  );

  const download = useCallback(() => {
    if (report === null) {
      return;
    }
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ragdoll-evaluation-${report.createdAt.replace(/[:.]/g, "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [report]);

  if (!hasPipeline) {
    return (
      <InlineNotice tone="warning" title={t("evaluate.title")}>
        {t("evaluate.requiresPipeline")}
      </InlineNotice>
    );
  }

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <SectionHeading
          title={t("evaluate.category")}
          hint={t("evaluate.subtitle")}
          action={
            <div className="flex items-center gap-2">
              <label className="field-label text-xs" htmlFor="sample-count">
                {t("evaluate.sampleCountLabel")}
              </label>
              <select
                id="sample-count"
                className="input w-20"
                value={sampleCount}
                disabled={running}
                onChange={(event) => {
                  setSampleCount(Number(event.target.value));
                }}
              >
                {SAMPLE_CHOICES.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-primary"
                disabled={running || !canEvaluate}
                onClick={() => {
                  void run();
                }}
              >
                {running ? <IconSpinner className="h-4 w-4" /> : <IconGauge className="h-4 w-4" />}
                {running
                  ? t("evaluate.running")
                  : report === null
                    ? t("evaluate.run")
                    : t("evaluate.rerun")}
              </button>
            </div>
          }
        />

        <dl className="grid gap-3 sm:grid-cols-3">
          <SummaryStat label={t("session.documents", { count: pipeline?.documents.length ?? 0 })} value={String(pipeline?.documents.length ?? 0)} />
          <SummaryStat label={t("session.chunks", { count: pipeline?.chunkCount ?? 0 })} value={String(pipeline?.chunkCount ?? 0)} />
          <SummaryStat
            label={t("evaluate.samples", { count: report?.sampleCount ?? sampleCount })}
            value={report === null ? "—" : `${(report.durationMs / 1000).toFixed(1)}s`}
          />
        </dl>

        {pipeline?.multimodal === false ? (
          <p className="field-hint mt-3">{t("evaluate.multimodalSkipped")}</p>
        ) : pipeline?.multimodal === true ? (
          <p className="field-hint mt-3">{t("evaluate.multimodalAvailable")}</p>
        ) : null}
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{t("evaluate.category")}</caption>
          <thead className="bg-surface-muted text-xs uppercase tracking-wide text-ink-subtle">
            <tr>
              <th scope="col" className="px-4 py-3 font-semibold">
                {t("evaluate.columnMetric")}
              </th>
              <th scope="col" className="px-4 py-3 font-semibold">
                {t("evaluate.columnScore")}
              </th>
              <th scope="col" className="hidden px-4 py-3 font-semibold sm:table-cell">
                {t("evaluate.columnDefinition")}
              </th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((metric, index) => {
              const visible = report === null || index < revealed;
              // The badge means "this run skipped the metric", so it only applies
              // once a report exists and the engine reported N/A for it.
              const skipped = report !== null && metric.score === "N/A";
              return (
                <tr key={metric.metric} className="border-t border-line align-top">
                  <th scope="row" className="px-4 py-3 font-medium text-ink">
                    {t(`evaluate.metric.${metric.metric}` as `evaluate.metric.${EvaluationMetric}`)}
                    {skipped ? (
                      <span className="ml-2 badge">{t("status.skipped")}</span>
                    ) : null}
                  </th>
                  <td className={`px-4 py-3 font-mono text-base font-semibold ${visible ? scoreTone(metric.score) : "text-ink-subtle"}`}>
                    {running && !visible ? (
                      <IconSpinner className="h-4 w-4" />
                    ) : (
                      formatScore(metric.score)
                    )}
                  </td>
                  <td className="hidden px-4 py-3 text-xs text-ink-muted sm:table-cell">
                    {metric.reason.length > 0 ? metric.reason : metric.skippedReason}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {report !== null ? (
        <div className="flex items-center justify-between">
          <p className="field-hint">
            {t("evaluate.duration", { seconds: (report.durationMs / 1000).toFixed(1) })}
          </p>
          <button type="button" className="btn-secondary" onClick={download}>
            <IconRefresh className="h-4 w-4" />
            {t("evaluate.download")}
          </button>
        </div>
      ) : null}

      {report !== null && report.samples.length > 0 ? (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">{t("evaluate.samplesHeading")}</h2>
          {report.samples.map((sample, index) => (
            <article key={`${sample.question}-${index}`} className="card p-4">
              <h3 className="text-sm font-semibold text-ink">
                {t("evaluate.sampleHeading", { index: index + 1 })}
              </h3>
              <p className="mt-1 text-sm text-ink">{sample.question}</p>

              <h4 className="section-title mt-4">{t("evaluate.answerHeading")}</h4>
              <p className="mt-1 whitespace-pre-wrap text-sm text-ink-muted">{sample.answer}</p>

              {sample.fallback ? (
                <p className="field-error mt-2">
                  <IconAlert className="h-3.5 w-3.5" />
                  {t("chat.fallbackNotice")}
                </p>
              ) : null}

              <h4 className="section-title mt-4">{t("evaluate.contextsHeading")}</h4>
              <ul className="mt-1 space-y-1 text-xs text-ink-muted">
                {sample.contexts.map((context, contextIndex) => (
                  <li key={contextIndex} className="line-clamp-3 rounded-lg bg-surface-muted px-3 py-2">
                    {context}
                  </li>
                ))}
              </ul>

              {sample.groundTruth !== null ? (
                <>
                  <h4 className="section-title mt-4">{t("evaluate.groundTruthHeading")}</h4>
                  <p className="mt-1 text-xs text-ink-muted">{sample.groundTruth}</p>
                </>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function SummaryStat({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className="rounded-xl border border-line bg-surface-muted px-4 py-3">
      <dt className="text-xs uppercase tracking-wide text-ink-subtle">{label}</dt>
      <dd className="mt-1 font-mono text-lg font-semibold text-ink">{value}</dd>
    </div>
  );
}
