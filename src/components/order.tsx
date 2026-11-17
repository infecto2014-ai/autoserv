"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Plus,
  Printer,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import type {
  Actor,
  Vehicle,
  Staff,
  PageResult,
  OrderDetail,
  InspectionItem,
  OrderLine,
  DocumentMeta,
  OrderStatus,
  PartVariant,
} from "@/lib/types";
import { api, ApiError, conditions, date, statuses } from "@/lib/client";
import {
  parseMoney,
  formatMoney as moneyWithCurrency,
  parseQuantity,
  formatQuantity,
} from "@/lib/money";
import { Empty, Field, Modal, Notice, SearchBox } from "./ui";
const formatMoney = (cents: number) =>
  moneyWithCurrency(cents).replace(/\s*₽$/, "");
function validEditor() {
  const inputs = document.querySelectorAll<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >(
    "main input:not(:disabled),main select:not(:disabled),main textarea:not(:disabled)",
  );
  for (const input of inputs) {
    if (!input.checkValidity()) {
      input.reportValidity();
      return false;
    }
  }
  return true;
}
export function NewOrder({
  close,
  onCreated,
}: {
  close: () => void;
  onCreated: (o: OrderDetail) => void;
}) {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]),
    [staff, setStaff] = useState<Staff[]>([]),
    [q, setQ] = useState(""),
    [vehicle, setVehicle] = useState(""),
    [mileage, setMileage] = useState(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api<PageResult<Vehicle>>(
      `/vehicles?q=${encodeURIComponent(q)}&pageSize=100`,
    )
      .then((r) => active && setVehicles(r.items))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [q]);
  useEffect(() => {
    api<{ items: Staff[] }>("/staff")
      .then((r) =>
        setStaff(r.items.filter((s) => s.role === "MASTER" && s.active)),
      )
      .catch((e) => setError(e.message));
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const d = Object.fromEntries(new FormData(e.currentTarget));
    try {
      onCreated(
        await api<OrderDetail>("/orders", "POST", {
          vehicleId: vehicle,
          masterId: d.masterId || null,
          mileage,
          complaint: d.complaint,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Новый заказ-наряд" close={close}>
      <form onSubmit={submit}>
        {error && <Notice>{error}</Notice>}
        <Field label="Найти автомобиль">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Марка, госномер, VIN или владелец"
          />
        </Field>
        <Field label="Автомобиль и клиент">
          <select
            value={vehicle}
            required
            onChange={(e) => {
              setVehicle(e.target.value);
              setMileage(
                vehicles.find((v) => v.id === e.target.value)?.mileage || 0,
              );
            }}
          >
            <option value="">Выберите автомобиль</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.make} {v.model} · {v.plate || "без номера"} ·{" "}
                {v.customer?.name}
              </option>
            ))}
          </select>
        </Field>
        <p className="muted">
          Нет автомобиля? Сначала добавьте клиента и автомобиль в
          соответствующих разделах.
        </p>
        <div className="form-grid">
          <Field label="Пробег, км">
            <input
              type="number"
              min="0"
              step="1"
              required
              value={mileage}
              onChange={(e) => setMileage(Number(e.target.value))}
            />
          </Field>
          <Field label="Ответственный мастер">
            <select name="masterId">
              <option value="">Назначить позже</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Жалоба / причина обращения">
          <textarea name="complaint" required rows={3} />
        </Field>
        <div className="form-footer">
          <button type="button" className="secondary" onClick={close}>
            Отмена
          </button>
          <button className="primary" disabled={busy || !vehicle}>
            {busy ? "Создаём…" : "Создать заказ"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function NumberField({
  id,
  value,
  onChange,
  quantity = false,
  disabled = false,
  label,
}: {
  id?: string;
  value: number;
  onChange: (n: number) => void;
  quantity?: boolean;
  disabled?: boolean;
  label: string;
}) {
  const display = quantity ? formatQuantity : formatMoney;
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
        } catch (err) {
          e.target.setCustomValidity((err as Error).message);
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
export function OrderEditor({ id, user }: { id: string; user: Actor }) {
  const [order, setOrder] = useState<OrderDetail | null>(null),
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
    [staff, setStaff] = useState<Staff[]>([]);
  const version = useRef(0),
    editRevision = useRef(0),
    saving = useRef(false),
    draft = useRef({ items, recommendations });
  useEffect(() => {
    draft.current = { items, recommendations };
  }, [items, recommendations]);
  const master = user.role === "MASTER",
    locked = !!order && ["DELIVERED", "CANCELLED"].includes(order.status),
    editable = !locked && !conflict;
  const accept = useCallback((o: OrderDetail) => {
    version.current = o.version;
    setOrder(o);
  }, []);
  const load = useCallback(async () => {
    try {
      const o = await api<OrderDetail>(`/orders/${id}`);
      accept(o);
      setItems(o.inspectionItems);
      setRecommendations(o.recommendations);
      setDirty(false);
      setConflict(false);
      setError("");
      setSaveStatus("Сохранено");
      setSelected([]);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id, accept]);
  useEffect(() => {
    queueMicrotask(() => void load());
    api<{ items: Staff[] }>("/staff")
      .then((r) =>
        setStaff(r.items.filter((s) => s.role === "MASTER" && s.active)),
      )
      .catch(() => {});
  }, [load]);
  function edited() {
    editRevision.current += 1;
    setRevision(editRevision.current);
    setDirty(true);
    setSaveStatus("Есть несохранённые изменения");
  }
  const save = useCallback(async () => {
    if (saving.current) return false;
    if (!validEditor()) {
      setSaveStatus("Исправьте значение поля");
      setError("Исправьте отмеченное значение перед сохранением.");
      return false;
    }
    saving.current = true;
    setSaveStatus("Сохраняется…");
    const stamp = editRevision.current;
    try {
      const o = await api<OrderDetail>(`/orders/${id}/inspection`, "PUT", {
        version: version.current,
        ...draft.current,
      });
      accept(o);
      if (stamp === editRevision.current) {
        setDirty(false);
        setSaveStatus("Все изменения сохранены");
      } else setSaveStatus("Сохраняем новые изменения…");
      setError("");
      return true;
    } catch (e) {
      const err = e as ApiError;
      setError(err.message);
      setSaveStatus("Не сохранено");
      if (err.status === 409) setConflict(true);
      return false;
    } finally {
      saving.current = false;
    }
  }, [id, accept]);
  useEffect(() => {
    if (!dirty || conflict || locked) return;
    const timeout = setTimeout(() => {
      void save().then((ok) => {
        if (ok && editRevision.current !== revision)
          setRevision(editRevision.current);
      });
    }, 850);
    return () => clearTimeout(timeout);
  }, [dirty, revision, conflict, locked, save, order?.version]);
  useEffect(() => {
    if (!dirty) return;
    function before(e: BeforeUnloadEvent) {
      e.preventDefault();
    }
    function navigate(e: MouseEvent) {
      const anchor = (e.target as Element).closest('a[href^="#"]');
      if (anchor && anchor.getAttribute("href") !== location.hash) {
        e.preventDefault();
        e.stopPropagation();
        setError(
          "Дождитесь сохранения осмотра перед переходом в другой раздел.",
        );
      }
    }
    window.addEventListener("beforeunload", before);
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", before);
      document.removeEventListener("click", navigate, true);
    };
  }, [dirty]);
  async function mutate(
    path: string,
    method: string,
    body: Record<string, unknown>,
  ) {
    if (!validEditor()) {
      setError("Исправьте отмеченное значение перед сохранением.");
      return;
    }
    if (dirty || saving.current) {
      setError("Дождитесь сохранения осмотра перед следующим действием.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const o = await api<OrderDetail>(`/orders/${id}${path}`, method, {
        version: version.current,
        ...body,
      });
      accept(o);
      if (path === "/transfer") setSelected([]);
    } catch (e) {
      setError((e as Error).message);
      if ((e as ApiError).status === 409) setConflict(true);
    } finally {
      setBusy(false);
    }
  }
  async function generateDocument(kind: "INSPECTION" | "WORK_ORDER") {
    if (!order || !validEditor()) return;
    setBusy(true);
    try {
      const doc = await api<DocumentMeta>(`/orders/${id}/documents`, "POST", {
        kind,
        version: order.version,
      });
      const updated = await api<OrderDetail>(`/orders/${id}`);
      accept(updated);
      setPreview(doc);
    } catch (e) {
      setError((e as Error).message);
      if ((e as ApiError).status === 409) setConflict(true);
    } finally {
      setBusy(false);
    }
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
        <a href="#orders">Вернуться к заказам</a>
      </section>
    );
  const canAct = !busy && !dirty && !conflict && saveStatus !== "Сохраняется…";
  const next: Partial<Record<OrderStatus, OrderStatus>> = {
    NEW: "DIAGNOSTICS",
    DIAGNOSTICS: "APPROVAL",
    APPROVAL: "IN_PROGRESS",
    IN_PROGRESS: "READY",
    READY: "DELIVERED",
  };
  const nextStatus = next[order.status];
  return (
    <>
      <a className="back-link" href="#orders">
        <ArrowLeft size={16} />
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
            <strong>{order.customer.name}</strong>
            <a href={`tel:${order.customer.phone}`}>{order.customer.phone}</a>
          </div>
          <div>
            <small>МАСТЕР</small>
            {!master && editable ? (
              <select
                aria-label="Назначенный мастер"
                value={order.masterId || ""}
                disabled={!canAct}
                onChange={(e) =>
                  void mutate("", "PATCH", { masterId: e.target.value || null })
                }
              >
                <option value="">Не назначен</option>
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
        </div>
        <div className="order-actions">
          <div className={`save-state ${dirty ? "pending" : ""}`} role="status">
            <span />
            {saveStatus}
          </div>
          <div className="actions">
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
            {nextStatus &&
              editable &&
              (!master || nextStatus !== "DELIVERED") && (
                <button
                  className="primary"
                  disabled={!canAct}
                  onClick={() =>
                    void mutate("", "PATCH", { status: nextStatus })
                  }
                >
                  {statuses[nextStatus]}
                  <ChevronRight size={16} />
                </button>
              )}
            {!master && editable && (
              <button
                className="secondary"
                disabled={!canAct}
                onClick={() => {
                  if (
                    confirm(
                      "Отменить заказ? После отмены редактирование будет закрыто.",
                    )
                  )
                    void mutate("", "PATCH", { status: "CANCELLED" });
                }}
              >
                Отменить заказ
              </button>
            )}
          </div>
        </div>
      </section>
      {error && <Notice>{error}</Notice>}
      {conflict && (
        <div className="notice">
          Заказ изменён другим сотрудником. Ваши правки остаются на экране.
          Скопируйте нужные значения перед загрузкой актуальной версии.{" "}
          <button
            className="secondary"
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
      {locked && (
        <div className="success">
          Заказ {order.status === "DELIVERED" ? "выдан" : "отменён"}. История
          доступна для просмотра.
        </div>
      )}
      <div className="tabs" role="tablist" aria-label="Разделы заказа">
        {[
          ["inspection", "Осмотр", items.length],
          ["lines", "Работы и запчасти", order.lines.length],
          ["documents", "Документы", order.documents.length],
        ].map(([key, label, count]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(String(key))}
            className={tab === key ? "active" : ""}
          >
            {label}
            <span>{count}</span>
          </button>
        ))}
      </div>
      {tab === "inspection" ? (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Акт осмотра автомобиля</h2>
              <p>
                Отмечайте состояние и стороны L / R. Изменения сохраняются
                автоматически.
              </p>
            </div>
            {!master && editable && (
              <button
                className="primary"
                disabled={!selected.length || !canAct}
                onClick={() =>
                  void mutate("/transfer", "POST", {
                    inspectionItemIds: selected,
                  })
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
        <Lines
          order={order}
          master={master}
          disabled={!editable || !canAct}
          save={(lines) => mutate("/lines", "PUT", { lines })}
          patch={(body) => mutate("", "PATCH", body)}
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
                    onClick={() => void generateDocument("INSPECTION")}
                  >
                    <FileText size={16} />
                    Акт осмотра
                  </button>
                  <button
                    className="primary"
                    disabled={!canAct}
                    onClick={() => void generateDocument("WORK_ORDER")}
                  >
                    <FileText size={16} />
                    Заказ-наряд
                  </button>
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
                      {d.kind === "INSPECTION" ? "Акт осмотра" : "Заказ-наряд"}{" "}
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
      {preview && (
        <Modal
          title={`${preview.kind === "INSPECTION" ? "Акт осмотра" : "Заказ-наряд"} № ${preview.number}`}
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
function Lines({
  order,
  master,
  disabled,
  save,
  patch,
}: {
  order: OrderDetail;
  master: boolean;
  disabled: boolean;
  save: (l: OrderLine[]) => Promise<void>;
  patch: (b: Record<string, unknown>) => Promise<void>;
}) {
  const [lines, setLines] = useState<OrderLine[]>(order.lines),
    [discount, setDiscount] = useState(order.discountCents),
    [paid, setPaid] = useState(order.paidCents),
    [changed, setChanged] = useState(false);
  useEffect(() => {
    queueMicrotask(() => {
      setLines(order.lines);
      setChanged(false);
      setDiscount(order.discountCents);
      setPaid(order.paidCents);
    });
  }, [order.lines, order.discountCents, order.paidCents]);
  function update(index: number, body: Partial<OrderLine>) {
    setLines((ls) => ls.map((l, i) => (i === index ? { ...l, ...body } : l)));
    setChanged(true);
  }
  if (master)
    return (
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Назначенные работы и запчасти</h2>
            <p>Финансовое редактирование доступно приёмщику.</p>
          </div>
        </div>
        {order.lines.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Тип</th>
                  <th>Наименование</th>
                  <th>Количество</th>
                </tr>
              </thead>
              <tbody>
                {order.lines.map((l, i) => (
                  <tr key={l.id || i}>
                    <td>{l.kind === "LABOR" ? "Работа" : "Запчасть"}</td>
                    <td>{l.name}</td>
                    <td>{formatQuantity(l.quantityMilli)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Позиции ещё не добавлены.</Empty>
        )}
      </section>
    );
  return (
    <div className="financial-layout">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Работы и запчасти</h2>
            <p>Перенос из осмотра и дополнительные позиции</p>
          </div>
          <button
            className="primary"
            disabled={disabled || !changed}
            onClick={() => void save(lines)}
          >
            <Save size={16} />
            Сохранить строки
          </button>
        </div>
        {(["LABOR", "PART"] as const).map((kind) => (
          <div className="line-section" key={kind}>
            <div className="line-heading">
              <h3>{kind === "LABOR" ? "Работы" : "Запчасти"}</h3>
              <button
                className="secondary"
                disabled={disabled}
                onClick={() => {
                  setLines((l) => [
                    ...l,
                    {
                      kind,
                      name: "",
                      quantityMilli: 1000,
                      unitPriceCents: 0,
                      variant: "NONE",
                      article: "",
                    },
                  ]);
                  setChanged(true);
                }}
              >
                <Plus size={16} />
                Добавить
              </button>
            </div>
            <div className="table-wrap">
              <table className="lines-table">
                <thead>
                  <tr>
                    <th>Наименование</th>
                    {kind === "PART" && <th>Артикул / вариант</th>}
                    <th>Кол-во</th>
                    <th>Цена, ₽</th>
                    <th>Сумма, ₽</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, index) =>
                    l.kind === kind ? (
                      <tr key={l.id || `new-${index}`}>
                        <td>
                          <input
                            aria-label={`Название позиции ${index + 1}`}
                            required
                            value={l.name}
                            disabled={disabled}
                            onChange={(e) =>
                              update(index, { name: e.target.value })
                            }
                          />
                        </td>
                        {kind === "PART" && (
                          <td>
                            <input
                              aria-label={`Артикул ${index + 1}`}
                              placeholder="Артикул"
                              value={l.article || ""}
                              disabled={disabled}
                              onChange={(e) =>
                                update(index, { article: e.target.value })
                              }
                            />
                            <select
                              aria-label={`Вариант запчасти ${index + 1}`}
                              value={l.variant}
                              disabled={disabled}
                              onChange={(e) =>
                                update(index, {
                                  variant: e.target.value as PartVariant,
                                })
                              }
                            >
                              <option value="NONE">Не указан</option>
                              <option value="ORIGINAL">Оригинал</option>
                              <option value="ANALOG">Аналог</option>
                              <option value="CUSTOM">Другой</option>
                            </select>
                          </td>
                        )}
                        <td>
                          <NumberField
                            label={`Количество позиции ${index + 1}`}
                            quantity
                            value={l.quantityMilli}
                            disabled={disabled}
                            onChange={(n) =>
                              update(index, { quantityMilli: n })
                            }
                          />
                        </td>
                        <td>
                          <NumberField
                            label={`Цена позиции ${index + 1}`}
                            value={l.unitPriceCents}
                            disabled={disabled}
                            onChange={(n) =>
                              update(index, { unitPriceCents: n })
                            }
                          />
                        </td>
                        <td className="money">
                          {formatMoney(
                            Math.round(
                              (l.unitPriceCents * l.quantityMilli) / 1000,
                            ),
                          )}
                        </td>
                        <td>
                          <button
                            className="icon danger"
                            aria-label="Удалить строку"
                            disabled={disabled}
                            onClick={() => {
                              setLines((ls) =>
                                ls.filter((_, i) => i !== index),
                              );
                              setChanged(true);
                            }}
                          >
                            <Trash2 size={17} />
                          </button>
                        </td>
                      </tr>
                    ) : null,
                  )}
                </tbody>
              </table>
              {!lines.some((l) => l.kind === kind) && (
                <Empty>
                  Нет позиций. Добавьте вручную или перенесите из осмотра.
                </Empty>
              )}
            </div>
          </div>
        ))}
        {changed && (
          <div className="notice">
            Изменения строк ещё не сохранены. Нажмите «Сохранить строки».
          </div>
        )}
      </section>
      <aside className="panel total-panel">
        <h2>Стоимость заказа</h2>
        <dl>
          <div>
            <dt>Работы</dt>
            <dd>{formatMoney(order.totals.laborCents)} ₽</dd>
          </div>
          <div>
            <dt>Запчасти</dt>
            <dd>{formatMoney(order.totals.partsCents)} ₽</dd>
          </div>
          <div>
            <dt>До скидки</dt>
            <dd>{formatMoney(order.totals.subtotalCents)} ₽</dd>
          </div>
        </dl>
        <Field label="Скидка, ₽">
          <NumberField
            label="Скидка в рублях"
            value={discount}
            disabled={disabled}
            onChange={setDiscount}
          />
        </Field>
        <Field label="Оплачено, ₽">
          <NumberField
            label="Оплачено в рублях"
            value={paid}
            disabled={disabled}
            onChange={setPaid}
          />
        </Field>
        <button
          className="secondary full"
          disabled={
            disabled ||
            (paid === order.paidCents && discount === order.discountCents)
          }
          onClick={() =>
            void patch({ discountCents: discount, paidCents: paid })
          }
        >
          <Check size={16} />
          Сохранить оплату и скидку
        </button>
        <div className="total-final">
          <span>Итого</span>
          <strong>{formatMoney(order.totals.totalCents)} ₽</strong>
        </div>
        <div className="total-balance">
          <span>К оплате</span>
          <strong>{formatMoney(order.totals.balanceCents)} ₽</strong>
        </div>
        <small>Итоги рассчитаны по сохранённым позициям.</small>
      </aside>
    </div>
  );
}
