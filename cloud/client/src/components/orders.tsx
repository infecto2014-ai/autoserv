import { useEffect, useState, type CSSProperties } from "react";
import { ClipboardList, UserRound, Car, Wrench, Plus, CircleCheck, Coins, Wallet, Layers3, CircleDollarSign, ChartNoAxesCombined } from "lucide-react";
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
  ["completed", "Завершено", CircleCheck],
] as const;

export function Overview({ user }: { user: Actor }) {
  return user.role === "MASTER"
    ? <section className="panel pad"><h1>Обзор</h1><a href="#orders">Открыть назначенные заказы</a></section>
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
  return <div className="overview-page">
    <section className="overview-hero" aria-labelledby="overview-title">
      <div className="overview-intro">
        <span className="eyebrow">ТОП-СЕРВИС · РАБОЧЕЕ ПРОСТРАНСТВО</span>
        <h1 id="overview-title">Обзор</h1>
        <p>Панель управления автосервисом</p>
        <div className="overview-period"><PeriodFilter value={period} onChange={setPeriod} /></div>
      </div>
    </section>
    {error && <Notice>{error} <button className="secondary" onClick={() => refresh((n) => n + 1)}>Повторить</button></Notice>}
    {busy && <div className="overview-skeleton" role="status" aria-label="Загружаем обзор…"><div className="stats" aria-hidden="true">{Array.from({length:8}, (_,i) => <div className="stat skeleton" key={i}><span/><strong/><small/></div>)}</div></div>}
    {!busy && value && <>
      <div className="stats">
        {groups.map(([key, label, Icon], index) => (
          <div className="stat" data-tone={["cyan", "blue", "orange", "green"][index]} key={key}>
            <span className="stat-icon"><Icon size={25} aria-hidden="true" /></span>
            <div className="stat-copy"><span>{label}</span>
              <strong key={value.counts[key]}>{value.counts[key]}</strong>
              <small>{key === "completed" ? "За выбранный период" : "Сейчас"}</small>
            </div>
          </div>
        ))}
      </div>
      <div className="stats">
        {([
          ["laborCents", "Получено за работы", Wrench, "cyan"],
          ["partsCents", "Получено за детали", Layers3, "orange"],
          ["totalCents", "Получено всего", Wallet, "green"],
        ] as const).map(([key, label, Icon, tone]) => (
          <div className="stat" data-tone={tone} key={key}>
            <span className="stat-icon"><Icon size={25} aria-hidden="true" /></span>
            <div className="stat-copy"><span>{label}</span><strong key={value.money[key]}>{formatMoney(value.money[key])}</strong>
            <small>{key === "totalCents" && value.money.unallocatedCents !== 0
              ? `В том числе не распределено ${formatMoney(value.money.unallocatedCents)}`
              : "За выбранный период"}</small></div>
          </div>
        ))}
        <a className="stat" data-tone="orange" href="#orders?debtOnly=1">
          <span className="stat-icon"><CircleDollarSign size={25} aria-hidden="true" /></span>
          <div className="stat-copy"><span>Долг клиентов</span>
          <strong key={value.money.debtCents}>{formatMoney(value.money.debtCents)}</strong><small>Сейчас · Открыть должников</small></div>
        </a>
      </div>
      <Revenue money={value.money} />
    </>}
  </div>;
}

function Revenue({money}: {money: OverviewData["money"]}) {
  const chartable = money.totalCents > 0 && [money.laborCents, money.partsCents, money.unallocatedCents].every(v => v >= 0);
  const share = (value: number) => chartable ? value / money.totalCents * 100 : 0;
  const ringStyle = {"--labor-share": `${share(money.laborCents)}%`, "--parts-share": `${share(money.laborCents + money.partsCents)}%`} as CSSProperties;
  return <section className="panel revenue-panel" aria-labelledby="revenue-heading">
    <div className="panel-heading"><h2 id="revenue-heading"><ChartNoAxesCombined size={21} aria-hidden="true" /> Структура поступлений</h2><span className="muted">За выбранный период</span></div>
    <div className="revenue-layout">
      <div className={`revenue-ring${chartable ? "" : " is-empty"}`} style={ringStyle} aria-hidden="true"><div className="revenue-total"><Coins size={23}/><strong>{formatMoney(money.totalCents)}</strong><small>Получено всего</small></div></div>
      <div className="revenue-legend">
        <div data-tone="cyan"><span>Работы</span><strong>{formatMoney(money.laborCents)}</strong></div>
        <div data-tone="orange"><span>Запчасти и детали</span><strong>{formatMoney(money.partsCents)}</strong></div>
        {money.unallocatedCents !== 0 && <div><span>Пока не распределено</span><strong>{formatMoney(money.unallocatedCents)}</strong></div>}
        <div className="revenue-sum"><span>Всего поступило</span><strong>{formatMoney(money.totalCents)}</strong></div>
        <p>{chartable ? "Фактические поступления с учётом возвратов. Долги в эту сумму не входят."
          : money.totalCents === 0 && [money.laborCents, money.partsCents, money.unallocatedCents].every(v => v === 0)
            ? "Чистые поступления за выбранный период равны нулю. Возвраты учтены в итоговой сумме."
            : "За период есть возвраты. Суммы показаны с учётом возвратов; круговая диаграмма недоступна."}</p>
      </div>
    </div>
  </section>;
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
