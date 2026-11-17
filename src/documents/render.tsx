import path from "node:path";
import React from "react";
import {
  Document,
  Font,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";
import { formatMoney, formatQuantity, lineTotal } from "../lib/money";
import type { Condition, OrderStatus, PartVariant } from "../lib/types";
import type { DocumentSnapshot } from "./types";

Font.register({
  family: "DejaVu",
  fonts: [
    { src: path.join(process.cwd(), "public/fonts/DejaVuSans.ttf") },
    {
      src: path.join(process.cwd(), "public/fonts/DejaVuSans-Bold.ttf"),
      fontWeight: 700,
    },
  ],
});
// Arbitrary article codes and VIN-like strings must also fit into a cell.
Font.registerHyphenationCallback((word) =>
  word.length > 24 ? (word.match(/.{1,18}/gu) ?? [word]) : [word],
);

const states: Record<Condition, string> = {
  UNCHECKED: "Не проверялось",
  CHECKED: "Осмотрено",
  REPAIR: "Требует ремонта",
  RECOMMENDED: "Рекомендовано",
  DONE: "Выполнено",
};
const statuses: Record<OrderStatus, string> = {
  NEW: "Новый",
  DIAGNOSTICS: "Диагностика",
  APPROVAL: "Согласование",
  IN_PROGRESS: "В работе",
  READY: "Готов",
  DELIVERED: "Выдан",
  CANCELLED: "Отменён",
};
const variants: Record<PartVariant, string> = {
  NONE: "Без запчасти",
  ORIGINAL: "Оригинал",
  ANALOG: "Аналог",
  CUSTOM: "Индивидуальная цена",
};

const s = StyleSheet.create({
  page: {
    fontFamily: "DejaVu",
    fontSize: 8,
    lineHeight: 1.4,
    padding: 30,
    paddingBottom: 48,
    color: "#17212b",
  },
  running: {
    fontSize: 8,
    fontWeight: 700,
    paddingBottom: 8,
    marginBottom: 8,
    borderBottomWidth: 0.6,
    borderBottomColor: "#a9b5bf",
  },
  metadata: { marginBottom: 12 },
  service: { fontSize: 12, fontWeight: 700, marginBottom: 3 },
  title: { fontSize: 13, fontWeight: 700, marginTop: 10, marginBottom: 5 },
  detail: { marginBottom: 3 },
  muted: { color: "#465563", fontSize: 7 },
  section: {
    padding: 5,
    fontSize: 9,
    fontWeight: 700,
    backgroundColor: "#e9eef2",
    borderBottomWidth: 0.4,
    borderBottomColor: "#a9b5bf",
  },
  row: {
    flexDirection: "row",
    borderBottomWidth: 0.4,
    borderBottomColor: "#c5cdd3",
    borderLeftWidth: 0.4,
    borderLeftColor: "#c5cdd3",
  },
  tableHead: {
    backgroundColor: "#e1e8ed",
    fontWeight: 700,
    fontSize: 7,
    borderTopWidth: 0.5,
    borderTopColor: "#a9b5bf",
  },
  cell: {
    paddingVertical: 5,
    paddingHorizontal: 4,
    borderRightWidth: 0.4,
    borderRightColor: "#c5cdd3",
    fontSize: 7,
  },
  inspectionCell: { paddingVertical: 2, lineHeight: 1.25 },
  inspectionSection: { paddingVertical: 3, fontSize: 8 },
  right: { textAlign: "right" },
  center: { textAlign: "center" },
  note: { fontSize: 7, color: "#465563", marginTop: 3 },
  paragraph: { marginTop: 10 },
  label: { fontWeight: 700, marginBottom: 3 },
  totals: { marginTop: 12, marginLeft: "auto", width: 260 },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3,
    borderBottomWidth: 0.4,
    borderBottomColor: "#d3dbe1",
  },
  totalFinal: { fontWeight: 700, fontSize: 10 },
  signatures: { marginTop: 22, fontSize: 8 },
  signature: { marginBottom: 15 },
  footer: {
    position: "absolute",
    top: 810,
    left: 30,
    width: 535,
    fontSize: 7,
    color: "#465563",
  },
});

const shown = (value: string | number | null | undefined) =>
  value === null || value === undefined || value === "" ? "—" : String(value);
// Yoga cannot paginate a flex row taller than a whole page reliably. Keep each
// physical row bounded and move it intact, retaining every text segment in
// explicitly marked continuation rows. Prices appear only on the first row.
function textSegments(text: string, limit: number): string[] {
  const segments: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const prefix = remaining.slice(0, limit + 1);
    const whitespace = [...prefix.matchAll(/\s/gu)].at(-1)?.index ?? limit;
    const end = whitespace < limit / 2 ? limit : whitespace;
    segments.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) segments.push(remaining);
  return segments.length ? segments : ["—"];
}
function date(value: string, timezone: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: timezone,
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function Metadata({ data }: { data: DocumentSnapshot }) {
  return (
    <View style={s.metadata}>
      <Text style={s.service}>{data.settings.name}</Text>
      <Text>{shown(data.settings.address)}</Text>
      <Text style={s.detail}>
        Тел.: {shown(data.settings.phone)} · ИНН: {shown(data.settings.taxId)}
      </Text>
      <Text style={s.title}>
        {data.kind === "INSPECTION"
          ? "АКТ ОСМОТРА ТРАНСПОРТНОГО СРЕДСТВА"
          : "ЗАКАЗ-НАРЯД"}
      </Text>
      <Text style={s.detail}>
        № {data.number} от {date(data.createdAt, data.settings.timezone)}
      </Text>
      <Text style={s.detail}>
        Клиент: {data.customer.name} · Телефон: {shown(data.customer.phone)}
      </Text>
      <Text style={s.detail}>
        Автомобиль: {data.vehicle.make} {data.vehicle.model} · Год:{" "}
        {shown(data.vehicle.year)}
      </Text>
      <Text style={s.detail}>
        Госномер: {shown(data.vehicle.plate)} · VIN: {shown(data.vehicle.vin)} ·
        Пробег: {data.order.mileage.toLocaleString("ru-RU")} км
      </Text>
      <Text style={s.detail}>
        Заказ: {data.order.number} · Открыт:{" "}
        {date(data.order.openedAt, data.settings.timezone)} · Статус:{" "}
        {statuses[data.order.status]}
      </Text>
      <Text style={s.detail}>Мастер: {shown(data.masterName)}</Text>
      <Text style={s.detail}>
        Жалоба клиента: {shown(data.order.complaint)}
      </Text>
    </View>
  );
}

function Cell({
  width,
  children,
  align = "left",
  compact = false,
}: {
  width: string;
  children: React.ReactNode;
  align?: "left" | "right" | "center";
  compact?: boolean;
}) {
  return (
    <View
      style={[
        s.cell,
        compact ? s.inspectionCell : {},
        { width },
        align === "right" ? s.right : align === "center" ? s.center : {},
      ]}
    >
      {typeof children === "string" ? <Text>{children}</Text> : children}
    </View>
  );
}

function InspectionCell(props: Parameters<typeof Cell>[0]) {
  return <Cell {...props} compact />;
}

function Inspection({ data }: { data: DocumentSnapshot }) {
  // A normal-flow fixed child repeats only while its table continues. Unlike an
  // absolutely positioned header, it reserves its own height on every page.
  const categories = [
    ...new Set(data.inspectionItems.map((item) => item.category)),
  ];
  let rowNumber = 0;
  return (
    <View>
      <View style={[s.row, s.tableHead]} fixed wrap={false}>
        <InspectionCell width="4%">№</InspectionCell>
        <InspectionCell width="42%">
          Предмет осмотра / состояние / примечание
        </InspectionCell>
        <InspectionCell width="7%" align="center">
          L / R
        </InspectionCell>
        <InspectionCell width="7%" align="right">
          Кол-во
        </InspectionCell>
        <InspectionCell width="14%" align="right">
          Сумма работ
        </InspectionCell>
        <InspectionCell width="13%" align="right">
          Оригинал / ед.
        </InspectionCell>
        <InspectionCell width="13%" align="right">
          Аналог / ед.
        </InspectionCell>
      </View>
      {categories.map((category) => (
        <React.Fragment key={category}>
          <Text style={[s.section, s.inspectionSection]} minPresenceAhead={26}>
            {category}
          </Text>
          {data.inspectionItems
            .filter((item) => item.category === category)
            .map((item) => {
              const number = ++rowNumber;
              const description = `${item.name} — ${states[item.condition]}${item.selectedPart !== "NONE" ? `\nВыбор: ${variants[item.selectedPart]}${item.selectedPart === "CUSTOM" ? ` (${formatMoney(item.customPriceCents)} / ед.)` : ""}` : ""}${item.note ? `\n${item.note}` : ""}`;
              return textSegments(description, 450).map((segment, index) => (
                <View style={s.row} key={`${item.id}-${index}`} wrap={false}>
                  <InspectionCell width="4%">
                    {index === 0 ? String(number) : "↳"}
                  </InspectionCell>
                  <InspectionCell width="42%">
                    <Text>
                      {index ? "(продолжение)\n" : ""}
                      {segment}
                    </Text>
                  </InspectionCell>
                  <InspectionCell width="7%" align="center">
                    {index
                      ? ""
                      : `${item.left ? "L" : "—"} / ${item.right ? "R" : "—"}`}
                  </InspectionCell>
                  <InspectionCell width="7%" align="right">
                    {index ? "" : formatQuantity(item.quantityMilli)}
                  </InspectionCell>
                  <InspectionCell width="14%" align="right">
                    {index
                      ? ""
                      : formatMoney(
                          lineTotal(item.quantityMilli, item.laborPriceCents),
                        )}
                  </InspectionCell>
                  <InspectionCell width="13%" align="right">
                    {index ? "" : formatMoney(item.originalPriceCents)}
                  </InspectionCell>
                  <InspectionCell width="13%" align="right">
                    {index ? "" : formatMoney(item.analogPriceCents)}
                  </InspectionCell>
                </View>
              ));
            })}
        </React.Fragment>
      ))}
      {!data.inspectionItems.length ? (
        <Text style={s.detail}>Пункты осмотра не добавлены.</Text>
      ) : null}
    </View>
  );
}

function WorkOrder({ data }: { data: DocumentSnapshot }) {
  return (
    <View>
      <View style={[s.row, s.tableHead]} fixed wrap={false}>
        <Cell width="5%">№</Cell>
        <Cell width="47%">Наименование / вариант / артикул</Cell>
        <Cell width="12%" align="right">
          Кол-во
        </Cell>
        <Cell width="18%" align="right">
          Цена / ед.
        </Cell>
        <Cell width="18%" align="right">
          Сумма
        </Cell>
      </View>
      {(["LABOR", "PART"] as const).map((kind) => (
        <React.Fragment key={kind}>
          <Text style={s.section} minPresenceAhead={30}>
            {kind === "LABOR" ? "Работы и услуги" : "Запчасти и материалы"}
          </Text>
          {data.lines
            .filter((line) => line.kind === kind)
            .map((line, index) =>
              textSegments(
                `${line.name}${kind === "PART" ? `\n${variants[line.variant]} · Артикул: ${shown(line.article)}` : ""}`,
                750,
              ).map((segment, continuation) => (
                <View
                  key={`${kind}-${index}-${continuation}`}
                  style={s.row}
                  wrap={false}
                >
                  <Cell width="5%">
                    {continuation ? "↳" : String(index + 1)}
                  </Cell>
                  <Cell width="47%">
                    <Text>
                      {continuation ? "(продолжение)\n" : ""}
                      {segment}
                    </Text>
                  </Cell>
                  <Cell width="12%" align="right">
                    {continuation ? "" : formatQuantity(line.quantityMilli)}
                  </Cell>
                  <Cell width="18%" align="right">
                    {continuation ? "" : formatMoney(line.unitPriceCents)}
                  </Cell>
                  <Cell width="18%" align="right">
                    {continuation
                      ? ""
                      : formatMoney(
                          lineTotal(line.quantityMilli, line.unitPriceCents),
                        )}
                  </Cell>
                </View>
              )),
            )}
          {!data.lines.some((line) => line.kind === kind) ? (
            <Text style={s.detail}>Позиции не добавлены.</Text>
          ) : null}
        </React.Fragment>
      ))}
    </View>
  );
}

function Summary({ data }: { data: DocumentSnapshot }) {
  const totals = [
    ["Работы", data.totals.laborCents],
    ["Запчасти", data.totals.partsCents],
    ["До скидки", data.totals.subtotalCents],
    ["Скидка", data.totals.discountCents],
    ["Итого", data.totals.totalCents],
    ["Оплачено", data.totals.paidCents],
    ["Остаток", data.totals.balanceCents],
  ] as const;
  return (
    <>
      {data.kind === "INSPECTION" ? (
        <View style={s.paragraph}>
          <Text style={s.muted}>
            L — левая сторона, R — правая сторона. «—» — сторона не отмечена.
          </Text>
          <Text style={s.muted}>
            Состояния: не проверялось; осмотрено; требует ремонта;
            рекомендовано; выполнено.
          </Text>
          <Text style={s.muted}>
            Оригинал и аналог — альтернативные цены за единицу. Итоги ниже
            рассчитаны по выбранным строкам заказа.
          </Text>
          <Text style={s.muted}>
            Строка «Выбор» отсутствует, если запчасть не выбрана.
          </Text>
        </View>
      ) : null}
      <View style={s.paragraph}>
        <Text style={s.label} minPresenceAhead={20}>
          Рекомендации
        </Text>
        <Text>{shown(data.order.recommendations)}</Text>
      </View>
      <View style={s.paragraph}>
        <Text style={s.label} minPresenceAhead={20}>
          Замечания
        </Text>
        <Text>{shown(data.order.comment)}</Text>
      </View>
      <View style={s.totals} wrap={false}>
        {totals.map(([label, cents]) => (
          <View
            style={[s.totalRow, label === "Итого" ? s.totalFinal : {}]}
            key={label}
          >
            <Text>{label}</Text>
            <Text>{formatMoney(cents)}</Text>
          </View>
        ))}
      </View>
      <View style={s.signatures}>
        <Text style={s.signature}>
          Мастер: _______________________ / {shown(data.masterName)}
        </Text>
        <Text>Клиент: _______________________ / {data.customer.name}</Text>
      </View>
    </>
  );
}

/** Server-side rendering: no browser, network fonts, or mutable database reads. */
export async function renderDocument(
  snapshot: DocumentSnapshot,
): Promise<Buffer> {
  return renderToBuffer(
    <Document
      title={`${snapshot.kind === "INSPECTION" ? "Акт осмотра" : "Заказ-наряд"} ${snapshot.number}`}
      author={snapshot.settings.name}
      language="ru-RU"
      creationDate={new Date(snapshot.createdAt)}
    >
      <Page size="A4" style={s.page}>
        <Text fixed style={s.running}>
          {snapshot.kind === "INSPECTION" ? "Акт осмотра" : "Заказ-наряд"} · №{" "}
          {snapshot.number}
        </Text>
        <Metadata data={snapshot} />
        {snapshot.kind === "INSPECTION" ? (
          <Inspection data={snapshot} />
        ) : (
          <WorkOrder data={snapshot} />
        )}
        <Summary data={snapshot} />
        <Text fixed style={[s.footer, { width: 340 }]}>
          Шаблон {snapshot.templateVersion} · {snapshot.settings.timezone}
        </Text>
        <Text
          fixed
          style={[s.footer, { left: 370, width: 195, textAlign: "right" }]}
          render={({ pageNumber, totalPages }) =>
            `Страница ${pageNumber} из ${totalPages}`
          }
        />
      </Page>
    </Document>,
  );
}
