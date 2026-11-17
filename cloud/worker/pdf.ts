import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import { formatMoney, formatQuantity, lineTotal } from "../shared/money";
import type { Condition, OrderStatus, PartVariant } from "../shared/types";
import type { DocumentSnapshot } from "./document-types";

const states: Record<Condition, string> = {
  UNCHECKED: "Не проверялось", CHECKED: "Осмотрено", REPAIR: "Требует ремонта",
  RECOMMENDED: "Рекомендовано", DONE: "Выполнено",
};
const statuses: Record<OrderStatus, string> = {
  NEW: "Новый", DIAGNOSTICS: "Диагностика", APPROVAL: "Согласование",
  IN_PROGRESS: "В работе", READY: "Готов", DELIVERED: "Выдан", CANCELLED: "Отменён",
};
const variants: Record<PartVariant, string> = {
  NONE: "Без запчасти", ORIGINAL: "Оригинал", ANALOG: "Аналог", CUSTOM: "Индивидуальная цена",
};
const WIDTH = 595.28, HEIGHT = 841.89, LEFT = 30, BODY_END = 794;
const CONTENT_WIDTH = WIDTH - LEFT * 2;
const ink = rgb(0.09, 0.13, 0.17), border = rgb(0.76, 0.80, 0.83);
const shown = (value: string | number | null | undefined) =>
  value === null || value === undefined || value === "" ? "—" : String(value);
const clean = (text: string) => text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ");

/** Wrap measured glyphs, including unbroken VINs/articles, without dropping text. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const result: string[] = [];
  for (const paragraph of clean(text).split("\n")) {
    let current = "";
    for (const token of paragraph.match(/\S+/gu) ?? []) {
      const candidate = current ? `${current} ${token}` : token;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        current = candidate;
        continue;
      }
      if (current) { result.push(current); current = ""; }
      let characters = Array.from(token);
      while (characters.length && font.widthOfTextAtSize(characters.join(""), size) > width) {
        let low = 1, high = characters.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (font.widthOfTextAtSize(characters.slice(0, middle).join(""), size) <= width) low = middle;
          else high = middle - 1;
        }
        result.push(characters.slice(0, low).join(""));
        characters = characters.slice(low);
      }
      current = characters.join("");
    }
    if (current || !paragraph.trim()) result.push(current);
  }
  return result.length ? result : [""];
}
function date(value: string, timezone: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: timezone, dateStyle: "short", timeStyle: "short",
  }).format(new Date(value));
}
interface Column { width: number; title: string; align?: "right" | "center" }

/** Pure JavaScript/Web API renderer; font bytes are bundled locally by its caller. */
export async function renderDocument(
  data: DocumentSnapshot,
  fonts: { regular: Uint8Array; bold: Uint8Array },
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  // Subsets keep both the resulting document and the Worker memory footprint small.
  const prefix = Array.from(crypto.getRandomValues(new Uint8Array(6)), (value) => String.fromCharCode(65 + value % 26)).join("");
  const regular = await pdf.embedFont(fonts.regular, { subset: true, customName: `${prefix}+DejaVuSans` });
  const bold = await pdf.embedFont(fonts.bold, { subset: true, customName: `${prefix}+DejaVuSans-Bold` });
  const title = data.kind === "INSPECTION" ? "Акт осмотра" : "Заказ-наряд";
  pdf.setTitle(`${title} ${data.number}`);
  pdf.setAuthor(data.settings.name);
  pdf.setLanguage("ru-RU");
  pdf.setCreationDate(new Date(data.createdAt));
  pdf.setModificationDate(new Date(data.createdAt));

  let page: PDFPage, top = 50;
  let activeColumns: Column[] | null = null;
  const draw = (text: string, x: number, y: number, size = 8, font = regular) => {
    if (text) page.drawText(text, { x, y: HEIGHT - y - size, size, font, color: ink });
  };
  const horizontal = (y: number, x = LEFT, width = CONTENT_WIDTH) =>
    page.drawLine({ start: { x, y: HEIGHT - y }, end: { x: x + width, y: HEIGHT - y }, thickness: 0.4, color: border });
  const newPage = () => {
    page = pdf.addPage([WIDTH, HEIGHT]);
    draw(title, LEFT, 30, 8, bold);
    horizontal(44);
    top = 51;
    if (activeColumns) tableHeader(activeColumns);
  };
  const ensure = (height: number) => { if (top + height > BODY_END) newPage(); };
  const paragraph = (text: string, options: { size?: number; bold?: boolean; gap?: number; x?: number; width?: number } = {}) => {
    const size = options.size ?? 8, font = options.bold ? bold : regular;
    const x = options.x ?? LEFT, width = options.width ?? CONTENT_WIDTH;
    for (const line of wrap(text, font, size, width)) {
      ensure(size * 1.35);
      draw(line, x, top, size, font);
      top += size * 1.35;
    }
    top += options.gap ?? 3;
  };
  function physicalRow(columns: Column[], cells: string[][], head = false) {
    const size = 7, leading = head ? 9 : 8.6, padding = head ? 4 : 2;
    const count = Math.max(1, ...cells.map((cell) => cell.length));
    const height = count * leading + padding * 2;
    if (head) page.drawRectangle({ x: LEFT, y: HEIGHT - top - height, width: CONTENT_WIDTH, height, color: rgb(0.88, 0.91, 0.93) });
    let x = LEFT;
    columns.forEach((column, index) => {
      const font = head ? bold : regular;
      for (const [lineIndex, text] of cells[index].entries()) {
        const textWidth = font.widthOfTextAtSize(text, size);
        const textX = column.align === "right" ? x + column.width - 4 - textWidth
          : column.align === "center" ? x + (column.width - textWidth) / 2 : x + 4;
        draw(text, textX, top + padding + lineIndex * leading, size, font);
      }
      page.drawLine({ start: { x, y: HEIGHT - top }, end: { x, y: HEIGHT - top - height }, thickness: 0.4, color: border });
      x += column.width;
    });
    page.drawLine({ start: { x, y: HEIGHT - top }, end: { x, y: HEIGHT - top - height }, thickness: 0.4, color: border });
    horizontal(top + height);
    top += height;
  }
  function tableHeader(columns: Column[]) {
    const cells = columns.map((column) => wrap(column.title, bold, 7, column.width - 8));
    horizontal(top);
    physicalRow(columns, cells, true);
  }
  const startTable = (columns: Column[]) => {
    // Reserve header and one body line before activating automatic repetition.
    ensure(50);
    activeColumns = columns;
    tableHeader(columns);
  };
  const row = (cells: string[]) => {
    const columns = activeColumns!;
    const lines = cells.map((cell, index) => wrap(cell, regular, 7, columns[index].width - 8));
    const totalLines = Math.max(...lines.map((cell) => cell.length));
    let offset = 0;
    while (offset < totalLines) {
      ensure(12.6);
      const capacity = Math.max(1, Math.floor((BODY_END - top - 4) / 8.6));
      const take = Math.min(capacity, totalLines - offset);
      const segment = lines.map((cell) => cell.slice(offset, offset + take));
      if (offset && !segment[0].length) segment[0] = ["↳"];
      physicalRow(columns, segment);
      offset += take;
      if (offset < totalLines) newPage();
    }
  };
  const section = (text: string) => {
    ensure(32);
    for (const line of wrap(text, bold, 8, CONTENT_WIDTH - 8)) {
      ensure(15);
      page.drawRectangle({ x: LEFT, y: HEIGHT - top - 15, width: CONTENT_WIDTH, height: 15, color: rgb(0.92, 0.94, 0.95) });
      draw(line, LEFT + 4, top + 2, 8, bold);
      top += 15;
    }
  };

  newPage();
  paragraph(data.settings.name, { size: 12, bold: true });
  paragraph(shown(data.settings.address));
  paragraph(`Тел.: ${shown(data.settings.phone)} · ИНН: ${shown(data.settings.taxId)}`);
  top += 5;
  paragraph(data.kind === "INSPECTION" ? "АКТ ОСМОТРА ТРАНСПОРТНОГО СРЕДСТВА" : "ЗАКАЗ-НАРЯД", { size: 12, bold: true });
  paragraph(`№ ${data.number} от ${date(data.createdAt, data.settings.timezone)}`);
  paragraph(`Клиент: ${data.customer.name} · Телефон: ${shown(data.customer.phone)}`);
  paragraph(`Автомобиль: ${data.vehicle.make} ${data.vehicle.model} · Год: ${shown(data.vehicle.year)}`);
  paragraph(`Госномер: ${shown(data.vehicle.plate)} · VIN: ${shown(data.vehicle.vin)} · Пробег: ${data.order.mileage.toLocaleString("ru-RU")} км`);
  paragraph(`Заказ: ${data.order.number} · Открыт: ${date(data.order.openedAt, data.settings.timezone)} · Статус: ${statuses[data.order.status]}`);
  paragraph(`Мастер: ${shown(data.masterName)}`);
  paragraph(`Жалоба клиента: ${shown(data.order.complaint)}`, { gap: 9 });

  if (data.kind === "INSPECTION") {
    const fractions = [0.04, 0.42, 0.07, 0.07, 0.14, 0.13, 0.13];
    const titles = ["№", "Предмет осмотра / состояние / примечание", "L / R", "Кол-во", "Сумма работ", "Оригинал / ед.", "Аналог / ед."];
    startTable(fractions.map((fraction, index) => ({ width: fraction * CONTENT_WIDTH, title: titles[index], align: index > 2 ? "right" : index === 2 ? "center" : undefined })));
    let number = 0;
    for (const category of new Set(data.inspectionItems.map((item) => item.category))) {
      section(category);
      for (const item of data.inspectionItems.filter((item) => item.category === category)) {
        const description = `${item.name} — ${states[item.condition]}${item.selectedPart !== "NONE" ? `\nВыбор: ${variants[item.selectedPart]}${item.selectedPart === "CUSTOM" ? ` (${formatMoney(item.customPriceCents)} / ед.)` : ""}` : ""}${item.note ? `\n${item.note}` : ""}`;
        row([String(++number), description, `${item.left ? "L" : "—"} / ${item.right ? "R" : "—"}`, formatQuantity(item.quantityMilli), formatMoney(lineTotal(item.quantityMilli, item.laborPriceCents)), formatMoney(item.originalPriceCents), formatMoney(item.analogPriceCents)]);
      }
    }
    if (!data.inspectionItems.length) paragraph("Пункты осмотра не добавлены.");
  } else {
    const fractions = [0.05, 0.47, 0.12, 0.18, 0.18];
    const titles = ["№", "Наименование / вариант / артикул", "Кол-во", "Цена / ед.", "Сумма"];
    startTable(fractions.map((fraction, index) => ({ width: fraction * CONTENT_WIDTH, title: titles[index], align: index > 1 ? "right" : undefined })));
    for (const kind of ["LABOR", "PART"] as const) {
      section(kind === "LABOR" ? "Работы и услуги" : "Запчасти и материалы");
      const lines = data.lines.filter((line) => line.kind === kind);
      lines.forEach((line, index) => row([String(index + 1), `${line.name}${kind === "PART" ? `\n${variants[line.variant]} · Артикул: ${shown(line.article)}` : ""}`, formatQuantity(line.quantityMilli), formatMoney(line.unitPriceCents), formatMoney(lineTotal(line.quantityMilli, line.unitPriceCents))]));
      if (!lines.length) row(["", "Позиции не добавлены.", "", "", ""]);
    }
  }
  activeColumns = null;
  top += 9;
  if (data.kind === "INSPECTION") {
    paragraph("L — левая сторона, R — правая сторона. «—» — сторона не отмечена.", { size: 7 });
    paragraph("Оригинал и аналог — альтернативные цены за единицу. Итоги рассчитаны по выбранным строкам заказа.", { size: 7 });
  }
  ensure(30);
  paragraph("Рекомендации", { bold: true });
  paragraph(shown(data.order.recommendations));
  top += 5;
  ensure(30);
  paragraph("Замечания", { bold: true });
  paragraph(shown(data.order.comment));
  top += 7;
  ensure(113);
  for (const [label, cents] of [
    ["Работы", data.totals.laborCents], ["Запчасти", data.totals.partsCents],
    ["До скидки", data.totals.subtotalCents], ["Скидка", data.totals.discountCents],
    ["Итого", data.totals.totalCents], ["Оплачено", data.totals.paidCents],
    ["Остаток", data.totals.balanceCents],
  ] as const) {
    const font = label === "Итого" ? bold : regular;
    draw(label, WIDTH - LEFT - 260, top, 8, font);
    const text = formatMoney(cents);
    draw(text, WIDTH - LEFT - font.widthOfTextAtSize(text, 8), top, 8, font);
    top += 15;
    horizontal(top - 2, WIDTH - LEFT - 260, 260);
  }
  top += 14;
  ensure(42);
  paragraph(`Мастер: _______________________ / ${shown(data.masterName)}`, { gap: 11 });
  paragraph(`Клиент: _______________________ / ${data.customer.name}`);

  const footerLabel = `Шаблон ${data.templateVersion} · ${data.settings.timezone}`;
  const longFooter = regular.widthOfTextAtSize(footerLabel, 7) > 330;
  if (longFooter) paragraph(footerLabel, { size: 7 });
  const pages = pdf.getPages();
  pages.forEach((current, index) => {
    page = current;
    // Footer is outside the body region on every page, added after pagination.
    draw(longFooter ? "Шаблон документа указан в тексте" : footerLabel, LEFT, 809, 7);
    const count = `Страница ${index + 1} из ${pages.length}`;
    draw(count, WIDTH - LEFT - regular.widthOfTextAtSize(count, 7), 809, 7);
  });
  return pdf.save();
}
