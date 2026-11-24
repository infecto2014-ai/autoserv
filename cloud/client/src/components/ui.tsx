"use client";
import {
  useEffect,
  useRef,
  useId,
  isValidElement,
  cloneElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { serviceTimezone } from "../../../shared/service-time";
import { X, Search, ChevronLeft, ChevronRight } from "lucide-react";
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  const hintId = id + "-hint";
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {isValidElement(children)
        ? cloneElement(children as ReactElement<{ id?: string; "aria-describedby"?: string }>, { id, ...(hint ? { "aria-describedby": hintId } : {}) })
        : children}
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  );
}
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="notice" role="alert">
      {children}
    </div>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); close(); }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal-head">
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="icon"
          aria-label="Закрыть окно"
          onClick={close}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function SearchBox({
  value,
  onChange,
  placeholder = "Имя, телефон, номер или VIN",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="search">
      <Search size={18} aria-hidden="true" />
      <input
        aria-label="Поиск"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
export function Pagination({
  page,
  total,
  onChange,
}: {
  page: number;
  total: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="pagination">
      <span>Всего: {total}</span>
      <button
        className="secondary"
        disabled={page === 1}
        onClick={() => onChange(page - 1)}
        aria-label="Предыдущая страница"
      >
        <ChevronLeft size={16} />
      </button>
      <span>Страница {page}</span>
      <button
        className="secondary"
        disabled={page * 25 >= total}
        onClick={() => onChange(page + 1)}
        aria-label="Следующая страница"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}

export type Period = { kind: "today" | "month" | "custom" | "all"; from: string; to: string };
export const allDates: Period = { kind: "all", from: "", to: "" };

export function calendarDay() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: serviceTimezone }).format();
}

export function periodQuery(period: Period): URLSearchParams {
  const params = new URLSearchParams();
  if (period.kind !== "all") {
    const day = calendarDay();
    const from = period.kind === "custom" ? period.from : period.kind === "month" ? day.slice(0, 8) + "01" : day;
    const to = period.kind === "custom" ? period.to : day;
    if (from) params.set("from", from);
    if (to) params.set("to", to);
  }
  return params;
}

export function PeriodFilter({ value, onChange }: { value: Period; onChange: (period: Period) => void }) {
  return <div className="period-filter">
    <Field label="Период">
      <select value={value.kind} onChange={(e) => onChange({ ...value, kind: e.target.value as Period["kind"] })}>
        <option value="today">Сегодня</option>
        <option value="month">Этот месяц</option>
        <option value="custom">Свои даты</option>
        <option value="all">Всё время</option>
      </select>
    </Field>
    {value.kind === "custom" && <>
      <Field label="С"><input type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} /></Field>
      <Field label="По"><input type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} /></Field>
    </>}
  </div>;
}
