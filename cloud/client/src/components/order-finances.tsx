import { useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { OrderDetail, OrderLine, Payment } from "@/lib/types";
import { ApiError, date } from "@/lib/client";
import { formatMoney, formatQuantity, parseMoney } from "@/lib/money";
import { useRetryableWrite } from "@/lib/workflow";
import { NumberField } from "./number-field";
import { Empty, Field, Modal, Notice } from "./ui";

const approvals = [
  ["PENDING", "Не согласовано"], ["APPROVED", "Делаем"], ["DEFERRED", "Не сейчас"],
] as const;
const paymentLabels = { OPENING: "Перенесённая оплата", PAYMENT: "Оплата", REFUND: "Возврат" };
type Draft = "lines" | "discount" | "review" | "payment" | null;
type Row = OrderLine & { key: string };
type Decision = Pick<OrderLine, "approval" | "completed" | "partSource">;
type Mutate = (path: string, method: string, body: Record<string, unknown>) => Promise<OrderDetail>;

function rows(lines: OrderLine[]): Row[] {
  return lines.map((line) => ({ ...line, key: line.id ?? crypto.randomUUID() }));
}

export function OrderFinances({ order, master, disabled, onDraft, mutate, onPayment, onBusy, onConflict }: {
  order: OrderDetail; master: boolean; disabled: boolean;
  onDraft: (value: boolean) => void; mutate: Mutate;
  onPayment: (order: OrderDetail) => void; onBusy: (value: boolean) => void; onConflict: (message: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(null);
  const [changes, setChanges] = useState<Row[]>([]);
  const [revision, reset] = useState(0);
  const [discount, setDiscount] = useState(order.discountCents);
  const [payment, setPayment] = useState<"PAYMENT" | "REFUND" | null>(null);
  const [error, setError] = useState("");
  const { totals, legacySnapshot } = order;
  const legacy = order.financialMode === "LEGACY";
  function mark(value: Draft) {
    setDraft(value);
    onDraft(value !== null);
  }
  function discard() {
    setChanges([]);
    setDiscount(order.discountCents);
    setError("");
    mark(null);
    reset((n) => n + 1);
  }
  function updateRows(update: (current: Row[]) => Row[]) {
    setChanges((current) => update(draft === "lines" ? current : rows(order.lines)));
    mark("lines");
  }
  const current = draft === "lines" ? changes : rows(order.lines);
  async function saveRows(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      // API rows carry database metadata. Send only fields accepted by /lines.
      const lines = current.map(({ id, kind, name, quantityMilli, unitPriceCents, variant, article, approval, completed, partSource }) => ({
        id, kind, name, quantityMilli, unitPriceCents, variant, article, approval, completed, partSource,
      }));
      await mutate("/lines", "PUT", { lines });
      discard();
    } catch (err) { setError((err as Error).message); }
  }
  async function saveDiscount(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await mutate("", "PATCH", { discountCents: discount });
      discard();
    } catch (err) { setError((err as Error).message); }
  }
  if (master) return <section className="panel pad">
    <h2>Назначенные работы и запчасти</h2>
    {order.lines.length ? <ul className="masters-list">{order.lines.map((line) =>
      <li key={line.id}>{line.name} · {formatQuantity(line.quantityMilli)}</li>,
    )}</ul> : <Empty>Позиции ещё не добавлены.</Empty>}
  </section>;

  const allowLines = !disabled && (draft === null || draft === "lines");
  const allowDiscount = !disabled && (draft === null || draft === "discount");
  const refundAmounts = new Map<string, number>();
  for (const p of order.payments) {
    if (p.relatedPaymentId) refundAmounts.set(p.relatedPaymentId, (refundAmounts.get(p.relatedPaymentId) ?? 0) + p.amountCents);
  }
  const refundable = order.payments.filter((p) => p.kind !== "REFUND" && p.amountCents > (refundAmounts.get(p.id) ?? 0));
  const unallocated = order.payments.reduce((sum, p) => sum + (p.kind === "REFUND" ? -p.unallocatedCents : p.unallocatedCents), 0);
  return <>
    <div className="financial-layout">
      {legacy ? <LegacyReview order={order} disabled={disabled || (draft !== null && draft !== "review")}
        onDraft={(active) => mark(active ? "review" : null)} save={(body) => mutate("/review-finances", "POST", body)} />
        : <form className="panel" key={revision} onSubmit={saveRows} onChangeCapture={() => {
          // Retain the draft even while an input contains an incomplete value.
          if (draft === null) updateRows((existing) => existing);
        }}>
          <div className="panel-heading">
            <div><h2>Работы и запчасти</h2><p>Решение клиента и факт выполнения отмечаются отдельно.</p></div>
            <div className="actions">
              {draft === "lines" && <button type="button" className="secondary" onClick={discard}>Сбросить правки</button>}
              <button className="primary" disabled={!allowLines || draft !== "lines"}>Сохранить строки</button>
            </div>
          </div>
          {(["LABOR", "PART"] as const).map((kind) => <section className="line-section" key={kind}>
            <div className="line-heading">
              <h3>{kind === "LABOR" ? "Работы" : "Запчасти"}</h3>
              <button type="button" className="secondary" disabled={!allowLines} onClick={() => updateRows((ls) => [...ls, {
                key: crypto.randomUUID(), kind, name: "", quantityMilli: 1000, unitPriceCents: 0, variant: "NONE",
                article: "", approval: "PENDING", partSource: "SERVICE", completed: false,
              }])}><Plus size={16} /> {kind === "LABOR" ? "Добавить работу" : "Добавить запчасть"}</button>
            </div>
            {current.filter((line) => line.kind === kind).map((line) => <LineEditor key={line.key} line={line} disabled={!allowLines}
              update={(patch) => updateRows((ls) => ls.map((row) => row.key === line.key ? { ...row, ...patch } : row))}
              remove={() => updateRows((ls) => ls.filter((row) => row.key !== line.key))} />)}
            {!current.some((line) => line.kind === kind) && <Empty>Позиции ещё не добавлены.</Empty>}
          </section>)}
          {draft === "lines" && <p role="status" className="muted pad">Есть несохранённые правки строк.</p>}
        </form>}
      <section className="panel total-panel">
        <h2>Расчёт заказа</h2>
        <dl>
          <div><dt>Работы</dt><dd>{formatMoney(totals.laborCents)}</dd></div>
          <div><dt>Запчасти сервиса</dt><dd>{formatMoney(totals.partsCents)}</dd></div>
          <div><dt>Скидка на работы</dt><dd>{formatMoney(totals.discountCents)}</dd></div>
        </dl>
        {!legacy && <form onSubmit={saveDiscount} key={revision} onChangeCapture={() => {
          if (draft === null) { setDiscount(order.discountCents); mark("discount"); }
        }}>
          <Field label="Скидка на работы, ₽">
            <NumberField value={draft === "discount" ? discount : order.discountCents}
              disabled={!allowDiscount} onChange={(n) => { setDiscount(n); mark("discount"); }} />
          </Field>
          <div className="actions">
            <button className="secondary" disabled={!allowDiscount || draft !== "discount"}>Сохранить скидку</button>
            {draft === "discount" && <button className="secondary" type="button" onClick={discard}>Сбросить скидку</button>}
          </div>
        </form>}
        <div className="total-final"><span>Итого</span><strong>{formatMoney(totals.totalCents)}</strong></div>
        <dl><div><dt>Оплачено</dt><dd>{formatMoney(totals.paidCents)}</dd></div></dl>
        <div className="total-balance"><span>Долг</span><strong>{formatMoney(totals.balanceCents)}</strong></div>
        {totals.totalCents > 0 && totals.balanceCents === 0 && <p className="paid-label">Оплачено полностью</p>}
        {totals.overpaidCents > 0 && <p>{totals.totalCents === 0 ? "Получено авансом" : "Переплата"} · {formatMoney(totals.overpaidCents)}</p>}
        {!legacy && <small>Итог включает сохранённые согласованные{order.status === "DELIVERED" ? " и выполненные" : ""} позиции. Отложенные и детали клиента не входят в оплату.</small>}
        {!legacy && legacySnapshot && <details>
          <summary>Перенесённый расчёт</summary>
          <p>Итого {formatMoney(legacySnapshot.totalCents)} · Скидка {formatMoney(legacySnapshot.discountCents)} · Оплачено {formatMoney(legacySnapshot.paidCents)}</p>
        </details>}
      </section>
    </div>
    {error && <Notice>{error}</Notice>}
    <section className="panel payments-panel">
      <div className="panel-heading"><div><h2>Платежи и возвраты</h2>
        {unallocated > 0 && <p>Без распределения на работы и запчасти · {formatMoney(unallocated)}</p>}
      </div><div className="actions">
        <button className="primary" disabled={disabled || draft !== null} onClick={() => { setPayment("PAYMENT"); mark("payment"); }}>Внести оплату</button>
        <button className="secondary" disabled={disabled || draft !== null || !refundable.length} onClick={() => { setPayment("REFUND"); mark("payment"); }}>Оформить возврат</button>
      </div></div>
      {order.payments.length ? <div className="table-wrap"><table>
        <thead><tr><th>Операция</th><th>Дата</th><th>Работы</th><th>Запчасти</th><th>Без распределения</th><th>Сумма</th></tr></thead>
        <tbody>{order.payments.map((p) => <tr key={p.id}>
          <td>{paymentLabels[p.kind]}{p.reason && <small>{p.reason}</small>}</td><td>{p.occurredAt ? date(p.occurredAt) : "Дата не указана"}</td>
          {[p.laborCents, p.partsCents, p.unallocatedCents, p.amountCents].map((sum, i) =>
            <td key={i}>{formatMoney(p.kind === "REFUND" && sum > 0 ? -sum : sum)}</td>,
          )}
        </tr>)}</tbody>
      </table></div> : <Empty>Платежей пока нет.</Empty>}
    </section>
    {payment && <PaymentForm kind={payment} order={order} sources={refundable} refundAmounts={refundAmounts}
      cancel={() => { setPayment(null); mark(null); }}
      saved={(updated) => { setPayment(null); mark(null); onPayment(updated); }}
      onBusy={onBusy} onConflict={onConflict} />}
  </>;
}

function LineEditor({ line, disabled, update, remove }: {
  line: Row; disabled: boolean; update: (patch: Partial<OrderLine>) => void; remove: () => void;
}) {
  return <fieldset className="line-card" disabled={disabled}>
    <div className="line-fields">
      <Field label="Наименование">
        <input value={line.name} required maxLength={500} onChange={(e) => update({ name: e.target.value })} />
      </Field>
      <Field label="Количество">
        <NumberField quantity value={line.quantityMilli} onChange={(n) => update({ quantityMilli: n })} />
      </Field>
      <Field label="Цена за единицу, ₽">
        <NumberField value={line.unitPriceCents} onChange={(n) => update({ unitPriceCents: n })} />
      </Field>
      {line.kind === "PART" && <>
        <Field label="Артикул"><input value={line.article} maxLength={120} onChange={(e) => update({ article: e.target.value })} /></Field>
        <Field label="Вариант"><select value={line.variant} onChange={(e) => update({ variant: e.target.value as OrderLine["variant"] })}>
          <option value="NONE">Не указан</option><option value="ORIGINAL">Оригинал</option>
          <option value="ANALOG">Аналог</option><option value="CUSTOM">Другой</option>
        </select></Field>
        <Field label="Источник детали"><select value={line.partSource} onChange={(e) => update({ partSource: e.target.value as OrderLine["partSource"] })}>
          <option value="SERVICE">Автосервис</option><option value="CUSTOMER">Клиент</option>
        </select></Field>
      </>}
    </div>
    <div className="line-decisions">
      <Field label="Решение клиента"><select value={line.approval} onChange={(e) => update({ approval: e.target.value as Decision["approval"] })}>
        {approvals.map(([key, value]) => <option value={key} key={key}>{value}</option>)}
      </select></Field>
      <label className="check-label"><input type="checkbox" checked={line.completed} onChange={(e) => update({ completed: e.target.checked })} /> Выполнено</label>
      {line.approval === "DEFERRED" && <span className="muted">Вне итога</span>}
      {line.partSource !== "CUSTOMER" && <span>Сумма строки {formatMoney(Number((BigInt(line.unitPriceCents) * BigInt(line.quantityMilli) + 500n) / 1000n))}</span>}
      {line.kind === "PART" && line.partSource === "CUSTOMER" && <span className="muted">Без оплаты сервису</span>}
      <button type="button" className="icon danger" aria-label={`Удалить: ${line.name || "новая строка"}`} onClick={remove}><Trash2 size={17} /></button>
    </div>
  </fieldset>;
}

function LegacyReview({ order, disabled, onDraft, save }: {
  order: OrderDetail; disabled: boolean; onDraft: (value: boolean) => void;
  save: (body: Record<string, unknown>) => Promise<OrderDetail>;
}) {
  const [decisions, setDecisions] = useState<Partial<Record<string, Partial<Decision>>>>({});
  const [discount, setDiscount] = useState(order.legacySnapshot?.discountCents ?? 0);
  const [confirmed, setConfirmed] = useState(false);
  const [revision, reset] = useState(0);
  const [error, setError] = useState("");
  function decide(id: string, patch: Partial<Decision>) {
    setDecisions((map) => ({ ...map, [id]: { ...map[id], ...patch } }));
    onDraft(true);
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!confirmed) return;
    setError("");
    try {
      const checked = order.lines.map((line) => {
        const id = line.id!;
        const decision = decisions[id];
        if (!decision?.approval || decision.completed === undefined || (line.kind === "PART" && !decision.partSource))
          throw new Error(`Укажите решение, выполнение и источник для позиции «${line.name}».`);
        return { id, approval: decision.approval, completed: decision.completed, partSource: decision.partSource ?? "SERVICE" };
      });
      await save({ decisions: checked, discountCents: discount });
      onDraft(false);
    } catch (err) { setError((err as Error).message); }
  }
  return <form key={revision} className="panel pad" onSubmit={submit} onChange={() => onDraft(true)}>
    <h2>Сверка прежнего расчёта</h2>
    <p>Прежний итог {formatMoney(order.totals.totalCents)}, скидка {formatMoney(order.totals.discountCents)}. Сверьте согласие и выполнение каждой сохранённой позиции. После подтверждения будет рассчитан новый итог.</p>
    {order.lines.map((line) => {
      const id = line.id!;
      return <fieldset className="line-card" key={id} disabled={disabled}>
        <legend>{line.name} · {formatQuantity(line.quantityMilli)} × {formatMoney(line.unitPriceCents)}</legend>
        <div className="line-fields">
          <Field label="Решение клиента"><select required value={decisions[id]?.approval ?? ""} onChange={(e) => decide(id, { approval: e.target.value as Decision["approval"] })}>
            <option value="">Выберите решение</option>
            {approvals.map(([key, value]) => <option key={key} value={key}>{value}</option>)}
          </select></Field>
          <Field label="Факт выполнения"><select required value={String(decisions[id]?.completed ?? "")} onChange={(e) => decide(id, { completed: e.target.value ? e.target.value === "true" : undefined })}>
            <option value="">Выберите состояние</option><option value="true">Выполнено</option><option value="false">Не выполнено</option>
          </select></Field>
          {line.kind === "PART" && <Field label="Источник детали"><select required value={decisions[id]?.partSource ?? ""} onChange={(e) => decide(id, { partSource: e.target.value as Decision["partSource"] })}>
            <option value="">Выберите источник</option><option value="SERVICE">Автосервис</option><option value="CUSTOMER">Клиент</option>
          </select></Field>}
        </div>
      </fieldset>;
    })}
    <Field label="Скидка на работы после сверки, ₽"><NumberField value={discount} onChange={setDiscount} disabled={disabled} /></Field>
    <label className="check-label"><input type="checkbox" required checked={confirmed} disabled={disabled} onChange={(e) => setConfirmed(e.target.checked)} /> Подтверждаю решения и скидку</label>
    {error && <Notice>{error}</Notice>}
    <div className="form-footer">
      <button className="secondary" type="button" onClick={() => {
        setDecisions({}); setConfirmed(false); setDiscount(order.legacySnapshot?.discountCents ?? 0);
        setError(""); onDraft(false); reset((n) => n + 1);
      }}>Сбросить сверку</button>
      <button className="primary" disabled={disabled || !confirmed}>Сохранить сверку</button>
    </div>
  </form>;
}

function PaymentForm({ kind, order, sources, refundAmounts, cancel, saved, onBusy, onConflict }: {
  kind: "PAYMENT" | "REFUND"; order: OrderDetail; sources: Payment[]; refundAmounts: Map<string, number>;
  cancel: () => void; saved: (order: OrderDetail) => void;
  onBusy: (value: boolean) => void; onConflict: (message: string) => void;
}) {
  const [amount, setAmount] = useState("");
  const [source, setSource] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const write = useRetryableWrite<OrderDetail>();
  const refund = kind === "REFUND";
  function close() {
    if (busy || write.uncertain) return;
    if (!(amount || source || reason) || confirm("Закрыть форму платежа и сбросить ввод?")) cancel();
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      const amountCents = parseMoney(amount);
      if (!amountCents) throw new Error("Укажите сумму больше нуля.");
      const updated = await write.send(`/orders/${order.id}/payments`, {
        version: order.version, amountCents, kind,
        ...(refund ? { relatedPaymentId: source, reason: reason.trim() } : {}),
      });
      saved(updated);
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      if (err instanceof ApiError && err.status === 409 && /заказ изменён|обновите данные/i.test(message)) onConflict(message);
    } finally {
      onBusy(false);
      setBusy(false);
    }
  }
  return <Modal title={refund ? "Возврат оплаты" : "Оплата заказа"} close={close}>
    <form onSubmit={submit}>
      {error && <Notice>{error}{write.uncertain && " Повторите отправку, чтобы проверить результат."}</Notice>}
      <fieldset className="form-fields" disabled={busy || write.uncertain}>
        {refund && <Field label="Исходный платёж"><select required value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Выберите платёж</option>
          {sources.map((p) => <option value={p.id} key={p.id}>{p.occurredAt ? date(p.occurredAt) : "Без даты"} · {formatMoney(p.amountCents)} · доступно {formatMoney(p.amountCents - (refundAmounts.get(p.id) ?? 0))}</option>)}
        </select></Field>}
        <Field label="Сумма, ₽"><input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        {refund && <Field label="Причина возврата"><textarea required maxLength={1000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
      </fieldset>
      <div className="form-footer">
        <button type="button" className="secondary" disabled={busy || write.uncertain} onClick={close}>Отмена</button>
        <button className="primary" disabled={busy}>{busy ? "Сохраняем…" : write.uncertain ? "Повторить отправку" : refund ? "Записать возврат" : "Записать оплату"}</button>
      </div>
    </form>
  </Modal>;
}
