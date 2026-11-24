import { useEffect, useState } from "react";
import { ClipboardList, UserRound, Car, Wrench, Plus } from "lucide-react";
import type { Actor, OrderDetail, PageResult } from "@/lib/types";
import { api, date, statuses } from "@/lib/client";
import { formatMoney } from "@/lib/money";
import { allDates, Empty, Field, Notice, Pagination, PeriodFilter, periodQuery, type Period } from "./ui";
import { NewOrder } from "./intake";

type OverviewData = {
  counts: Record<"active" | "approval" | "ready" | "completed", number>;
  money: Record<"laborCents" | "partsCents" | "unallocatedCents" | "totalCents" | "debtCents", number>;
};
const groups = [
  ["active", "Активные заказы", ClipboardList],
  ["approval", "На согласовании", UserRound],
  ["ready", "Готовы к выдаче", Car],
  ["completed", "Завершено", Wrench],
] as const;

export function Overview({ user }: { user: Actor }) {
  return user.role === "MASTER"
    ? <section className="panel pad"><a href="#orders">Открыть назначенные заказы</a></section>
    : <OverviewMetrics />;
}
function OverviewMetrics() {
  const [value, setValue] = useState<OverviewData | null>(null);
  const [period, setPeriod] = useState<Period>({ ...allDates, kind: "month" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [retry, refresh] = useState(0);
  const query = periodQuery(period).toString();
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      setBusy(true);
      setError("");
      api<OverviewData>(`/overview?${query}`)
        .then((res) => { if (live) setValue(res); })
        .catch((err) => { if (live) { setValue(null); setError(err.message); } })
        .finally(() => { if (live) setBusy(false); });
    });
    return () => { live = false; clearTimeout(timer); };
  }, [query, retry]);
  return <>
    <section className="panel pad">
      <PeriodFilter value={period} onChange={setPeriod} />
    </section>
    {error && <Notice>{error} <button className="secondary" onClick={() => refresh((n) => n + 1)}>Повторить</button></Notice>}
    {busy && <p role="status">Загружаем обзор…</p>}
    {!busy && value && <>
      <div className="stats">
        {groups.map(([key, label, Icon]) => (
          <div className="stat" key={key}>
            <div><span>{label}</span><Icon size={20} aria-hidden="true" /></div>
            <strong>{value.counts[key]}</strong>
            <small>{key === "completed" ? "За период" : "Сейчас"}</small>
          </div>
        ))}
      </div>
      <div className="stats">
        {([
          ["laborCents", "Получено за работы"],
          ["partsCents", "Получено за детали"],
          ["totalCents", "Получено всего"],
        ] as const).map(([key, label]) => (
          <div className="stat" key={key}>
            <div><span>{label}</span></div><strong>{formatMoney(value.money[key])}</strong>
            <small>{key === "totalCents" && value.money.unallocatedCents !== 0
              ? `В том числе не распределено ${formatMoney(value.money.unallocatedCents)}`
              : "За период"}</small>
          </div>
        ))}
        <a className="stat" href="#orders?debtOnly=1">
          <div><span>Долг клиентов</span></div>
          <strong>{formatMoney(value.money.debtCents)}</strong><small>Сейчас · Должники</small>
        </a>
      </div>
    </>}
  </>;
}

export function Orders({ user, query }: { user: Actor; query: string }) {
  const initial = new URLSearchParams(query);
  const [group, setGroup] = useState(initial.get("group") || "");
  const [debt, setDebt] = useState(initial.get("debtOnly") === "1" && user.role !== "MASTER");
  const [period, setPeriod] = useState(allDates);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<PageResult<OrderDetail> | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [create, setCreate] = useState(false);
  const [retry, refresh] = useState(0);
  const params = periodQuery(period);
  params.set("q", q);
  params.set("page", String(page));
  if (group && group !== "cancelled") params.set("group", group);
  if (group === "cancelled") params.set("status", "CANCELLED");
  if (debt) params.set("debtOnly", "1");
  const search = params.toString();
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      setBusy(true);
      setError("");
      api<PageResult<OrderDetail>>(`/orders?${search}`)
        .then((data) => { if (live) setResult(data); })
        .catch((err) => { if (live) { setResult(null); setError(err.message); } })
        .finally(() => { if (live) setBusy(false); });
    }, 180);
    return () => { live = false; clearTimeout(timer); };
  }, [search, retry]);
  return <>
    <section className="panel">
      <div className="panel-heading">
        <h2>{user.role === "MASTER" ? "Назначенные заказы" : "Заказ-наряды"}</h2>
        {user.role !== "MASTER" && <button className="primary" onClick={() => setCreate(true)}><Plus size={18} /> Новый заказ</button>}
      </div>
      <div className="toolbar filter-toolbar">
        <Field label="Поиск заказов">
          <input value={q} maxLength={200} placeholder="Имя, телефон, авто, VIN или заказ" onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </Field>
        <Field label="Группа">
          <select value={group} onChange={(e) => { setGroup(e.target.value); setPage(1); }}>
            <option value="">Все заказы</option>
            {groups.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            <option value="cancelled">Отменённые</option>
          </select>
        </Field>
        <PeriodFilter value={period} onChange={(v) => { setPeriod(v); setPage(1); }} />
        {user.role !== "MASTER" && <label className="check-label"><input type="checkbox" checked={debt} onChange={(e) => { setDebt(e.target.checked); setPage(1); }} /> Только с долгом</label>}
      </div>
      {error && <Notice>{error} <button className="secondary" onClick={() => refresh((n) => n + 1)}>Повторить</button></Notice>}
      {busy ? <Empty>Загружаем заказы…</Empty> : result && <>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Заказ / дата</th><th>Автомобиль</th><th>Клиент</th><th>Статус</th><th>Мастер</th>{user.role !== "MASTER" && <th className="right">Сумма / долг</th>}</tr></thead>
            <tbody>{result.items.map((o) => (
              <tr key={o.id}>
                <td><a className="order-link" href={`#orders/${o.id}`}>№ {o.number}</a><small>{date(o.openedAt)}</small></td>
                <td><strong>{o.vehicle.make} {o.vehicle.model}</strong><small>{o.vehicle.plate || "Без госномера"}</small></td>
                <td>{o.customer.name || "Имя не указано"}<small>{o.customer.phone}</small></td>
                <td><span className={`badge ${o.status.toLowerCase()}`}><i />{statuses[o.status]}</span></td>
                <td>{o.master?.name || "Не назначен"}</td>
                {user.role !== "MASTER" && <td className="right money">{formatMoney(o.totals.totalCents)}
                  {o.totals.balanceCents > 0 && <small>Долг {formatMoney(o.totals.balanceCents)}</small>}</td>}
              </tr>
            ))}</tbody>
          </table>
        </div>
        {!result.items.length && <Empty>Заказов по этим фильтрам нет.</Empty>}
        <Pagination page={page} total={result.total} onChange={setPage} />
      </>}
    </section>
    {create && <NewOrder close={() => setCreate(false)} onCreated={(o) => { setCreate(false); location.hash = `orders/${o.id}`; }} />}
  </>;
}
