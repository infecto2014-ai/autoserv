"use client";
import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Car,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  Plus,
  Settings as SettingsIcon,
  Users,
  Wrench,
  UserRound,
  Menu,
  Download,
} from "lucide-react";
import type { Actor, OrderDetail, PageResult } from "@/lib/types";
import {
  api,
  configureTimezone,
  date,
  today,
  roles,
  statuses,
} from "@/lib/client";
import { formatMoney as moneyWithCurrency } from "@/lib/money";
import { Empty, Field, Notice, Pagination, SearchBox } from "./ui";
import { Records, AdminSettings } from "./records";
import { OrderEditor, NewOrder } from "./order";
const formatMoney = (cents: number) =>
  moneyWithCurrency(cents).replace(/\s*₽$/, "");
const nav = [
  ["overview", "Обзор", LayoutDashboard],
  ["orders", "Заказы", ClipboardList],
  ["customers", "Клиенты", Users],
  ["vehicles", "Автомобили", Car],
  ["catalog", "Справочник", BookOpen],
  ["staff", "Сотрудники", UserRound],
  ["settings", "Настройки", SettingsIcon],
] as const;
export function CRM() {
  const [user, setUser] = useState<Actor | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [section, setSection] = useState("overview"),
    [orderId, setOrderId] = useState(""),
    [mobile, setMobile] = useState(false);
  const sync = useCallback(() => {
    const bits = location.hash.replace("#", "").split("/");
    setSection(bits[0] || "overview");
    setOrderId(bits[0] === "orders" ? bits[1] || "" : "");
    setMobile(false);
  }, []);
  useEffect(() => {
    api<{ user: Actor | null; timezone?: string }>("/auth/session")
      .then((v) => {
        configureTimezone(v.timezone || "Europe/Kaliningrad");
        setUser(v.user);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    queueMicrotask(sync);
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [sync]);
  if (loading)
    return (
      <div className="loading">
        <Wrench size={30} />
        <p>Загружаем рабочее место…</p>
      </div>
    );
  if (!user) return <Login initialError={error} />;
  const admin = user.role === "ADMIN";
  const active = nav.find((n) => n[0] === section)?.[1] || "Обзор";
  return (
    <div className="app">
      <a className="skip" href="#main">
        Перейти к содержимому
      </a>
      <aside className={mobile ? "sidebar open" : "sidebar"}>
        <a href="#overview" className="brand">
          <span className="brand-icon">
            <Wrench size={22} />
          </span>
          <span>
            Сервис<span className="brand-sub">РАБОЧЕЕ ПРОСТРАНСТВО</span>
          </span>
        </a>
        <div className="workspace-label">УПРАВЛЕНИЕ СЕРВИСОМ</div>
        <nav>
          {nav
            .filter((n) => !(["staff", "settings"].includes(n[0]) && !admin))
            .map(([id, label, Icon]) => (
              <a
                key={id}
                href={`#${id}`}
                className={section === id ? "active" : ""}
                aria-current={section === id ? "page" : undefined}
              >
                <Icon size={19} aria-hidden="true" />
                {label}
                {section === id && <span className="nav-dot" />}
              </a>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="service-status">
            <span /> Система работает
          </div>
          <div className="profile">
            <div className="avatar">{user.name.slice(0, 1)}</div>
            <div>
              <strong>{user.name}</strong>
              <small>{roles[user.role]}</small>
            </div>
            <a className="icon" aria-label="Выйти" href="/signout-with-chatgpt?return_to=%2F" target="_top"><LogOut size={18}/></a>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon mobile-menu"
              aria-label="Открыть меню"
              aria-expanded={mobile}
              onClick={() => setMobile(!mobile)}
            >
              <Menu size={20} />
            </button>
            <span>Автосервис</span>
            <span className="crumb-divider">/</span>
            <strong>{active}</strong>
          </div>
          <span className="today">{today()}</span>
        </header>
        <main id="main">
          <div className="page-heading">
            <div>
              <div className="eyebrow">ВАШЕ РАБОЧЕЕ МЕСТО</div>
              <h1>{orderId ? "Карточка заказа" : active}</h1>
              <p>
                {section === "overview"
                  ? "Все процессы сервиса — в одном месте."
                  : section === "orders"
                    ? "От приёмки автомобиля до выдачи клиенту."
                    : section === "customers"
                      ? "Клиенты, контакты и история обращений."
                      : section === "vehicles"
                        ? "Автомобили и полная история обслуживания."
                        : section === "catalog"
                          ? "Единый каталог работ и пунктов осмотра."
                          : section === "staff"
                            ? "Команда сервиса и права доступа."
                            : "Реквизиты для документов и параметры сервиса."}
              </p>
            </div>
            <div className="heading-mark">
              <Activity size={20} />
              <span>Сервис CRM</span>
            </div>
          </div>
          {orderId ? (
            <OrderEditor key={orderId} id={orderId} user={user} />
          ) : section === "overview" || section === "orders" ? (
            <Orders overview={section === "overview"} user={user} />
          ) : section === "settings" ? (
            admin ? (
              <AdminSettings />
            ) : (
              <Notice>Раздел доступен администратору.</Notice>
            )
          ) : (
            <Records key={section} kind={section} user={user} />
          )}
        </main>
        <footer>
          Сервис CRM <span>Клиенты · Автомобили · Забота о деталях</span>
        </footer>
      </div>
    </div>
  );
}
function Login({initialError}:{initialError:string}) {
  return <div className="login"><div className="login-story"><div className="brand"><span className="brand-icon"><Wrench/></span>Сервис CRM</div><div><span className="eyebrow">ПОРЯДОК В КАЖДОЙ ДЕТАЛИ</span><h1>Больше внимания<br/>автомобилям.<br/>Меньше — бумаге.</h1><p>Рабочая CRM с сохранением клиентов, осмотров, заказов и PDF в облачной базе.</p></div><small>Закрытый доступ к данным сервиса</small></div><div className="login-form"><section><span className="login-symbol"><Wrench size={26}/></span><h2>Вход в сервис</h2><p>Используйте свою учётную запись ChatGPT.</p>{initialError&&<Notice>{initialError}</Notice>}<a className="primary full" href="/signin-with-chatgpt?return_to=%2F" target="_top">Войти через ChatGPT <ArrowUpRight size={18}/></a><small>Доступ предоставляется владельцем сайта и администратором CRM.</small></section></div></div>;
}
function Orders({ overview, user }: { overview: boolean; user: Actor }) {
  const [items, setItems] = useState<OrderDetail[]>([]),
    [all, setAll] = useState<OrderDetail[]>([]),
    [q, setQ] = useState(""),
    [status, setStatus] = useState(""),
    [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [create, setCreate] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const timeout = setTimeout(() => {
      setBusy(true);
      api<PageResult<OrderDetail>>(
        `/orders?q=${encodeURIComponent(q)}&status=${status}&page=${page}`,
      )
        .then((r) => {
          if (active) {
            setItems(r.items);
            setTotal(r.total);
            setError("");
          }
        })
        .catch((e) => active && setError(e.message))
        .finally(() => active && setBusy(false));
    }, 200);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [q, status, page, revision]);
  useEffect(() => {
    if (!overview) return;
    let active = true;
    (async () => {
      const collected: OrderDetail[] = [];
      let p = 1;
      let count = 1;
      while (collected.length < count) {
        const r = await api<PageResult<OrderDetail>>(
          `/orders?page=${p++}&pageSize=100`,
        );
        collected.push(...r.items);
        count = r.total;
        if (!r.items.length) break;
      }
      if (active) setAll(collected);
    })().catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [overview, revision]);
  return (
    <>
      {overview && (
        <div className="stats">
          {[
            {
              label: "Активные заказы",
              value: all.filter(
                (o) => !["DELIVERED", "CANCELLED"].includes(o.status),
              ).length,
              icon: ClipboardList,
              sub: "В работе сервиса",
              color: "blue",
            },
            {
              label: "На согласовании",
              value: all.filter((o) => o.status === "APPROVAL").length,
              icon: UserRound,
              sub: "Ожидают решения клиента",
              color: "amber",
            },
            {
              label: "Готовы к выдаче",
              value: all.filter((o) => o.status === "READY").length,
              icon: Car,
              sub: "Ремонт завершён",
              color: "green",
            },
            {
              label: "Завершено",
              value: all.filter((o) => o.status === "DELIVERED").length,
              icon: Wrench,
              sub: "Выдано автомобилей",
              color: "violet",
            },
          ].map((s) => (
            <div className="stat" key={s.label}>
              <div>
                <span>{s.label}</span>
                <s.icon size={20} className={s.color} />
              </div>
              <strong>{s.value}</strong>
              <small>{s.sub}</small>
            </div>
          ))}
        </div>
      )}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{overview ? "Последние заказы" : "Заказ-наряды"}</h2>
            <p>
              {user.role === "MASTER"
                ? "Назначенные вам автомобили"
                : "Управляйте обращениями и ходом ремонта"}
            </p>
          </div>
          <div className="actions">
            {user.role !== "MASTER" && (
              <>
                <a
                  className="secondary button"
                  href="/api/orders/export"
                  download
                >
                  <Download size={16} />
                  CSV
                </a>
                <button className="primary" onClick={() => setCreate(true)}>
                  <Plus size={18} />
                  Новый заказ
                </button>
              </>
            )}
          </div>
        </div>
        <div className="toolbar">
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              setPage(1);
            }}
          />
          <select
            aria-label="Фильтр по статусу"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Все статусы</option>
            {Object.entries(statuses).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        {error && <Notice>{error}</Notice>}
        <div className="table-wrap" aria-busy={busy}>
          <table>
            <thead>
              <tr>
                <th>Заказ / дата</th>
                <th>Автомобиль</th>
                <th>Клиент</th>
                <th>Статус</th>
                <th>Мастер</th>
                {user.role !== "MASTER" && <th className="right">Сумма</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((o) => (
                <tr key={o.id}>
                  <td>
                    <a className="order-link" href={`#orders/${o.id}`}>
                      № {o.number}
                    </a>
                    <small>{date(o.openedAt)}</small>
                  </td>
                  <td>
                    <strong>
                      {o.vehicle.make} {o.vehicle.model}
                    </strong>
                    <small>{o.vehicle.plate || "Без госномера"}</small>
                  </td>
                  <td>
                    {o.customer.name}
                    <small>{o.customer.phone}</small>
                  </td>
                  <td>
                    <span className={`badge ${o.status.toLowerCase()}`}>
                      <i />
                      {statuses[o.status]}
                    </span>
                  </td>
                  <td>{o.master?.name || "Не назначен"}</td>
                  {user.role !== "MASTER" && (
                    <td className="right money">
                      {formatMoney(o.totals?.totalCents || 0)} ₽
                    </td>
                  )}
                  <td>
                    <a
                      className="icon"
                      href={`#orders/${o.id}`}
                      aria-label={`Открыть заказ ${o.number}`}
                    >
                      <ArrowUpRight size={18} />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!items.length && (
            <Empty>
              {busy
                ? "Загружаем заказы…"
                : "Заказов пока нет. Создайте первый заказ или измените фильтры."}
            </Empty>
          )}
        </div>
        <Pagination page={page} total={total} onChange={setPage} />
      </section>
      {create && (
        <NewOrder
          close={() => setCreate(false)}
          onCreated={(o) => {
            setCreate(false);
            setRevision((v) => v + 1);
            location.hash = `orders/${o.id}`;
          }}
        />
      )}
    </>
  );
}
