import { useEffect, useState, type FormEvent } from "react";
import type { Actor, Customer, OrderDetail, PageResult, Staff, Vehicle } from "@/lib/types";
import { api, date, statuses } from "@/lib/client";
import { formatMoney } from "@/lib/money";
import { allDates, Empty, Field, Modal, Notice, Pagination, PeriodFilter, periodQuery } from "./ui";
import { RecordForm } from "./records";

type DirectoryKind = "customers" | "vehicles";
type RecordItem = Customer | Vehicle;
type HistoryRecord = RecordItem & { orders: OrderDetail[]; vehicles?: Vehicle[] };

function recordName(item: RecordItem) {
  return "make" in item ? `${item.make} ${item.model}`.trim() : item.name || "Имя не указано";
}

export function Directory({ user }: { user: Actor }) {
  const [kind, setKind] = useState<DirectoryKind>("customers");
  const [period, setPeriod] = useState(allDates);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<PageResult<RecordItem> | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [revision, refresh] = useState(0);
  const [history, setHistory] = useState<{ kind: DirectoryKind; item: RecordItem } | null>(null);
  const [edit, setEdit] = useState<RecordItem | null>(null);
  const [editRevision, resetEdit] = useState(0);
  const [saved, setSaved] = useState(false);
  const dates = periodQuery(period).toString();
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      setBusy(true);
      setError("");
      const params = new URLSearchParams(dates);
      params.set("q", q);
      params.set("page", String(page));
      api<PageResult<RecordItem>>(`/${kind}?${params}`).then((data) => {
        if (live) setResult(data);
      }).catch((err) => {
        if (live) { setResult(null); setError(err.message); }
      }).finally(() => { if (live) setBusy(false); });
    }, 180);
    return () => { live = false; clearTimeout(timer); };
  }, [dates, kind, q, page, revision]);
  function choose(next: DirectoryKind) {
    if (next === kind) return;
    setKind(next);
    setResult(null);
    setPage(1);
    setBusy(true);
  }
  return <section className="panel">
    <div className="toolbar filter-toolbar">
      <Field label="Поиск клиентов и авто">
        <input type="search" value={q} maxLength={200} placeholder="Имя, телефон, марка, госномер, VIN или заказ" onChange={(e) => { setQ(e.target.value); setPage(1); }} />
      </Field>
      <PeriodFilter value={period} onChange={(v) => { setPeriod(v); setPage(1); }} />
    </div>
    <div className="tabs section-switch" aria-label="Тип записей">
      <button aria-pressed={kind === "customers"} className={kind === "customers" ? "active" : ""} onClick={() => choose("customers")}>Клиенты</button>
      <button aria-pressed={kind === "vehicles"} className={kind === "vehicles" ? "active" : ""} onClick={() => choose("vehicles")}>Автомобили</button>
    </div>
    {saved && <p className="success" role="status">Запись сохранена.</p>}
    {error && <Notice>{error} <button className="secondary" onClick={() => refresh((n) => n + 1)}>Повторить</button></Notice>}
    {busy ? <Empty>Загружаем записи…</Empty> : result && <>
      {result.items.length ? <div className="table-wrap"><table>
        <thead><tr><th>{kind === "customers" ? "Клиент" : "Автомобиль"}</th><th>{kind === "customers" ? "Телефон" : "Владелец"}</th><th>Действия</th></tr></thead>
        <tbody>{result.items.map((item) => <tr key={item.id}>
          <td><strong>{recordName(item)}</strong>{"make" in item && <small>{[item.plate, item.vin].filter(Boolean).join(" · ")}</small>}{item.archivedAt && <small>В архиве</small>}</td>
          <td>{"make" in item ? item.customer?.name || item.customer?.phone || "—" : item.phone ? <a href={`tel:${item.phone}`}>{item.phone}</a> : "—"}</td>
          <td><div className="actions">
            <button className="secondary" onClick={() => setHistory({ kind, item })}>История</button>
            {user.role !== "MASTER" && <button className="secondary" onClick={() => { setSaved(false); setEdit(item); }}>Изменить</button>}
          </div></td>
        </tr>)}</tbody>
      </table></div> : <Empty>По этим фильтрам записей нет.</Empty>}
      <Pagination page={page} total={result.total} onChange={setPage} />
    </>}
    {history && <History key={history.item.id} {...history} dates={dates} money={user.role !== "MASTER"}
      close={() => setHistory(null)} openVehicle={(item) => setHistory({ kind: "vehicles", item })} />}
    {edit && <RecordForm key={editRevision} item={edit} reload={(fresh) => { setEdit(fresh); resetEdit(n => n + 1); }} close={() => setEdit(null)} saved={() => { setEdit(null); setSaved(true); refresh((n) => n + 1); }} />}
  </section>;
}

function History({ item, kind, dates, money, close, openVehicle }: {
  item: RecordItem; kind: DirectoryKind; dates: string; money: boolean;
  close: () => void; openVehicle: (v: Vehicle) => void;
}) {
  const [result, setResult] = useState<HistoryRecord | null>(null);
  const [error, setError] = useState("");
  const [revision, refresh] = useState(0);
  useEffect(() => {
    let live = true;
    api<HistoryRecord>(`/${kind}/${item.id}?${dates}`).then((data) => { if (live) setResult(data); })
      .catch((err) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [kind, item.id, dates, revision]);
  return <Modal title={`История · ${recordName(item)}`} close={close}>
    <div className="history-content">
      {error ? <Notice>{error} <button className="secondary" onClick={() => { setError(""); refresh((n) => n + 1); }}>Повторить</button></Notice>
        : !result ? <p role="status">Загружаем историю…</p> : <>
          {"make" in result && <p>{[result.plate, result.vin].filter(Boolean).join(" · ") || "Госномер и VIN не указаны"}</p>}
          {result.vehicles?.length ? <div className="actions">{result.vehicles.map((vehicle) =>
            <button className="secondary" key={vehicle.id} onClick={() => openVehicle(vehicle)}>{recordName(vehicle)} {vehicle.plate}</button>,
          )}</div> : null}
          {result.orders.length ? <ul className="history-list">{result.orders.map((o) => <li key={o.id}>
            <div><a href={`#orders/${o.id}`}>№ {o.number} · {date(o.openedAt)}</a>
              <small>{o.vehicle.make} {o.vehicle.model} · {statuses[o.status]}</small>
              <span>{o.complaint}</span></div>
            {money && <div><strong>{formatMoney(o.totals.totalCents)}</strong>
              {o.totals.balanceCents > 0 && <small>Долг {formatMoney(o.totals.balanceCents)}</small>}
            </div>}
          </li>)}</ul> : <Empty>Обращений за этот период нет.</Empty>}
        </>}
    </div>
  </Modal>;
}

export function Masters() {
  const [items, setItems] = useState<Staff[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [editRevision, resetEdit] = useState(0);
  const [saved, setSaved] = useState("");
  const [retry, refresh] = useState(0);
  useEffect(() => {
    let live = true;
    api<{ items: Staff[] }>("/staff").then((data) => {
      if (live) setItems(data.items.filter((item) => item.role === "MASTER"));
    }).catch((err) => { if (live) setLoadError(err.message); });
    return () => { live = false; };
  }, [retry]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const item = await api<Staff>("/staff", "POST", { name: name.trim() });
      setItems((list) => list?.some((s) => s.id === item.id) ? list : [...(list ?? []), item]);
      setName("");
      setSaved(`Мастер «${item.name}» добавлен.`);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="panel pad">
    <h2>Мастера</h2>
    <form className="inline-fields" onSubmit={submit}>
      <Field label="Имя мастера"><input required maxLength={200} value={name} disabled={busy} onChange={(e) => setName(e.target.value)} /></Field>
      <button className="primary" disabled={busy || !name.trim()}>{busy ? "Добавляем…" : "Добавить мастера"}</button>
    </form>
    {error && <Notice>{error}</Notice>}
    {saved && <p role="status" className="success">{saved}</p>}
    {loadError ? <Notice>{loadError} <button className="secondary" onClick={() => { setLoadError(""); refresh((n) => n + 1); }}>Повторить</button></Notice>
      : !items ? <Empty>Загружаем список…</Empty> : !items.length ? <Empty>Мастеров пока нет.</Empty>
      : <ul className="masters-list">{items.map((item) => <li key={item.id}>{item.name}{!item.active && <small> · Неактивен</small>}</li>)}</ul>}
  </section>;
}
