"use client";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowUpRight, Archive, Plus, Pencil, Car } from "lucide-react";
import { api, configureTimezone, date, roles, statuses } from "@/lib/client";
import { formatMoney as moneyWithCurrency, parseMoney } from "@/lib/money";
import type {
  Actor,
  Customer,
  Vehicle,
  CatalogItem,
  Staff,
  PageResult,
  Settings,
} from "@/lib/types";
import { Empty, Field, Modal, Notice, Pagination, SearchBox } from "./ui";
const formatMoney = (cents: number) =>
  moneyWithCurrency(cents).replace(/\s*₽$/, "");
type RecordItem = Customer | Vehicle | CatalogItem | Staff;
export function Records({ kind, user }: { kind: string; user: Actor }) {
  const [items, setItems] = useState<RecordItem[]>([]),
    [q, setQ] = useState(""),
    [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [edit, setEdit] = useState<RecordItem | "new" | null>(null),
    [history, setHistory] = useState<Vehicle | null>(null),
    [rev, setRev] = useState(0);
  const financial = user.role !== "MASTER",
    admin = user.role === "ADMIN",
    canEdit = ["customers", "vehicles"].includes(kind) ? financial : admin;
  useEffect(() => {
    let active = true;
    const timeout = setTimeout(() => {
      setLoading(true);
      api<PageResult<RecordItem>>(
        `/${kind}?q=${encodeURIComponent(q)}&page=${page}`,
      )
        .then((r) => {
          if (!active) return;
          const list = r.items || [];
          if (kind === "staff" || kind === "catalog") {
            const filtered = list.filter((x) =>
              JSON.stringify(x).toLowerCase().includes(q.toLowerCase()),
            );
            setItems(filtered.slice((page - 1) * 25, page * 25));
            setTotal(filtered.length);
          } else {
            setItems(list);
            setTotal(r.total);
          }
          setError("");
        })
        .catch((e) => active && setError(e.message))
        .finally(() => active && setLoading(false));
    }, 200);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [kind, q, page, rev]);
  async function archive(item: RecordItem) {
    if (
      !confirm(
        kind === "staff"
          ? "Изменить активность сотрудника?"
          : "Архивировать запись? История сохранится.",
      )
    )
      return;
    try {
      await api(
        `/${kind}/${item.id}`,
        "PATCH",
        kind === "staff"
          ? { active: !(item as Staff).active }
          : kind === "catalog"
            ? { active: !(item as CatalogItem).active }
            : { archived: true },
      );
      setRev((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>
            {kind === "customers"
              ? "Клиентская база"
              : kind === "vehicles"
                ? "Автомобили сервиса"
                : kind === "catalog"
                  ? "Пункты осмотра и работы"
                  : "Команда"}
          </h2>
          <p>Всего записей: {total}</p>
        </div>
        {canEdit && (
          <button className="primary" onClick={() => setEdit("new")}>
            <Plus size={18} />
            {kind === "customers"
              ? "Новый клиент"
              : kind === "vehicles"
                ? "Добавить автомобиль"
                : kind === "catalog"
                  ? "Добавить позицию"
                  : "Новый сотрудник"}
          </button>
        )}
      </div>
      <div className="toolbar">
        <SearchBox
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
        />
      </div>
      {error && <Notice>{error}</Notice>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {kind === "customers" ? (
                <>
                  <th>Клиент</th>
                  <th>Телефон</th>
                  <th>Почта</th>
                  <th>Комментарий</th>
                </>
              ) : kind === "vehicles" ? (
                <>
                  <th>Автомобиль</th>
                  <th>Госномер / VIN</th>
                  <th>Владелец</th>
                  <th>Пробег</th>
                </>
              ) : kind === "catalog" ? (
                <>
                  <th>Наименование</th>
                  <th>Раздел</th>
                  <th>Единица</th>
                  <th>Работа, ₽</th>
                </>
              ) : (
                <>
                  <th>Сотрудник</th>
                  <th>Почта</th>
                  <th>Роль</th>
                  <th>Состояние</th>
                </>
              )}
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                {kind === "customers" ? (
                  <>
                    <td>
                      <strong>{(item as Customer).name}</strong>
                      <small>
                        {(item as Customer).kind === "COMPANY"
                          ? "Организация"
                          : "Частное лицо"}
                      </small>
                    </td>
                    <td>{(item as Customer).phone}</td>
                    <td>{(item as Customer).email || "—"}</td>
                    <td>{(item as Customer).comment || "—"}</td>
                  </>
                ) : kind === "vehicles" ? (
                  <>
                    <td>
                      <strong>
                        {(item as Vehicle).make} {(item as Vehicle).model}
                      </strong>
                      <small>{(item as Vehicle).year || "Год не указан"}</small>
                    </td>
                    <td>
                      {(item as Vehicle).plate || "—"}
                      <small>{(item as Vehicle).vin || "VIN не указан"}</small>
                    </td>
                    <td>{(item as Vehicle).customer?.name || "—"}</td>
                    <td>
                      {(item as Vehicle).mileage.toLocaleString("ru-RU")} км
                    </td>
                  </>
                ) : kind === "catalog" ? (
                  <>
                    <td>
                      <strong>{(item as CatalogItem).name}</strong>
                      {!(item as CatalogItem).active && (
                        <small>Архивная позиция</small>
                      )}
                    </td>
                    <td>{(item as CatalogItem).category}</td>
                    <td>{(item as CatalogItem).unit}</td>
                    <td>
                      {formatMoney((item as CatalogItem).laborPriceCents)}
                    </td>
                  </>
                ) : (
                  <>
                    <td>
                      <strong>{(item as Staff).name}</strong>
                    </td>
                    <td>{(item as Staff).email}</td>
                    <td>{roles[(item as Staff).role]}</td>
                    <td>{(item as Staff).active ? "Активен" : "Отключён"}</td>
                  </>
                )}
                <td>
                  <div className="actions">
                    {kind === "vehicles" && (
                      <button
                        className="secondary"
                        onClick={async () => {
                          try {
                            setHistory(
                              await api<Vehicle>(`/vehicles/${item.id}`),
                            );
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        История
                        <ArrowUpRight size={15} />
                      </button>
                    )}
                    {canEdit && (
                      <>
                        <button
                          className="icon"
                          aria-label="Редактировать запись"
                          onClick={() => setEdit(item)}
                        >
                          <Pencil size={17} />
                        </button>
                        <button
                          className="icon"
                          aria-label="Архивировать или изменить активность"
                          onClick={() => archive(item)}
                        >
                          <Archive size={17} />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && (
          <Empty>
            {loading
              ? "Загружаем записи…"
              : "Записей не найдено. Попробуйте другой поиск или добавьте запись."}
          </Empty>
        )}
      </div>
      <Pagination page={page} total={total} onChange={setPage} />
      {edit && (
        <RecordForm
          kind={kind}
          item={edit === "new" ? null : edit}
          close={() => setEdit(null)}
          saved={() => {
            setEdit(null);
            setRev((v) => v + 1);
          }}
        />
      )}
      {history && (
        <Modal
          title={`${history.make} ${history.model} · история`}
          close={() => setHistory(null)}
        >
          <div className="vehicle-summary">
            <Car size={24} />
            <div>
              <strong>{history.plate || "Без госномера"}</strong>
              <p>
                {history.vin || "VIN не указан"} ·{" "}
                {history.mileage.toLocaleString("ru-RU")} км
              </p>
            </div>
          </div>
          <p>Владелец: {history.customer?.name}</p>
          {history.orders?.length ? (
            history.orders.map((o) => (
              <a
                className="history-row"
                key={o.id}
                href={`#orders/${o.id}`}
                onClick={() => setHistory(null)}
              >
                <div>
                  <strong>
                    № {o.number} · {statuses[o.status]}
                  </strong>
                  <p>{o.complaint}</p>
                  <small>
                    {date(o.openedAt)} · {o.mileage.toLocaleString("ru-RU")} км
                  </small>
                </div>
                <ArrowUpRight size={19} />
              </a>
            ))
          ) : (
            <Empty>История обслуживания пока пуста.</Empty>
          )}
        </Modal>
      )}
    </section>
  );
}
export function RecordForm({
  kind,
  item,
  close,
  saved,
}: {
  kind: string;
  item: RecordItem | null;
  close: () => void;
  saved: () => void;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [customers, setCustomers] = useState<Customer[]>([]),
    [customerQuery, setCustomerQuery] = useState("");
  useEffect(() => {
    if (kind !== "vehicles") return;
    let live = true;
    api<PageResult<Customer>>(
      `/customers?pageSize=100&q=${encodeURIComponent(customerQuery)}`,
    )
      .then((r) => live && setCustomers(r.items))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [kind, customerQuery]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setBusy(true);
    const d = Object.fromEntries(new FormData(e.currentTarget));
    try {
      let body: Record<string, unknown> = { ...d };
      if (kind === "customers" && item) {
        delete body.kind;
      }
      if (kind === "vehicles")
        body = {
          ...d,
          mileage: Number(d.mileage),
          year: d.year ? Number(d.year) : null,
        };
      if (kind === "catalog")
        body = { ...d, laborPriceCents: parseMoney(String(d.laborPriceCents)) };
      if (kind === "staff" && item) {
        delete body.email;
        if (!body.password) delete body.password;
      }
      await api(
        `/${kind}${item ? `/${item.id}` : ""}`,
        item ? "PATCH" : "POST",
        body,
      );
      saved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const customer = item as Customer | null,
    vehicle = item as Vehicle | null,
    catalog = item as CatalogItem | null,
    staff = item as Staff | null;
  return (
    <Modal
      title={`${item ? "Редактировать" : "Добавить"} ${kind === "customers" ? "клиента" : kind === "vehicles" ? "автомобиль" : kind === "catalog" ? "позицию" : "сотрудника"}`}
      close={close}
    >
      <form onSubmit={submit}>
        {error && <Notice>{error}</Notice>}
        <div className="form-grid">
          {kind === "customers" ? (
            <>
              <Field label="Тип клиента">
                <select
                  name="kind"
                  defaultValue={customer?.kind || "PERSON"}
                  disabled={!!item}
                >
                  <option value="PERSON">Частное лицо</option>
                  <option value="COMPANY">Организация</option>
                </select>
              </Field>
              <Field label="ФИО / название">
                <input name="name" required defaultValue={customer?.name} />
              </Field>
              <Field label="Телефон">
                <input
                  name="phone"
                  type="tel"
                  required
                  defaultValue={customer?.phone}
                />
              </Field>
              <Field label="Электронная почта">
                <input
                  name="email"
                  type="email"
                  defaultValue={customer?.email || ""}
                />
              </Field>
              <Field label="Комментарий">
                <textarea name="comment" defaultValue={customer?.comment} />
              </Field>
            </>
          ) : kind === "vehicles" ? (
            <>
              <Field label="Найти владельца">
                <input
                  value={customerQuery}
                  onChange={(e) => setCustomerQuery(e.target.value)}
                  placeholder="Имя или телефон"
                />
              </Field>
              <Field label="Владелец">
                <select
                  name="customerId"
                  required
                  defaultValue={vehicle?.customerId || ""}
                >
                  <option value="">Выберите клиента</option>
                  {vehicle?.customer &&
                    !customers.some((c) => c.id === vehicle.customerId) && (
                      <option value={vehicle.customerId}>
                        {vehicle.customer.name}
                      </option>
                    )}
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · {c.phone}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Марка">
                <input name="make" required defaultValue={vehicle?.make} />
              </Field>
              <Field label="Модель">
                <input name="model" required defaultValue={vehicle?.model} />
              </Field>
              <Field label="Год выпуска">
                <input
                  name="year"
                  type="number"
                  min="1900"
                  max={new Date().getFullYear() + 1}
                  defaultValue={vehicle?.year || ""}
                />
              </Field>
              <Field label="Госномер">
                <input name="plate" defaultValue={vehicle?.plate || ""} />
              </Field>
              <Field label="VIN">
                <input
                  name="vin"
                  maxLength={17}
                  defaultValue={vehicle?.vin || ""}
                />
              </Field>
              <Field label="Пробег, км">
                <input
                  name="mileage"
                  type="number"
                  min="0"
                  step="1"
                  required
                  defaultValue={vehicle?.mileage || 0}
                />
              </Field>
              <Field label="Двигатель">
                <input name="engine" defaultValue={vehicle?.engine} />
              </Field>
              <Field label="Комментарий">
                <textarea name="comment" defaultValue={vehicle?.comment} />
              </Field>
            </>
          ) : kind === "catalog" ? (
            <>
              <Field label="Раздел">
                <input
                  name="category"
                  required
                  defaultValue={catalog?.category}
                  placeholder="ТО-1"
                />
              </Field>
              <Field label="Наименование">
                <input name="name" required defaultValue={catalog?.name} />
              </Field>
              <Field label="Единица измерения">
                <input
                  name="unit"
                  required
                  defaultValue={catalog?.unit || "шт."}
                />
              </Field>
              <Field label="Базовая стоимость работы, ₽">
                <input
                  name="laborPriceCents"
                  inputMode="decimal"
                  required
                  defaultValue={formatMoney(catalog?.laborPriceCents || 0)}
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="Имя сотрудника">
                <input name="name" required defaultValue={staff?.name} />
              </Field>
              {!item && (
                <Field label="Электронная почта">
                  <input name="email" type="email" required />
                </Field>
              )}
              <Field label="Роль">
                <select name="role" defaultValue={staff?.role || "MASTER"}>
                  {Object.entries(roles).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={item ? "Новый пароль (необязательно)" : "Пароль"}>
                <input
                  name="password"
                  type="password"
                  minLength={12}
                  required={!item}
                  autoComplete="new-password"
                />
              </Field>
            </>
          )}
        </div>
        <div className="form-footer">
          <button type="button" className="secondary" onClick={close}>
            Отмена
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function AdminSettings() {
  const [value, setValue] = useState<Settings | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [success, setSuccess] = useState(false);
  useEffect(() => {
    api<Settings>("/settings")
      .then(setValue)
      .catch((e) => setError(e.message));
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setSuccess(false);
    try {
      const settings = await api<Settings>(
        "/settings",
        "PATCH",
        Object.fromEntries(new FormData(e.currentTarget)),
      );
      configureTimezone(settings.timezone);
      setValue(settings);
      setSuccess(true);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel settings-panel">
      <div className="panel-heading">
        <div>
          <h2>Реквизиты автосервиса</h2>
          <p>Используются в новых печатных документах</p>
        </div>
      </div>
      {error && <Notice>{error}</Notice>}
      {success && (
        <div className="success" role="status">
          Настройки сохранены
        </div>
      )}
      {value && (
        <form onSubmit={submit} className="settings-form">
          <div className="form-grid">
            {[
              ["name", "Название сервиса"],
              ["phone", "Телефон"],
              ["address", "Адрес"],
              ["taxId", "ИНН"],
              ["timezone", "Часовой пояс (IANA)"],
            ].map(([key, label]) => (
              <Field key={key} label={label}>
                <input
                  name={key}
                  required={key === "name" || key === "timezone"}
                  defaultValue={value[key as keyof Settings]}
                />
              </Field>
            ))}
          </div>
          <div className="form-footer">
            <button className="primary" disabled={busy}>
              {busy ? "Сохраняем…" : "Сохранить настройки"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
