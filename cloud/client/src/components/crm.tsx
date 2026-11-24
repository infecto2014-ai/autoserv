"use client";
import { useCallback, useEffect, useState } from "react";
import { BookOpen, CalendarDays, Car, ClipboardList, LayoutDashboard, LogOut, PanelLeftClose, PanelLeftOpen, Settings as SettingsIcon, UserRound, Wrench, Menu, X } from "lucide-react";
import type { Actor } from "@/lib/types";
import { api, today, roles } from "@/lib/client";
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
    [mobile, setMobile] = useState(false),
    [collapsed, setCollapsed] = useState(false);
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
        setUser(v.user);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    queueMicrotask(sync);
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [sync]);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 761px)");
    const close = () => { if (desktop.matches) setMobile(false); };
    desktop.addEventListener("change", close);
    return () => desktop.removeEventListener("change", close);
  }, []);
  useEffect(() => {
    if (!mobile) return;
    const previous = document.activeElement as HTMLElement | null;
    const sidebar = document.getElementById("sidebar");
    const focusables = () => Array.from(sidebar?.querySelectorAll<HTMLElement>("a[href],button:not(:disabled)") ?? []).filter(e => e.getClientRects().length > 0);
    focusables()[0]?.focus();
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobile(false);
      if (e.key === "Tab") {
        const items = focusables(), first = items[0], last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("keydown", close); previous?.focus(); };
  }, [mobile]);
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
    <div className={`app${collapsed ? " sidebar-collapsed" : ""}`}>
      <a className="skip" hidden={mobile} href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>
        Перейти к содержимому
      </a>
      {mobile && <button className="mobile-backdrop" tabIndex={-1} aria-label="Закрыть меню" onClick={() => setMobile(false)} />}
      <aside id="sidebar" className={mobile ? "sidebar open" : "sidebar"} role={mobile ? "dialog" : undefined} aria-modal={mobile || undefined} aria-label="Основная навигация">
        <a href="#overview" className="brand" aria-label="ТОП-СЕРВИС — Обзор" onClick={() => setMobile(false)}>
          <Brand />
        </a>
        <button className="icon mobile-menu sidebar-close" aria-label="Закрыть меню" onClick={() => setMobile(false)}><X size={20} /></button>
        <nav>
          {nav
            .filter(([id]) => id !== "catalog" && (id !== "settings" || admin) && (user.role !== "MASTER" || id !== "staff"))
            .map(([id, label, Icon]) => (
              <a
                key={id}
                href={`#${id}`}
                className={section === id ? "active" : ""}
                aria-current={section === id ? "page" : undefined}
                title={collapsed ? label : undefined}
                aria-label={label}
                onClick={() => setMobile(false)}
              >
                <Icon size={19} aria-hidden="true" />
                <span className="nav-label">{label}</span>
                {section === id && <span className="nav-dot" />}
              </a>
            ))}
        </nav>
        <div className="sidebar-art" aria-hidden="true"><Car /></div>
        <div className="sidebar-bottom">
          <div className="profile">
            <div className="avatar">{user.name.slice(0, 1)}</div>
            <div className="profile-copy">
              <strong>{user.name}</strong>
              <small>{roles[user.role]}</small>
            </div>
            <a className="icon" aria-label="Выйти" href="/signout-with-chatgpt?return_to=%2F" target="_top"><LogOut size={18}/></a>
          </div>
        </div>
      </aside>
      <div className="workspace" inert={mobile}>
        <header className="topbar">
          <div className="breadcrumb">
            <button className="icon sidebar-toggle" aria-label={collapsed ? "Развернуть меню" : "Свернуть меню"} aria-expanded={!collapsed} aria-controls="sidebar" onClick={() => setCollapsed(!collapsed)}>
              {collapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
            </button>
            <button
              className="icon mobile-menu"
              aria-label="Открыть меню"
              aria-expanded={mobile}
              aria-controls="sidebar"
              onClick={() => setMobile(!mobile)}
            >
              <Menu size={20} />
            </button>
            <span>TOP-СЕРВИС</span>
            <span className="crumb-divider">/</span>
            <strong>{active}</strong>
          </div>
          <span className="today"><CalendarDays size={18} aria-hidden="true" />{today()}</span>
        </header>
        <main id="main" tabIndex={-1}>
          {(orderId || section !== "overview") && <div className="page-heading">
            <div>
              <h1>{orderId ? "Карточка заказа" : active}</h1>
            </div>
          </div>}
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
function Brand() {
  return <><svg className="brand-car" viewBox="0 0 180 46" fill="none" aria-hidden="true"><path d="M9 32 22 21 54 16 76 5c23-5 44-2 62 12l25 5 10 11" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/><path d="m28 20 39 2 54-2M76 7 64 17l64 1M16 34h20m23 0h65m24 0h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><circle cx="47" cy="33" r="9" stroke="currentColor" strokeWidth="2"/><circle cx="136" cy="33" r="9" stroke="currentColor" strokeWidth="2"/></svg><span className="brand-copy"><strong>ТОП-СЕРВИС</strong><small>АВТОСЕРВИС · CRM</small></span></>;
}
function Login({initialError}:{initialError:string}) {
  return <div className="login"><div className="login-story"><div className="brand"><Brand /></div><div><span className="eyebrow">ПОРЯДОК В КАЖДОЙ ДЕТАЛИ</span><h1>Больше внимания<br/>автомобилям.<br/>Меньше — бумаге.</h1><p>Клиенты, автомобили, ремонт и документы — в одном рабочем пространстве.</p></div><small>Закрытый доступ к данным сервиса</small></div><div className="login-form"><section><span className="login-symbol"><Wrench size={26}/></span><h2>Вход в сервис</h2><p>Используйте свою учётную запись ChatGPT.</p>{initialError&&<Notice>{initialError}</Notice>}<a className="primary full" href="/signin-with-chatgpt?return_to=%2F" target="_top">Войти через ChatGPT</a><small>Доступ предоставляется владельцем сайта и администратором CRM.</small></section></div></div>;
}
