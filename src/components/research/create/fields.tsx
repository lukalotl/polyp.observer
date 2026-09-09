import type { ReactNode } from "react";

/** Stable id for error descriptions; labels are unique inside the creator. */
export const fieldId = (label: string) =>
  `run-field-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

export function FieldError({ label, error }: { label: string; error?: string }) {
  if (!error) return null;
  return (
    <small id={`${fieldId(label)}-error`} className="field-error" role="note">
      {error}
    </small>
  );
}

export function NumericField({
  label,
  value,
  min,
  max,
  step = 1,
  note,
  error,
  disabled,
  onChange,
  children,
}: {
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  step?: number | "any";
  note?: ReactNode;
  error?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
  /** Inline affordances rendered beside the input (buttons, readouts). */
  children?: ReactNode;
}) {
  const id = fieldId(label);
  return (
    <label className={`config-field ${error ? "has-error" : ""}`}>
      <span>{label}</span>
      <span className="field-control">
        <input
          id={id}
          aria-label={label}
          type="number"
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          value={value !== undefined && Number.isFinite(value) ? value : ""}
          onChange={(event) => onChange(event.target.valueAsNumber)}
        />
        {children}
      </span>
      {note && <small>{note}</small>}
      <FieldError label={label} error={error} />
    </label>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  note,
  error,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  note?: ReactNode;
  error?: string;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const id = fieldId(label);
  return (
    <label className={`config-field ${error ? "has-error" : ""}`}>
      <span>{label}</span>
      <select
        id={id}
        aria-label={label}
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </option>
        ))}
      </select>
      {note && <small>{note}</small>}
      <FieldError label={label} error={error} />
    </label>
  );
}

export function TextField({
  label,
  value,
  placeholder,
  note,
  error,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  note?: ReactNode;
  error?: string;
  onChange: (value: string) => void;
}) {
  const id = fieldId(label);
  return (
    <label className={`config-field ${error ? "has-error" : ""}`}>
      <span>{label}</span>
      <input
        id={id}
        aria-label={label}
        placeholder={placeholder}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {note && <small>{note}</small>}
      <FieldError label={label} error={error} />
    </label>
  );
}
