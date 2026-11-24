import { useEffect, useState, type FormEvent } from "react";
import type { Actor, Customer, Vehicle, Settings, CatalogItem, PageResult } from "@/lib/types";
import { api, configureTimezone } from "@/lib/client";
import { formatMoney, parseMoney } from "@/lib/money";
import { useDraftGuard } from "@/lib/workflow";
import { Empty, Field, Modal, Notice, Pagination } from "./ui";

export function Catalog({ user }: { user: Actor }) {
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<CatalogItem | "new" | null>(null);
  const [revision, refresh] = useState(0);
  const [saved, setSaved] = useState("");
  useEffect(() => {
    let live = true;
    api<{ items: CatalogItem[] }>("/catalog").then((data) => {
      if (live) { setItems(data.items); setError(""); }
    }).catch((err) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [revision]);
  async function toggle(item: CatalogItem) {
    setBusy(true);
    setError("");
    try {
      await api(`/catalog/${item.id}`, "PATCH", { active: !item.active });
      refresh((n) => n + 1);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  const matching = items?.filter((item) => `${item.name} ${item.category}`.toLocaleLowerCase("ru-RU").includes(q.trim().toLocaleLowerCase("ru-RU")));
  const admin = user.role === "ADMIN";
  return <section className="panel">
    <div className="panel-heading"><h2>Пункты осмотра и работы</h2>
      {admin && <button className="primary" disabled={busy} onClick={() => setEdit("new")}>Добавить позицию</button>}
    </div>
    <div className="toolbar"><Field label="Поиск по справочнику">
      <input type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
    </Field></div>
    {error && <Notice>{error} <button className="secondary" onClick={() => refresh((n) => n + 1)}>Повторить</button></Notice>}
    {saved && <p className="success" role="status">{saved}</p>}
    {matching?.length ? <>
      <div className="table-wrap"><table>
        <thead><tr><th>Наименование</th><th>Раздел</th><th>Единица</th>{user.role !== "MASTER" && <th>Стоимость работы</th>}{admin && <th>Действия</th>}</tr></thead>
        <tbody>{matching.slice((page - 1) * 25, page * 25).map((item) => <tr key={item.id}>
          <td>{item.name}{!item.active && <small>Неактивна</small>}</td><td>{item.category}</td><td>{item.unit}</td>
          {user.role !== "MASTER" && <td>{formatMoney(item.laborPriceCents)}</td>}
          {admin && <td><div className="actions">
            <button className="secondary" disabled={busy} onClick={() => setEdit(item)}>Изменить</button>
            <button className="secondary" disabled={busy} onClick={() => void toggle(item)}>{item.active ? "Отключить" : "Включить"}</button>
          </div></td>}
        </tr>)}</tbody>
      </table></div>
      <Pagination page={page} total={matching.length} onChange={setPage} />
    </> : <Empty>{items ? "Позиций не найдено." : error ? "Справочник недоступен." : "Загружаем справочник…"}</Empty>}
    {edit && <CatalogForm item={edit === "new" ? null : edit} close={() => setEdit(null)} saved={() => {
      setEdit(null); setSaved("Позиция сохранена."); refresh((n) => n + 1);
    }} />}
  </section>;
}

function CatalogForm({ item, close, saved }: { item: CatalogItem | null; close: () => void; saved: () => void }) {
  return <EditModal title={item ? "Изменить позицию осмотра" : "Добавить позицию осмотра"} close={close}
    save={async (data) => {
      await api(item ? `/catalog/${item.id}` : "/catalog", item ? "PATCH" : "POST", {
        ...data, laborPriceCents: parseMoney(String(data.laborPriceCents)), sortOrder: Number(data.sortOrder),
      });
      saved();
    }}>
    <Field label="Наименование"><input name="name" maxLength={200} required defaultValue={item?.name} /></Field>
    <Field label="Раздел"><input name="category" maxLength={100} required defaultValue={item?.category} /></Field>
    <Field label="Единица измерения"><input name="unit" maxLength={30} required defaultValue={item?.unit ?? "шт."} /></Field>
    <Field label="Стоимость работы, ₽"><input name="laborPriceCents" inputMode="decimal" required defaultValue={formatMoney(item?.laborPriceCents ?? 0).replace(/\s*₽$/, "")} /></Field>
    <Field label="Порядок"><input name="sortOrder" type="number" min={0} max={1000000} required defaultValue={item?.sortOrder ?? 0} /></Field>
  </EditModal>;
}

export function RecordForm({ item, close, saved }: { item: Customer | Vehicle; close: () => void; saved: () => void }) {
  const [people, setPeople] = useState<Customer[]>([]);
  const [q, setQ] = useState("");
  const [owner, setOwner] = useState("make" in item ? item.customer ?? null : null);
  const [lookupError, setLookupError] = useState("");
  const car = "make" in item ? item : null;
  const customer = "name" in item ? item : null;
  useEffect(() => {
    if (!car || !q.trim()) return;
    let live = true;
    const timeout = setTimeout(() => {
      setLookupError("");
      api<PageResult<Customer>>(`/customers?q=${encodeURIComponent(q)}`).then((data) => {
        if (live) setPeople(data.items.filter((c) => !c.archivedAt));
      }).catch((err) => { if (live) setLookupError(err.message); });
    }, 180);
    return () => { live = false; clearTimeout(timeout); };
  }, [car, q]);
  return <EditModal title={car ? "Редактировать автомобиль" : "Редактировать клиента"} close={close}
    save={async (data) => {
      const { archived, ...fields } = data;
      const archiveChanged = (archived === "on") !== !!item.archivedAt;
      const patch: Record<string, unknown> = { ...fields, ...(archiveChanged ? { archived: archived === "on" } : {}) };
      if (car) {
        patch.mileage = Number(fields.mileage);
        patch.year = fields.year ? Number(fields.year) : null;
        if (!String(fields.model).trim() && !car.model) delete patch.model;
        if (owner && owner.id !== car.customerId) patch.customerId = owner.id;
      } else if (!String(fields.name).trim() && !customer?.name) delete patch.name;
      await api(`/${car ? "vehicles" : "customers"}/${item.id}`, "PATCH", patch);
      saved();
    }}>
    {car ? <>
      <div className="form-grid">
        <Field label="Марка"><input name="make" required maxLength={100} defaultValue={car.make} /></Field>
        <Field label="Модель"><input name="model" required={!!car.model} maxLength={100} defaultValue={car.model} /></Field>
        <Field label="Год выпуска"><input name="year" type="number" min={1886} max={new Date().getUTCFullYear() + 1} defaultValue={car.year ?? ""} /></Field>
        <Field label="Пробег, км"><input name="mileage" type="number" required min={car.mileage} max={10000000} defaultValue={car.mileage} /></Field>
        <Field label="Госномер"><input name="plate" maxLength={30} defaultValue={car.plate ?? ""} /></Field>
        <Field label="VIN"><input name="vin" maxLength={17} defaultValue={car.vin ?? ""} /></Field>
      </div>
      <Field label="Двигатель"><input name="engine" maxLength={300} defaultValue={car.engine} /></Field>
      <p>Владелец: {owner?.name || owner?.phone || "Имя не указано"}</p>
      <Field label="Найти другого владельца"><input type="search" value={q} maxLength={200} onChange={(e) => setQ(e.target.value)} /></Field>
      {lookupError && <Notice>{lookupError} Измените запрос, чтобы повторить поиск.</Notice>}
      {q.trim() && people.length > 0 && <Field label="Найденные владельцы">
        <select value={owner?.id ?? ""} onChange={(e) => setOwner(people.find((c) => c.id === e.target.value) ?? car.customer ?? null)}>
          <option value="">Оставить прежнего владельца</option>
          {people.map((c) => <option key={c.id} value={c.id}>{c.name || "Имя не указано"} · {c.phone}</option>)}
        </select>
      </Field>}
    </> : customer && <>
      <Field label="ФИО / название"><input name="name" required={!!customer.name} maxLength={200} defaultValue={customer.name} /></Field>
      <Field label="Телефон"><input name="phone" type="tel" required maxLength={50} defaultValue={customer.phone} /></Field>
      <Field label="Электронная почта"><input name="email" type="email" maxLength={254} defaultValue={customer.email ?? ""} /></Field>
    </>}
    <Field label="Комментарий"><textarea name="comment" maxLength={10000} defaultValue={item.comment} /></Field>
    <label className="check-label"><input name="archived" type="checkbox" defaultChecked={!!item.archivedAt} /> В архиве</label>
  </EditModal>;
}

function EditModal({ title, close, save, children }: {
  title: string; close: () => void; save: (data: Record<string, FormDataEntryValue>) => Promise<void>; children: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  useDraftGuard(busy || dirty, setError);
  function cancel() {
    if (!busy && (!dirty || confirm("Закрыть форму и сбросить правки?"))) close();
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try { await save(Object.fromEntries(new FormData(e.currentTarget))); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <Modal title={title} close={cancel}>
    <form onSubmit={submit} onChange={() => setDirty(true)}>
      {error && <Notice>{error}</Notice>}
      <fieldset disabled={busy} className="form-fields">{children}</fieldset>
      <div className="form-footer">
        <button className="secondary" type="button" disabled={busy} onClick={cancel}>Отмена</button>
        <button className="primary" disabled={busy || !dirty}>{busy ? "Сохраняем…" : "Сохранить"}</button>
      </div>
    </form>
  </Modal>;
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
