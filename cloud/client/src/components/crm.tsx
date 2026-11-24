"use client";
import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, BookOpen, Car, ClipboardList, LayoutDashboard, LogOut, Settings as SettingsIcon, UserRound, Wrench, Menu } from "lucide-react";
import type { Actor } from "@/lib/types";
import { api, configureTimezone, today, roles } from "@/lib/client";
import { Notice } from "./ui";
import { Catalog, AdminSettings } from "./records";
import { Directory, Masters } from "./directory";
import { OrderEditor } from "./order";
import { Orders, Overview } from "./orders";

const nav = [
  ["overview", "Обзор", LayoutDashboard],
  ["orders", "Заказы", ClipboardList],
  ["directory", "Клиенты и авто", Car],
  ["staff", "Сотрудники", UserRound],
  ["catalog", "Справочник", BookOpen],
  ["settings", "Настройки", SettingsIcon],
] as const;
export function CRM() {
  const [user, setUser] = useState<Actor | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [section, setSection] = useState("overview"),
    [orderId, setOrderId] = useState(""),
    [orderFilter, setOrderFilter] = useState(""),
    [mobile, setMobile] = useState(false);
  const sync = useCallback(() => {
    const bits = location.hash.replace("#", "").split("/");
    const [name, query = ""] = (bits[0] || "overview").split("?");
    setSection(["customers", "vehicles"].includes(name) ? "directory" : name);
    setOrderFilter(query);
    setOrderId(name === "orders" ? bits[1] || "" : "");
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
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>
        Перейти к содержимому
      </a>
      <aside className={mobile ? "sidebar open" : "sidebar"}>
        <a href="#overview" className="brand">
          <span className="brand-icon">
            <Wrench size={22} />
          </span>
          <span>
            TOP-СЕРВИС
          </span>
        </a>
        <nav>
          {nav
            .filter(([id]) => id !== "catalog" && (id !== "settings" || admin) && (user.role !== "MASTER" || id !== "staff"))
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
            <span>TOP-СЕРВИС</span>
            <span className="crumb-divider">/</span>
            <strong>{active}</strong>
          </div>
          <span className="today">{today()}</span>
        </header>
        <main id="main" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <h1>{orderId ? "Карточка заказа" : active}</h1>
            </div>
          </div>
          {orderId ? <OrderEditor key={orderId} id={orderId} user={user} />
            : section === "orders" ? <Orders key={orderFilter} user={user} query={orderFilter} />
            : section === "directory" ? <Directory user={user} />
            : section === "staff" && user.role !== "MASTER" ? <Masters />
            : section === "catalog" ? <Catalog user={user} />
            : section === "settings" && admin ? <AdminSettings />
            : <Overview user={user} />}
        </main>
      </div>
    </div>
  );
}
function Login({initialError}:{initialError:string}) {
  return <div className="login"><div className="login-story"><div className="brand"><span className="brand-icon"><Wrench/></span>TOP-СЕРВИС</div><div><span className="eyebrow">ПОРЯДОК В КАЖДОЙ ДЕТАЛИ</span><h1>Больше внимания<br/>автомобилям.<br/>Меньше — бумаге.</h1><p>Рабочая CRM с сохранением клиентов, осмотров, заказов и PDF в облачной базе.</p></div><small>Закрытый доступ к данным сервиса</small></div><div className="login-form"><section><span className="login-symbol"><Wrench size={26}/></span><h2>Вход в сервис</h2><p>Используйте свою учётную запись ChatGPT.</p>{initialError&&<Notice>{initialError}</Notice>}<a className="primary full" href="/signin-with-chatgpt?return_to=%2F" target="_top">Войти через ChatGPT <ArrowUpRight size={18}/></a><small>Доступ предоставляется владельцем сайта и администратором CRM.</small></section></div></div>;
}
