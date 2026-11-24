import { useState, type FormEvent } from "react";
import type { DocumentMeta, OrderDetail } from "@/lib/types";
import { api, ApiError } from "@/lib/client";
import { formatMoney, formatQuantity } from "@/lib/money";
import { useDraftGuard, useRetryableWrite } from "@/lib/workflow";
import { calculateWorkflowTotals } from "../../../shared/workflow-money";
import { Empty, Field, Modal, Notice } from "./ui";

export function documentLabel(doc: DocumentMeta) {
  if (doc.kind === "INSPECTION") return "Акт осмотра";
  return doc.templateVersion.startsWith("completion-act-") ? "Акт выполненных работ" : "Заказ-наряд";
}

export function ActForm({ mode, order, close, saved, onDraft, onConflict }: {
  mode: "deliver" | "version"; order: OrderDetail; close: () => void;
  saved: (doc: DocumentMeta, order: OrderDetail | null, warning?: string) => void;
  onDraft: (value: boolean) => void; onConflict: (message: string) => void;
}) {
  const [includeRecommendations, setInclude] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const write = useRetryableWrite<{ order: OrderDetail; document: DocumentMeta }>();
  const deliver = mode === "deliver";
  const legacy = order.financialMode === "LEGACY";
  const actual = order.lines.filter((line) => line.approval === "APPROVED" && line.completed);
  const unresolved = order.lines.find((line) => line.approval === "PENDING" || (line.approval === "APPROVED" && !line.completed));
  let amount = order.totals;
  let blocked = "";
  if (legacy) blocked = "Сначала проверьте прежний расчёт в разделе «Работы и запчасти».";
  else if (unresolved) blocked = unresolved.approval === "PENDING"
    ? `Укажите решение клиента по позиции «${unresolved.name}».`
    : `Отметьте выполнение или отложите позицию «${unresolved.name}».`;
  else {
    try { amount = calculateWorkflowTotals(actual, order.discountCents, order.paidCents, true); }
    catch (err) { blocked = (err as Error).message; }
  }
  function done() {
    onDraft(false);
    close();
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || conflict || (blocked && !write.uncertain)) return;
    setBusy(true);
    setError("");
    onDraft(true);
    try {
      const path = `/orders/${order.id}`;
      const body = { version: order.version, includeRecommendations };
      if (deliver) {
        const result = await write.send(path + "/deliver", body);
        saved(result.document, result.order);
      } else {
        const doc = await api<DocumentMeta>(path + "/documents", "POST", { kind: "WORK_ORDER", ...body });
        try { saved(doc, await api<OrderDetail>(path)); }
        catch { saved(doc, null, "Акт сохранён. Обновите карточку, чтобы увидеть его в истории."); }
      }
      onDraft(false);
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      if (err instanceof ApiError && err.status === 409 && /заказ изменён|обновите данные/i.test(message)) {
        setConflict(true);
        onConflict(message);
      }
    } finally {
      setBusy(false);
    }
  }
  return <Modal title={deliver ? "Выдача автомобиля" : "Новая версия акта"} close={() => { if (!busy && !write.uncertain) done(); }}>
    <form onSubmit={submit}>
      {blocked && <Notice>{blocked}</Notice>}
      {error && <Notice>{error}{write.uncertain && " Повторите отправку, чтобы проверить результат."}</Notice>}
      <h3>Фактически выполнено</h3>
      {actual.length ? <ul className="act-lines">{actual.map((line) => <li key={line.id}>
        {line.name} · {formatQuantity(line.quantityMilli)}{line.partSource === "CUSTOMER" && " · Деталь клиента"}
      </li>)}</ul> : <Empty>Выполненных позиций нет.</Empty>}
      <dl className="act-totals">
        <div><dt>Итого</dt><dd>{formatMoney(amount.totalCents)}</dd></div>
        <div><dt>Оплачено</dt><dd>{formatMoney(amount.paidCents)}</dd></div>
        <div><dt>Долг</dt><dd>{formatMoney(amount.balanceCents)}</dd></div>
      </dl>
      <label className="check-label">
        <input type="checkbox" checked={includeRecommendations} disabled={busy || write.uncertain} onChange={(e) => {
          setInclude(e.target.checked); onDraft(e.target.checked);
        }} /> Включить рекомендации и отложенные позиции
      </label>
      <div className="form-footer">
        <button type="button" className="secondary" disabled={busy || write.uncertain} onClick={done}>Отмена</button>
        <button className="primary" disabled={busy || conflict || (!!blocked && !write.uncertain)}>
          {busy ? "Формируем акт…" : write.uncertain ? "Повторить выдачу" : deliver ? "Выдать и сформировать акт" : "Сформировать акт"}
        </button>
      </div>
    </form>
  </Modal>;
}

export function OrderDetailsForm({ order, close, save }: {
  order: OrderDetail; close: () => void; save: (values: Record<string, unknown>) => Promise<OrderDetail>;
}) {
  const [complaint, setComplaint] = useState(order.complaint);
  const [comment, setComment] = useState(order.comment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changed = complaint !== order.complaint || comment !== order.comment;
  useDraftGuard(changed || busy, setError);
  function cancel() {
    if (!busy && (!changed || confirm("Закрыть форму и сбросить правки?"))) close();
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try { await save({ complaint, comment }); close(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <Modal title="Сведения о заказе" close={cancel}>
    <form onSubmit={submit}>
      <Field label="Жалоба / причина обращения"><textarea required maxLength={5000} value={complaint} disabled={busy} onChange={(e) => setComplaint(e.target.value)} /></Field>
      <Field label="Комментарий к заказу"><textarea maxLength={5000} value={comment} disabled={busy} onChange={(e) => setComment(e.target.value)} /></Field>
      {error && <Notice>{error}</Notice>}
      <div className="form-footer">
        <button className="secondary" type="button" disabled={busy} onClick={cancel}>Отмена</button>
        <button className="primary" disabled={busy || !changed}>{busy ? "Сохраняем…" : "Сохранить сведения"}</button>
      </div>
    </form>
  </Modal>;
}
