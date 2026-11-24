import { useEffect, useState, type FormEvent } from "react";
import type { Customer, OrderDetail, PageResult, Staff, Vehicle } from "@/lib/types";
import { api } from "@/lib/client";
import { useDraftGuard, useRetryableWrite } from "@/lib/workflow";
import { Field, Modal, Notice } from "./ui";

export function NewOrder({ close, onCreated }: { close: () => void; onCreated: (order: OrderDetail) => void }) {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [phone, setPhone] = useState("");
  const [make, setMake] = useState("");
  const [lookup, setLookup] = useState("");
  const [error, setError] = useState("");
  const [lookupError, setLookupError] = useState("");
  const [staffError, setStaffError] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const write = useRetryableWrite<OrderDetail>();
  useDraftGuard(dirty || busy || write.uncertain, setError);

  useEffect(() => {
    api<{ items: Staff[] }>("/staff").then((r) => setStaff(r.items.filter((s) => s.role === "MASTER" && s.active)))
      .catch((err) => setStaffError(err.message));
  }, []);
  useEffect(() => {
    const phoneDigits = phone.replace(/\D/g, "");
    const phoneQuery = phoneDigits.length >= 4 ? phone : "";
    if (!phoneQuery && !lookup.trim()) return;
    let live = true;
    const timer = setTimeout(() => {
      setLookupBusy(true);
      setLookupError("");
      const carsQuery = lookup.trim() || phoneQuery;
      Promise.all([
        phoneQuery ? api<PageResult<Customer>>(`/customers?q=${encodeURIComponent(phoneQuery)}&pageSize=10`) : null,
        api<PageResult<Vehicle>>(`/vehicles?q=${encodeURIComponent(carsQuery)}&pageSize=10`),
      ]).then(([people, cars]) => {
        if (!live) return;
        setCustomers((people?.items ?? []).filter((person) => !person.archivedAt));
        setVehicles(cars.items.filter((car) => !car.archivedAt && car.customer && !car.customer.archivedAt));
      }).catch((err) => {
        if (live) { setCustomers([]); setVehicles([]); setLookupError(err.message); }
      }).finally(() => { if (live) setLookupBusy(false); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [phone, lookup]);

  const locked = busy || write.uncertain;
  function cancel() {
    if (locked) {
      setError("Дождитесь ответа или повторите отправку, чтобы подтвердить создание заказа.");
      return;
    }
    if (!dirty || confirm("Закрыть форму и сбросить введённые данные?")) close();
  }
  function pickCustomer(chosen: Customer | null) {
    setCustomer(chosen);
    setVehicle(null);
    if (chosen) setPhone(chosen.phone);
    setDirty(true);
  }
  function pickVehicle(chosen: Vehicle) {
    setVehicle(chosen);
    setCustomer(chosen.customer ?? null);
    setPhone(chosen.customer?.phone ?? phone);
    setDirty(true);
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const form = new FormData(e.currentTarget);
    const str = (key: string) => String(form.get(key) ?? "").trim();
    setBusy(true);
    setError("");
    try {
      const current = await write.send("/intake", {
        phone, make: vehicle?.make ?? make, complaint: str("complaint"), name: str("name"),
        model: str("model"), vin: str("vin") || null, plate: str("plate") || null,
        ...(str("mileage") ? { mileage: Number(str("mileage")) } : {}),
        masterId: str("masterId") || null,
        customerId: customer?.id, vehicleId: vehicle?.id,
      });
      onCreated(current);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const showMatches = phone.replace(/\D/g, "").length >= 4 || !!lookup.trim();
  return <Modal title="Новый заказ" close={cancel}>
    <form onSubmit={submit} onChange={() => setDirty(true)}>
      {error && <Notice>{error}{write.uncertain && " Повторите отправку, чтобы узнать результат."}</Notice>}
      <fieldset className="form-fields" disabled={locked}>
        <div className="form-grid">
          <Field label="Марка" hint="Обязательное поле">
            <input required maxLength={100} value={vehicle?.make ?? make} readOnly={!!vehicle} onChange={(e) => setMake(e.target.value)} />
          </Field>
          <Field label="Телефон" hint="Обязательное поле">
            <input required type="tel" autoComplete="tel" maxLength={50} value={phone} readOnly={!!customer} onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </div>
        <Field label="Жалоба / причина обращения" hint="Обязательное поле">
          <textarea name="complaint" required rows={3} maxLength={5000} />
        </Field>
        <Field label="Найти существующий автомобиль">
          <input value={lookup} maxLength={200} placeholder="VIN, госномер или марка" onChange={(e) => setLookup(e.target.value)} />
        </Field>
        {customer && <div className="selection-row">
          <span>Клиент: {customer.name || customer.phone}</span>
          <button type="button" className="secondary" onClick={() => pickCustomer(null)}>Сбросить выбор</button>
        </div>}
        {vehicle && <div className="selection-row">
          <span>Автомобиль: {vehicle.make} {vehicle.model} · {vehicle.plate || vehicle.vin || "без номера"}</span>
          <button type="button" className="secondary" onClick={() => setVehicle(null)}>Ввести другой автомобиль</button>
        </div>}
        {showMatches && <div className="intake-matches">
          {lookupBusy && <p role="status">Ищем совпадения…</p>}
          {lookupError && <Notice>{lookupError} Измените запрос, чтобы повторить поиск.</Notice>}
          {!customer && customers.length > 0 && <Field label="Найденные клиенты">
            <select value="" onChange={(e) => pickCustomer(customers.find((c) => c.id === e.target.value) ?? null)}>
              <option value="">Создать нового клиента</option>
              {customers.map((c) => <option value={c.id} key={c.id}>{c.name || "Без имени"} · {c.phone}</option>)}
            </select>
          </Field>}
          {!vehicle && vehicles.length > 0 && <Field label="Найденные автомобили">
            <select value="" onChange={(e) => { const chosen = vehicles.find((v) => v.id === e.target.value); if (chosen) pickVehicle(chosen); }}>
              <option value="">Создать новый автомобиль</option>
              {vehicles.map((v) => <option key={v.id} value={v.id}>{v.make} {v.model} · {v.plate || v.vin || "без номера"} · {v.customer?.name || v.customer?.phone}</option>)}
            </select>
          </Field>}
          {!lookupBusy && !lookupError && !customers.length && !vehicles.length && <p className="muted">Совпадений пока нет.</p>}
        </div>}
        <details>
          <summary>Дополнительные сведения</summary>
          <div className="form-grid">
            <Field label="Имя клиента"><input name="name" maxLength={200} key={customer?.id ?? "new"} defaultValue={customer?.name} readOnly={!!customer} /></Field>
            <Field label="Модель"><input name="model" maxLength={100} key={vehicle?.id ?? "new"} defaultValue={vehicle?.model} readOnly={!!vehicle} /></Field>
            <Field label="VIN"><input name="vin" maxLength={17} pattern="[A-HJ-NPR-Za-hj-npr-z0-9]{5,17}" key={vehicle?.id ?? "new"} defaultValue={vehicle?.vin ?? ""} readOnly={!!vehicle} /></Field>
            <Field label="Госномер"><input name="plate" maxLength={30} key={vehicle?.id ?? "new"} defaultValue={vehicle?.plate ?? ""} readOnly={!!vehicle} /></Field>
            <Field label="Пробег, км"><input name="mileage" type="number" min={vehicle?.mileage ?? 0} max={10000000} placeholder={vehicle?.mileage.toString() ?? ""} /></Field>
            <Field label="Мастер"><select name="masterId"><option value="">Назначить позже</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          </div>
          {staffError && <Notice>{staffError}</Notice>}
        </details>
      </fieldset>
      <div className="form-footer">
        <button type="button" className="secondary" disabled={locked} onClick={cancel}>Отмена</button>
        <button className="primary" disabled={busy}>{busy ? "Создаём…" : write.uncertain ? "Повторить отправку" : "Создать заказ"}</button>
      </div>
    </form>
  </Modal>;
}
