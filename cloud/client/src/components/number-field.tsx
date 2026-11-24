import { useEffect, useRef, useState } from "react";
import { parseMoney, formatMoney, parseQuantity, formatQuantity } from "@/lib/money";

const withoutCurrency = (value: number) => formatMoney(value).replace(/\s*₽$/, "");
export function NumberField({
  id,
  value,
  onChange,
  quantity = false,
  disabled = false,
  label,
  onInvalidDraft,
}: {
  id?: string;
  value: number;
  onChange: (n: number) => void;
  quantity?: boolean;
  disabled?: boolean;
  label?: string;
  onInvalidDraft?: () => void;
}) {
  const display = quantity ? formatQuantity : withoutCurrency;
  const [raw, setRaw] = useState(display(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) queueMicrotask(() => setRaw(display(value)));
  }, [value, display]);
  return (
    <input
      id={id}
      className="number-input"
      aria-label={label}
      inputMode="decimal"
      value={raw}
      disabled={disabled}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(e) => {
        const text = e.target.value;
        setRaw(text);
        try {
          const n = quantity ? parseQuantity(text) : parseMoney(text);
          if (quantity && n <= 0)
            throw new Error("Количество должно быть больше нуля");
          e.target.setCustomValidity("");
          if (n !== value) onChange(n);
          else onInvalidDraft?.();
        } catch (err) {
          e.target.setCustomValidity((err as Error).message);
          onInvalidDraft?.();
        }
      }}
      onBlur={(e) => {
        focused.current = false;
        try {
          const result = quantity ? parseQuantity(raw) : parseMoney(raw);
          if (result < 0 || (quantity && result === 0))
            throw new Error(
              quantity
                ? "Количество должно быть больше нуля"
                : "Значение не может быть отрицательным",
            );
          if (result !== value) onChange(result);
          setRaw(display(result));
          e.target.setCustomValidity("");
        } catch (err) {
          e.target.setCustomValidity((err as Error).message);
          e.target.reportValidity();
        }
      }}
    />
  );
}
