"use client";

import type { ReactElement, ReactNode } from "react";

import { t, type TranslationKey } from "@/lib/i18n";

/**
 * Accessible form primitives.
 *
 * Every slider and radio group carries an explicit `aria-label`, `aria-valuetext`
 * and a visible value read-out, which is what WCAG 2.1 AA asks of range inputs:
 * assistive technology must be able to announce both the current value and what
 * it measures.
 */

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  trailing,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly htmlFor?: string;
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
}): ReactElement {
  const hintId = htmlFor === undefined ? undefined : `${htmlFor}-hint`;
  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <label className="field-label" htmlFor={htmlFor}>
          {label}
        </label>
        {trailing}
      </div>
      {children}
      {/* The hint carries an id so a control can point `aria-describedby` at it
          instead of repeating the same sentence in a second, screen-reader-only
          element. */}
      {hint === undefined ? null : (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function SliderField({
  id,
  labelKey,
  value,
  min,
  max,
  step,
  valueLabel,
  hint,
  onChange,
  disabled,
}: {
  readonly id: string;
  readonly labelKey: TranslationKey;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly valueLabel: string;
  readonly hint?: string;
  readonly onChange: (next: number) => void;
  readonly disabled?: boolean;
}): ReactElement {
  const label = t(labelKey);
  return (
    <Field
      label={label}
      hint={hint}
      htmlFor={id}
      trailing={
        <output
          htmlFor={id}
          className="rounded-lg bg-surface-muted px-2.5 py-1 font-mono text-xs font-semibold text-ink"
        >
          {valueLabel}
        </output>
      }
    >
      <input
        id={id}
        type="range"
        className="slider"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={t("a11y.slider", { label, value, max })}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={valueLabel}
        onChange={(event) => {
          onChange(Number(event.target.value));
        }}
      />
      <div className="flex justify-between font-mono text-[10px] text-ink-subtle" aria-hidden>
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </Field>
  );
}

export function SegmentedControl<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
  disabled,
}: {
  readonly name: string;
  readonly legend: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string; readonly hint?: string }[];
  readonly onChange: (next: T) => void;
  readonly disabled?: boolean;
}): ReactElement {
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="field-label">{legend}</legend>
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))" }}
        role="radiogroup"
        aria-label={legend}
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <label
              key={option.value}
              className={`cursor-pointer rounded-xl border px-3 py-2 text-sm transition-colors duration-150 ${
                selected
                  ? "border-cyan-500 bg-cyan-50 text-cyan-700"
                  : "border-line bg-surface text-ink-muted hover:border-line-strong"
              } ${disabled === true ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={selected}
                disabled={disabled}
                className="sr-only"
                onChange={() => {
                  onChange(option.value);
                }}
              />
              <span className="block font-medium">{option.label}</span>
              {option.hint === undefined ? null : (
                <span className="mt-0.5 block text-xs text-ink-subtle">{option.hint}</span>
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
