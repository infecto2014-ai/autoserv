"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Download,
  ExternalLink,
  FileText,
  Plus,
  Printer,
  RefreshCw,
  Save,
} from "lucide-react";
import type {
  Actor,
  Staff,
  OrderDetail,
  InspectionItem,
  DocumentMeta,
  PartVariant,
} from "@/lib/types";
import { api, isVersionConflict, conditions, date, statuses } from "@/lib/client";
import { useDraftGuard } from "@/lib/workflow";
import { NumberField } from "./number-field";
import { OrderFinances } from "./order-finances";
import { ActForm, OrderDetailsForm, documentLabel } from "./order-actions";
import { Empty, Field, Modal, Notice, SearchBox } from "./ui";
function validInspection() {
  const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(".inspection-panel input,.inspection-panel textarea");
  for (const input of inputs) {
    if (!input.checkValidity()) {
      input.reportValidity();
      return false;
    }
  }
  return true;
}
export function OrderEditor({ id, user }: { id: string; user: Actor }) {
  const [order, setOrder] = useState<OrderDetail | null>(null),
    [inspectionInstance, resetInspection] = useState(0),
    [items, setItems] = useState<InspectionItem[]>([]),
    [recommendations, setRecommendations] = useState(""),
    [tab, setTab] = useState("inspection"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saveStatus, setSaveStatus] = useState("Сохранено"),
    [dirty, setDirty] = useState(false),
    [revision, setRevision] = useState(0),
    [conflict, setConflict] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [filter, setFilter] = useState(""),
    [preview, setPreview] = useState<DocumentMeta | null>(null),
    [staff, setStaff] = useState<Staff[]>([]),
    [staffError, setStaffError] = useState(""),
    [financeDraft, setFinanceDraft] = useState(false),
    [financeInstance, resetFinance] = useState(0),
    [act, setAct] = useState<"deliver" | "version" | null>(null),
    [details, setDetails] = useState(false),
    [feedback, setFeedback] = useState("");
  const reportDraft = useCallback(() => setError("Сохраните или отмените изменения перед переходом."), []);
  useDraftGuard(dirty || financeDraft || busy, reportDraft);
  const version = useRef(0),
    inspectionBase = useRef<number | null>(null),
    editRevision = useRef(0),
    saving = useRef(false),
    draft = useRef({ items, recommendations });
  useEffect(() => {
    draft.current = { items, recommendations };
  }, [items, recommendations]);
  const master = user.role === "MASTER",
    locked = !!order && order.status === "CANCELLED",
    editable = !locked && !conflict && !busy;
  const accept = useCallback((o: OrderDetail) => {
    if (inspectionBase.current !== null) {
      setConflict(true);
      setSaveStatus("Не сохранено");
      return;
    }
    if (o.version > version.current + 1) resetInspection(n => n + 1);
    version.current = o.version;
    setOrder(o);
    draft.current = {items:o.inspectionItems, recommendations:o.recommendations};
    setItems(o.inspectionItems);
    setRecommendations(o.recommendations);
  }, []);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const o = await api<OrderDetail>(`/orders/${id}`);
      inspectionBase.current = null;
      accept(o);
      setDirty(false);
      setConflict(false);
      setError("");
      setSaveStatus("Сохранено");
      setSelected([]);
      setFinanceDraft(false);
      setDetails(false);
      setAct(null);
      resetFinance((n) => n + 1);
      resetInspection(n => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  }, [id, accept]);
  useEffect(() => {
    queueMicrotask(() => void load());
    api<{ items: Staff[] }>("/staff")
      .then((r) =>
        setStaff(r.items.filter((s) => s.role === "MASTER" && s.active)),
      )
      .catch((err) => setStaffError(err.message));
  }, [load]);
  function edited() {
    inspectionBase.current ??= version.current;
    editRevision.current += 1;
    setRevision(editRevision.current);
    setDirty(true);
    setSaveStatus("Есть несохранённые изменения");
  }
  const save = useCallback(async () => {
    const base = inspectionBase.current;
    if (saving.current || base === null) return false;
    if (!validInspection()) {
      setSaveStatus("Исправьте значение поля");
      setError("Исправьте отмеченное значение перед сохранением.");
      return false;
    }
    saving.current = true;
    setSaveStatus("Сохраняется…");
    const stamp = editRevision.current;
    try {
      const o = await api<OrderDetail>(`/orders/${id}/inspection`, "PUT", {
        version: base,
        ...draft.current,
      });
      if (stamp === editRevision.current) {
        inspectionBase.current = null;
        accept(o);
        setDirty(false);
        setSaveStatus("Все изменения сохранены");
      } else if (o.version === base + 1) {
        // Only our acknowledged save advanced the version. Keep subsequent keystrokes.
        inspectionBase.current = o.version;
        version.current = o.version;
        setOrder(o);
        setSaveStatus("Сохраняем новые изменения…");
      } else {
        // Another writer committed between our save and its response snapshot.
        setConflict(true);
        setSaveStatus("Не сохранено");
        return false;
      }
      setError("");
      return true;
    } catch (e) {
      setError((e as Error).message);
      setSaveStatus("Не сохранено");
      if (isVersionConflict(e)) setConflict(true);
      return false;
    } finally {
      saving.current = false;
    }
  }, [id, accept]);
  useEffect(() => {
    if (!dirty || busy || conflict || locked) return;
    const timeout = setTimeout(() => {
      void save().then((ok) => {
        if (ok && editRevision.current !== revision)
          setRevision(editRevision.current);
      });
    }, 850);
    return () => clearTimeout(timeout);
  }, [busy, dirty, revision, conflict, locked, save, order?.version]);
  async function run<T>(operation: () => Promise<T>): Promise<T> {
    setBusy(true);
    setError("");
    setFeedback("");
    try {
      return await operation();
    } catch (err) {
      setError((err as Error).message);
      if (isVersionConflict(err)) setConflict(true);
      throw err;
    } finally {
      setBusy(false);
    }
  }
  async function mutate(path: string, method: string, body: Record<string, unknown>) {
    return run(async () => {
      const updated = await api<OrderDetail>(`/orders/${id}${path}`, method, { version: version.current, ...body });
      accept(updated);
      if (path === "/transfer") {
        setSelected([]);
        setTab("lines");
        setFeedback("Позиции перенесены. Укажите решения клиента по каждой строке.");
      } else {
        if (path === "/lines" && updated.lines.some((line) =>
          line.approval === "PENDING" && order?.lines.some((old) => old.id === line.id && old.approval === "APPROVED"),
        )) setFeedback("Изменённые позиции нужно согласовать повторно.");
        else setFeedback("Изменения сохранены.");
      }
      return updated;
    });
  }
  function changeOrder(body: Record<string, unknown>) {
    void mutate("", "PATCH", body).catch(() => {});
  }
  async function generateInspection() {
    try {
      await run(async () => {
        const doc = await api<DocumentMeta>(`/orders/${id}/documents`, "POST", {
          kind: "INSPECTION", version: version.current,
        });
        setPreview(doc);
        accept(await api<OrderDetail>(`/orders/${id}`));
      });
    } catch { /* The editor reports the failure and keeps the current draft. */ }
  }
  function chooseTab(key: string) {
    if (key === tab || busy) return;
    if (financeDraft || dirty || saving.current) {
      setError("Сохраните или отмените изменения перед переходом.");
      return;
    }
    setError("");
    setFeedback("");
    setTab(key);
  }
  function updateItem(itemId: string, patch: Partial<InspectionItem>) {
    setItems((current) =>
      current.map((i) => (i.id === itemId ? { ...i, ...patch } : i)),
    );
    edited();
  }
  if (!order)
    return (
      <section className="panel pad">
        {error ? <Notice>{error}</Notice> : <p>Загружаем заказ…</p>}
        {error && <button className="secondary" onClick={() => void load()}>Повторить</button>}
        <a href="#orders">Вернуться к заказам</a>
      </section>
    );
  const canSaveFinance = !busy && !dirty && !conflict && saveStatus !== "Сохраняется…";
  const canAct = canSaveFinance && !financeDraft;
  const group = order.status === "APPROVAL" || order.status === "READY" ? order.status : "IN_PROGRESS";
  return (
    <>
      <a className="back-link" href="#orders">
        Все заказы
      </a>
      <section className="panel order-summary">
        <div className="order-title">
          <div>
            <h2>Заказ-наряд № {order.number}</h2>
            <p>
              Открыт {date(order.openedAt)} ·{" "}
              {order.mileage.toLocaleString("ru-RU")} км
            </p>
          </div>
          <span className={`badge ${order.status.toLowerCase()}`}>
            <i />
            {statuses[order.status]}
          </span>
        </div>
        <div className="summary-grid">
          <div>
            <small>АВТОМОБИЛЬ</small>
            <strong>
              {order.vehicle.make} {order.vehicle.model}
            </strong>
            <span>
              {order.vehicle.plate || "Без госномера"} ·{" "}
              {order.vehicle.vin || "VIN не указан"}
            </span>
          </div>
          <div>
            <small>КЛИЕНТ</small>
            <strong>{order.customer.name || "Имя не указано"}</strong>
            {order.customer.phone && <a href={`tel:${order.customer.phone}`}>{order.customer.phone}</a>}
          </div>
          <div>
            <small>МАСТЕР</small>
            {!master && editable ? (
              <select
                aria-label="Назначенный мастер"
                value={order.masterId || ""}
                disabled={!canAct}
                onChange={(e) =>
                  changeOrder({ masterId: e.target.value || null })
                }
              >
                <option value="">Не назначен</option>
                {order.masterId && !staff.some((s) => s.id === order.masterId) && <option value={order.masterId}>{order.master?.name || "Назначенный мастер"}</option>}
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            ) : (
              <strong>{order.master?.name || "Не назначен"}</strong>
            )}
          </div>
        </div>
        <div className="complaint">
          <small>ПРИЧИНА ОБРАЩЕНИЯ</small>
          <p>{order.complaint}</p>
          {order.comment && <p>{order.comment}</p>}
          {editable && !master && <button className="secondary" disabled={!canAct} onClick={() => setDetails(true)}>Изменить сведения</button>}
        </div>
        <div className="order-actions">
          <div className={`save-state ${dirty ? "pending" : ""}`} role="status">
            <span />
            {saveStatus}
          </div>
          <div className="actions order-transition">
            {dirty && !conflict && (
              <button
                className="secondary"
                disabled={busy || saveStatus === "Сохраняется…"}
                onClick={() => void save()}
              >
                <Save size={16} />
                Сохранить сейчас
              </button>
            )}
            {!locked && order.status !== "DELIVERED" && <Field label="Группа заказа">
              <select value={group} disabled={!canAct} onChange={(e) => changeOrder({ status: e.target.value })}>
                <option value="IN_PROGRESS">Активный</option>
                <option value="APPROVAL">На согласовании</option>
                <option value="READY">Готов к выдаче</option>
              </select>
            </Field>}
            {!master && editable && order.status === "READY" && (
              <button className="primary" disabled={!canAct} onClick={() => setAct("deliver")}>Выдать автомобиль</button>
            )}
            {!master && editable && order.status !== "DELIVERED" && (
              <button
                className="secondary"
                disabled={!canAct}
                onClick={() => {
                  if (
                    confirm(
                      "Отменить заказ? После отмены редактирование будет закрыто.",
                    )
                  )
                    changeOrder({ status: "CANCELLED" });
                }}
              >
                Отменить заказ
              </button>
            )}
          </div>
        </div>
      </section>
      {error && <Notice>{error}</Notice>}
      {staffError && !master && <Notice>{staffError}</Notice>}
      {feedback && <div className="success" role="status">{feedback}</div>}
      {conflict && (
        <div className="notice">
          Заказ изменён другим сотрудником. Ваши правки остаются на экране.
          Скопируйте нужные значения перед загрузкой актуальной версии.{" "}
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              if (
                confirm(
                  "Загрузить актуальную версию? Локальные несохранённые правки будут заменены.",
                )
              )
                void load();
            }}
          >
            <RefreshCw size={15} />
            Загрузить актуальную версию
          </button>
        </div>
      )}
      {order.financialMode === "LEGACY" && !master && <div className="notice">
        Расчёт перенесён. Перед изменением сумм сверяйте позиции в разделе «Работы и запчасти».
      </div>}
      {locked && <div className="success">Заказ отменён. История доступна для просмотра.</div>}
      {order.status === "DELIVERED" && !master && (
        <div className={order.completionActNeedsUpdate ? "notice" : "success"}>
          Автомобиль выдан{order.closedAt ? ` ${date(order.closedAt)}` : ""}. {order.completionActNeedsUpdate
            ? "Актуальный акт требуется сформировать в разделе «Документы»."
            : "Правки и доплата доступны в карточке заказа."}
        </div>
      )}
      <div className="tabs" role="tablist" aria-label="Разделы заказа">
        {[
          ["inspection", "Осмотр", items.length],
          ["lines", "Работы и запчасти", order.lines.length],
          ...(!master ? [["documents", "Документы", order.documents.length]] : []),
        ].map(([key, label, count]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => chooseTab(String(key))}
            className={tab === key ? "active" : ""}
          >
            {label}
            <span>{count}</span>
          </button>
        ))}
      </div>
      {tab === "inspection" ? (
        <section key={inspectionInstance} className="panel inspection-panel">
          <div className="panel-heading">
            <div>
              <h2>Акт осмотра автомобиля</h2>
              <p>
                Отметьте состояние и стороны L / R, укажите цены и выберите нужные пункты.
                Осмотр сохраняется автоматически. Кнопка «В заказ» добавит выбранное для согласования.
              </p>
            </div>
            {!master && editable && (
              <button
                className="primary"
                disabled={!selected.length || !canAct || order.financialMode === "LEGACY"}
                onClick={() =>
                  void mutate("/transfer", "POST", {
                    inspectionItemIds: selected,
                  }).catch(() => {})
                }
              >
                <Plus size={17} />В заказ ({selected.length})
              </button>
            )}
          </div>
          <div className="toolbar">
            <SearchBox
              value={filter}
              onChange={setFilter}
              placeholder="Найти пункт осмотра"
            />
            <a className="secondary button" href="#catalog">Справочник осмотра</a>
            <span className="muted">
              {items.filter((i) => i.condition !== "UNCHECKED").length} из{" "}
              {items.length} осмотрено
            </span>
          </div>
          <div className="inspection-list">
            {Array.from(new Set(items.map((i) => i.category))).map(
              (category) => {
                const visible = items.filter(
                  (i) =>
                    i.category === category &&
                    `${i.name} ${i.note}`
                      .toLowerCase()
                      .includes(filter.toLowerCase()),
                );
                return visible.length ? (
                  <div className="inspection-section" key={category}>
                    <h3>
                      {category}
                      <span>{visible.length}</span>
                    </h3>
                    {visible.map((i) => (
                      <div
                        className={`inspection-item condition-${i.condition.toLowerCase()}`}
                        key={i.id}
                      >
                        <div className="inspection-top">
                          {!master && editable && (
                            <input
                              type="checkbox"
                              aria-label={`Перенести ${i.name} в заказ`}
                              checked={selected.includes(i.id)}
                              onChange={(e) =>
                                setSelected((s) =>
                                  e.target.checked
                                    ? [...s, i.id]
                                    : s.filter((id) => id !== i.id),
                                )
                              }
                            />
                          )}
                          <strong>{i.name}</strong>
                          <div className="sides">
                            <label>
                              <input
                                type="checkbox"
                                checked={i.left}
                                disabled={!editable}
                                onChange={(e) =>
                                  updateItem(i.id, { left: e.target.checked })
                                }
                              />
                              L
                            </label>
                            <label>
                              <input
                                type="checkbox"
                                checked={i.right}
                                disabled={!editable}
                                onChange={(e) =>
                                  updateItem(i.id, { right: e.target.checked })
                                }
                              />
                              R
                            </label>
                          </div>
                          <select
                            aria-label={`Состояние: ${i.name}`}
                            value={i.condition}
                            disabled={!editable}
                            onChange={(e) =>
                              updateItem(i.id, {
                                condition: e.target
                                  .value as InspectionItem["condition"],
                              })
                            }
                          >
                            {Object.entries(conditions).map(([k, v]) => (
                              <option key={k} value={k}>
                                {v}
                              </option>
                            ))}
                          </select>
                        </div>
                        {!master && (
                          <div className="inspection-prices">
                            <Field label="Количество">
                              <NumberField
                                label={`Количество ${i.name}`}
                                quantity
                                value={i.quantityMilli}
                                disabled={!editable}
                                onInvalidDraft={edited}
                                onChange={(n) =>
                                  updateItem(i.id, { quantityMilli: n })
                                }
                              />
                            </Field>
                            <Field label="Работа / ед., ₽">
                              <NumberField
                                label={`Цена работы ${i.name}`}
                                value={i.laborPriceCents}
                                disabled={!editable}
                                onInvalidDraft={edited}
                                onChange={(n) =>
                                  updateItem(i.id, { laborPriceCents: n })
                                }
                              />
                            </Field>
                            <Field label="Оригинал / ед., ₽">
                              <NumberField
                                label={`Цена оригинала ${i.name}`}
                                value={i.originalPriceCents}
                                disabled={!editable}
                                onInvalidDraft={edited}
                                onChange={(n) =>
                                  updateItem(i.id, { originalPriceCents: n })
                                }
                              />
                            </Field>
                            <Field label="Аналог / ед., ₽">
                              <NumberField
                                label={`Цена аналога ${i.name}`}
                                value={i.analogPriceCents}
                                disabled={!editable}
                                onInvalidDraft={edited}
                                onChange={(n) =>
                                  updateItem(i.id, { analogPriceCents: n })
                                }
                              />
                            </Field>
                            <Field label="Другая цена / ед., ₽">
                              <NumberField
                                label={`Своя цена ${i.name}`}
                                value={i.customPriceCents}
                                disabled={!editable}
                                onInvalidDraft={edited}
                                onChange={(n) =>
                                  updateItem(i.id, { customPriceCents: n })
                                }
                              />
                            </Field>
                            <Field label="Запчасть в заказ">
                              <select
                                value={i.selectedPart}
                                disabled={!editable}
                                onChange={(e) =>
                                  updateItem(i.id, {
                                    selectedPart: e.target.value as PartVariant,
                                  })
                                }
                              >
                                <option value="NONE">Без запчасти</option>
                                <option value="ORIGINAL">Оригинал</option>
                                <option value="ANALOG">Аналог</option>
                                <option value="CUSTOM">Другая цена</option>
                              </select>
                            </Field>
                          </div>
                        )}
                        <input
                          className="inspection-note"
                          aria-label={`Примечание ${i.name}`}
                          placeholder="Примечание к пункту…"
                          value={i.note}
                          disabled={!editable}
                          onChange={(e) =>
                            updateItem(i.id, { note: e.target.value })
                          }
                        />
                      </div>
                    ))}
                  </div>
                ) : null;
              },
            )}
            {!items.length && (
              <Empty>В справочнике пока нет пунктов осмотра.</Empty>
            )}
          </div>
          <div className="recommendations">
            <Field label="Рекомендации клиенту">
              <textarea
                rows={4}
                value={recommendations}
                disabled={!editable}
                placeholder="Дополнительные рекомендации по обслуживанию автомобиля"
                onChange={(e) => {
                  setRecommendations(e.target.value);
                  edited();
                }}
              />
            </Field>
          </div>
        </section>
      ) : tab === "lines" ? (
        <OrderFinances
          key={financeInstance}
          order={order}
          master={master}
          disabled={!editable || !canSaveFinance}
          onDraft={setFinanceDraft}
          mutate={mutate}
          onPayment={(updated) => { accept(updated); setFeedback("Движение средств сохранено."); }}
          onBusy={setBusy}
          onConflict={(message) => { setError(message); setConflict(true); }}
        />
      ) : (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Сохранённые документы</h2>
              <p>Каждая версия хранит данные на момент формирования.</p>
            </div>
            <div className="actions">
              {!master && (
                <>
                  <button
                    className="secondary"
                    disabled={!canAct}
                    onClick={() => void generateInspection()}
                  >
                    <FileText size={16} />
                    Акт осмотра
                  </button>
                  {order.status === "DELIVERED" && <button
                    className="primary" disabled={!canAct || order.financialMode === "LEGACY"} onClick={() => setAct("version")}>
                    <FileText size={16} /> Новая версия акта
                  </button>}
                </>
              )}
            </div>
          </div>
          {!order.documents.length ? (
            <Empty>Документы ещё не сформированы.</Empty>
          ) : (
            <div className="document-list">
              {order.documents.map((d) => (
                <div className="document-row" key={d.id}>
                  <FileText size={24} />
                  <div>
                    <strong>
                      {documentLabel(d)}{" "}
                      № {d.number}
                    </strong>
                    <small>
                      {date(d.createdAt)} · версия {d.version}
                    </small>
                  </div>
                  <div className="actions">
                    <button className="secondary" onClick={() => setPreview(d)}>
                      Просмотр
                    </button>
                    <a
                      className="icon"
                      href={`/api/documents/${d.id}?download=1`}
                      aria-label="Скачать PDF"
                    >
                      <Download size={18} />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      {act && <ActForm
        mode={act} order={order} close={() => setAct(null)}
        saved={(doc, updated, message) => {
          if (updated) accept(updated);
          setAct(null);
          setTab("documents");
          setPreview(doc);
          setFeedback("Акт сохранён.");
          if (message) { setError(message); setConflict(true); }
        }}
        onDraft={setFinanceDraft}
        onConflict={(message) => { setError(message); setConflict(true); }}
      />}
      {details && <OrderDetailsForm order={order} close={() => setDetails(false)}
        save={(body) => mutate("", "PATCH", body)}
      />}
      {preview && (
        <Modal
          title={`${documentLabel(preview)} № ${preview.number}`}
          close={() => setPreview(null)}
        >
          <div className="actions pdf-actions">
            <a
              className="secondary button"
              href={`/api/documents/${preview.id}?download=1`}
            >
              <Download size={16} />
              Скачать PDF
            </a>
            <button
              className="secondary"
              onClick={() => {
                const frame = document.getElementById(
                  "pdf-preview",
                ) as HTMLIFrameElement;
                frame?.contentWindow?.print();
              }}
            >
              <Printer size={16} />
              Печать
            </button>
            <a
              className="secondary button"
              href={`/api/documents/${preview.id}`}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={16} />
              Открыть отдельно
            </a>
          </div>
          <iframe
            id="pdf-preview"
            className="pdf-preview"
            title="Предварительный просмотр PDF"
            src={`/api/documents/${preview.id}`}
          />
        </Modal>
      )}
    </>
  );
}
