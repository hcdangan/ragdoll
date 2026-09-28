"use client";

import { useState, type ReactElement } from "react";

import { IconEye, IconEyeOff, IconLock } from "@/components/ui/icons";
import { Field } from "@/components/ui/form-fields";
import { t } from "@/lib/i18n";

/**
 * Masked secret input.
 *
 * The toggle is a real button with `aria-pressed`, so a screen-reader user gets
 * the same affordance a sighted user does. The value is never rendered anywhere
 * else — no copy button, no autocomplete, no persisted form state.
 */
export function SecretField({
  id,
  label,
  value,
  placeholder,
  hint,
  error,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly disabled?: boolean;
  readonly onChange: (next: string) => void;
}): ReactElement {
  const [revealed, setRevealed] = useState(false);

  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      htmlFor={id}
      trailing={
        <span className="badge">
          <IconLock className="h-3 w-3" />
          {t("credentials.stored")}
        </span>
      }
    >
      <div className="relative">
        <input
          id={id}
          type={revealed ? "text" : "password"}
          className="input-mono pr-12"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${id}-hint`}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
        <button
          type="button"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg p-2 text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink"
          aria-pressed={revealed}
          aria-label={revealed ? t("credentials.hide") : t("credentials.show")}
          title={revealed ? t("credentials.hide") : t("credentials.show")}
          onClick={() => {
            setRevealed((current) => !current);
          }}
        >
          {revealed ? <IconEyeOff className="h-4 w-4" /> : <IconEye className="h-4 w-4" />}
        </button>
      </div>
    </Field>
  );
}
