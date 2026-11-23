import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderDocument } from "../worker/pdf";
import type { DocumentSnapshot } from "../worker/document-types";
import { calculateTotals } from "../shared/money";
import { inspectionGroups } from "../shared/catalog";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function fixture(kind: DocumentSnapshot["kind"]): DocumentSnapshot {
  const lines: DocumentSnapshot["lines"] = [
    {
      kind: "LABOR",
      name: "Замена масла и фильтра",
      quantityMilli: 1500,
      unitPriceCents: 12345,
      variant: "NONE",
      article: "",
    },
    {
      kind: "LABOR",
      name: "Проверка тормозов",
      quantityMilli: 1000,
      unitPriceCents: 20000,
      variant: "NONE",
      article: "",
    },
    {
      kind: "PART",
      name: "Масляный фильтр",
      quantityMilli: 1000,
      unitPriceCents: 45678,
      variant: "ANALOG",
      article: "ФЛ-123",
    },
  ];
  return {
    kind,
    number: kind === "INSPECTION" ? "АО-2026-0001" : "ЗН-2026-0001",
    createdAt: "2026-11-17T22:30:00.000Z",
    templateVersion: "1.0",
    settings: {
      name: "Автосервис «Точный ход»",
      address: "г. Примерск, улица Механиков, дом 1",
      phone: "+7 900 000-00-00",
      taxId: "0000000000",
      timezone: "Europe/Moscow",
    },
    order: {
      number: "ЗН-2026-0001",
      openedAt: "2026-11-17T21:15:00.000Z",
      mileage: 123456,
      complaint: "Посторонний звук при торможении",
      recommendations: "Повторно проверить тормозную систему через 1000 км.",
      comment: "Согласовать замену с клиентом.",
      status: "IN_PROGRESS",
    },
    customer: {
      name: "Тестовый Клиент Александрович",
      phone: "+7 900 111-11-11",
    },
    vehicle: {
      make: "Лада",
      model: "Веста",
      year: 2020,
      vin: "XTA00000000000001",
      plate: "А001АА000",
    },
    masterName: "Мастер Проверочный",
    inspectionItems: [
      "UNCHECKED",
      "CHECKED",
      "REPAIR",
      "RECOMMENDED",
      "DONE",
    ].map((condition, index) => ({
      id: `item-${index}`,
      category: index < 2 ? "ТО-1" : "ТО-2 / передняя часть",
      name: `Проверка узла ${index + 1}`,
      left: index % 2 === 0,
      right: index % 2 === 1,
      condition:
        condition as DocumentSnapshot["inspectionItems"][number]["condition"],
      quantityMilli: 1500,
      laborPriceCents: 12345,
      originalPriceCents: 123456,
      analogPriceCents: 45678,
      customPriceCents: 34567,
      selectedPart: index === 0 ? "CUSTOM" : "ANALOG",
      note: "Проверить крепление и состояние.",
    })),
    lines,
    totals: calculateTotals(lines, 1000, 20000),
  };
}

async function pdf(data: DocumentSnapshot) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sto-pdf-"));
  directories.push(directory);
  const filename = path.join(directory, "document.pdf");
  const buffer = await renderDocument(data, {
    regular: await readFile(new URL("../assets/DejaVuSans.ttf", import.meta.url)),
    bold: await readFile(new URL("../assets/DejaVuSans-Bold.ttf", import.meta.url)),
  });
  await writeFile(filename, buffer);
  const info = execFileSync("pdfinfo", [filename], { encoding: "utf8" });
  const text = execFileSync("pdftotext", ["-layout", filename, "-"], {
    encoding: "utf8",
  });
  const bboxFile = path.join(directory, "coordinates.html");
  execFileSync("pdftotext", ["-bbox-layout", filename, bboxFile]);
  const bbox = await readFile(bboxFile, "utf8");
  const pages = [...bbox.matchAll(/<page\b[^>]*>([\s\S]*?)<\/page>/g)].map(
    (match) => match[1],
  );
  return {
    buffer,
    info,
    text,
    pages,
    fonts: execFileSync("pdffonts", [filename], { encoding: "utf8" }),
  };
}

function compact(text: string) {
  return text.replace(/\s+/g, " ").trim();
}
function words(page: string) {
  return [
    ...page.matchAll(
      /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g,
    ),
  ].map((match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
    right: Number(match[3]),
    bottom: Number(match[4]),
    text: match[5],
  }));
}

function assertPages(result: Awaited<ReturnType<typeof pdf>>) {
  expect(new TextDecoder().decode(result.buffer.subarray(0, 5))).toBe("%PDF-");
  expect(result.info).toMatch(/Page size:\s+595\.\d+ x 841\.\d+ pts \(A4\)/);
  expect(result.info).toMatch(/Encrypted:\s+no/);
  expect(result.fonts).toMatch(
    /[A-Z]{6}\+DejaVuSans\s+CID TrueType\s+Identity-H\s+yes\s+yes\s+yes/,
  );
  expect(result.text).not.toContain("�");
  expect(result.text).not.toContain("undefined");
  for (const [index, page] of result.pages.entries()) {
    const contents = words(page);
    expect(contents.length).toBeGreaterThan(0);
    for (const word of contents) {
      expect(word.x, word.text).toBeGreaterThanOrEqual(29);
      expect(word.right, word.text).toBeLessThanOrEqual(566);
      expect(word.y, word.text).toBeGreaterThanOrEqual(29);
      expect(word.bottom, word.text).toBeLessThan(823);
      // The body ends before the separately reserved running footer.
      if (word.y < 809) expect(word.bottom, word.text).toBeLessThan(797);
    }
    expect(compact(page.replace(/<[^>]+>/g, " "))).toContain(
      `Страница ${index + 1} из ${result.pages.length}`,
    );
  }
}

describe("server PDF documents with real Cyrillic fonts", () => {
  it("renders its browser bundle without Node globals, filesystem, network or WebAssembly", async () => {
    const bundled = await build({
      entryPoints: [new URL("../worker/pdf.ts", import.meta.url).pathname],
      bundle: true, platform: "browser", format: "iife", globalName: "PdfWorker", write: false,
    });
    const context = {
      crypto, TextEncoder, TextDecoder, atob, btoa, setTimeout, clearTimeout,
      WebAssembly: undefined,
      input: JSON.stringify(fixture("INSPECTION")),
      regular: await readFile(new URL("../assets/DejaVuSans.ttf", import.meta.url)),
      bold: await readFile(new URL("../assets/DejaVuSans-Bold.ttf", import.meta.url)),
    };
    const rendered = await runInNewContext(`${bundled.outputFiles[0].text}
      PdfWorker.renderDocument(JSON.parse(input), {
        regular: new Uint8Array(regular), bold: new Uint8Array(bold),
      });`, context, { timeout: 10000 }) as Uint8Array;
    expect(new TextDecoder().decode(rendered.subarray(0, 5))).toBe("%PDF-");
    expect(rendered.byteLength).toBeLessThan(100_000);
  });

  it("keeps all 110 standard seed checklist entries legible within three A4 pages", async () => {
    const data = fixture("INSPECTION");
    data.inspectionItems = Object.entries(inspectionGroups).flatMap(
      ([category, names]) =>
        names.map((name) => ({
          ...data.inspectionItems[0],
          id: `${category}-${name}`,
          category,
          name,
          left: false,
          right: false,
          condition: "UNCHECKED" as const,
          quantityMilli: 1000,
          laborPriceCents: 0,
          originalPriceCents: 0,
          analogPriceCents: 0,
          customPriceCents: 0,
          selectedPart: "NONE" as const,
          note: "",
        })),
    );
    expect(data.inspectionItems).toHaveLength(110);
    const result = await pdf(data);
    assertPages(result);
    expect(result.pages.length).toBeLessThanOrEqual(3);
    const text = compact(result.text);
    const glyphs = result.pages.flatMap((page) => words(page));
    expect(glyphs.filter((word) => word.text === "проверялось")).toHaveLength(
      110,
    );
    // Reconstruct the description column so prices on a wrapped line cannot
    // interrupt the extracted name/state in Poppler's layout reading order.
    const descriptions = compact(
      glyphs
        .filter((word) => word.x >= 55 && word.right <= 276)
        .map((word) => word.text)
        .join(" "),
    );
    for (const item of data.inspectionItems)
      expect(descriptions).toContain(item.name);
    expect(text).not.toContain("Выбор: Без запчасти");
    expect(text).toContain("Клиент: _______________________");
  }, 30000);

  it("renders the complete inspection, sides, five conditions and alternative prices on A4", async () => {
    const result = await pdf(fixture("INSPECTION"));
    assertPages(result);
    const text = compact(result.text);
    expect(text).toContain("АКТ ОСМОТРА ТРАНСПОРТНОГО СРЕДСТВА");
    for (const value of [
      "Точный ход",
      "Тестовый Клиент Александрович",
      "Веста",
      "XTA00000000000001",
      "А001АА000",
      "Мастер Проверочный",
      "ТО-1",
      "ТО-2 / передняя часть",
      "Не проверялось",
      "Осмотрено",
      "Требует ремонта",
      "Рекомендовано",
      "Выполнено",
      "Оригинал / ед.",
      "Аналог / ед.",
      "Индивидуальная цена",
      "345,67",
      "1 234,56",
      "456,78",
      "1,5",
      "185,18",
      "Рекомендации",
      "Замечания",
      "Клиент: _______________________",
    ]) {
      expect(text, value).toContain(value);
    }
    expect(text.replaceAll(" ", "")).toContain("L/R");
    expect(text.replaceAll(" ", "")).toContain("L/—");
    expect(text.replaceAll(" ", "")).toContain("—/R");
    expect(text).toContain("18.11.2026, 01:30");
    expect(text).toContain("18.11.2026, 00:15");
    expect(result.pages.length).toBeLessThanOrEqual(2);
  }, 30000);

  it("renders work and parts separately with exact fractional quantities and saved totals", async () => {
    const data = fixture("WORK_ORDER");
    data.vehicle.year = null;
    data.vehicle.vin = null;
    data.vehicle.plate = null;
    const original = JSON.stringify(data);
    const result = await pdf(JSON.parse(original) as DocumentSnapshot);
    assertPages(result);
    expect(JSON.stringify(data)).toBe(original);
    const text = compact(result.text);
    expect(text).toContain("ЗАКАЗ-НАРЯД");
    expect(text.indexOf("Работы и услуги")).toBeLessThan(
      text.indexOf("Запчасти и материалы"),
    );
    for (const value of [
      "Замена масла и фильтра",
      "Проверка тормозов",
      "Масляный фильтр",
      "Аналог",
      "ФЛ-123",
      "1,5",
      "123,45",
      "185,18",
      "456,78",
      "385,18",
      "841,96",
      "10,00",
      "831,96",
      "200,00",
      "631,96",
    ]) {
      expect(text, value).toContain(value);
    }
    expect(result.pages).toHaveLength(1);
  }, 30000);

  it("continues long Cyrillic checklist rows with one nonoverlapping table header on each table page", async () => {
    const data = fixture("INSPECTION");
    data.inspectionItems = Array.from({ length: 72 }, (_, index) => ({
      ...data.inspectionItems[index % 5],
      id: `long-${index}`,
      category: [
        "ТО-1",
        "ТО-2 / передняя часть",
        "ТО-2 / задняя часть",
        "Технические жидкости",
        "Тормоза",
        "Шины",
      ][Math.floor(index / 12)],
      name: `Контрольнаяпозиция${index + 1} Подробная проверка состояния креплений, пыльников и сопряжённых механизмов автомобиля`,
      note: `Примечание${index + 1} ${"Необходимо согласовать дополнительную проверку с владельцем автомобиля. ".repeat(index === 30 ? 95 : 2)} Конецпримечания${index + 1}`,
    }));
    data.order.recommendations = `${"Рекомендуется повторная диагностика после ремонта. ".repeat(60)} Конецрекомендаций`;
    const result = await pdf(data);
    assertPages(result);
    expect(result.pages.length).toBeGreaterThan(4);
    const text = compact(result.text);
    for (let index = 1; index <= 72; index++) {
      expect(text).toContain(`Контрольнаяпозиция${index}`);
      expect(text).toContain(`Примечание${index}`);
      expect(text).toContain(`Конецпримечания${index}`);
    }
    expect(text).toContain("Конецрекомендаций");
    expect(text.match(/согласовать/gu)).toHaveLength(71 * 2 + 95);
    expect(text).toContain("Клиент: _______________________");
    let headerPages = 0;
    for (const page of result.pages) {
      const contents = words(page);
      const headerWords = contents.filter((word) => word.text === "Предмет");
      const body = contents.filter((word) =>
        /^(Контрольная|Примечание|Необходимо|Конецпримечания|Осмотрено|Выполнено)/u.test(
          word.text,
        ),
      );
      expect(headerWords.length).toBeLessThanOrEqual(1);
      if (body.length) expect(headerWords).toHaveLength(1);
      if (!headerWords.length) continue;
      headerPages++;
      const header = headerWords[0];
      // Measure actual header glyphs. A vertical window alone also captures the
      // first compact body row and would incorrectly treat it as header text.
      const headerTokens = new Set([
        "№",
        "Предмет",
        "осмотра",
        "состояние",
        "примечание",
        "Кол-во",
        "Сумма",
        "работ",
        "Оригинал",
        "ед.",
        "Аналог",
      ]);
      const headerBottom = Math.max(
        ...contents
          .filter(
            (word) =>
              headerTokens.has(word.text) &&
              word.y >= header.y - 1 &&
              word.y < header.y + 20,
          )
          .map((word) => word.bottom),
      );
      for (const word of body)
        expect(word.y, word.text).toBeGreaterThan(headerBottom - 0.5);
    }
    expect(headerPages).toBeGreaterThan(4);
  }, 60000);

  it("continues a long completion act and wraps unspaced article codes without losing the last row", async () => {
    const data = fixture("WORK_ORDER");
    data.templateVersion = "completion-act-1.0";
    data.signerName = "Иван Сотрудник";
    data.includeRecommendations = true;
    data.version = 1;
    data.lines = Array.from({ length: 85 }, (_, index) => ({
      ...data.lines[index % 3],
      kind: index < 40 ? "LABOR" : "PART",
      name: `Строказаказа${index + 1} ${"Разборка, проверка и восстановление работоспособности узла. ".repeat(index === 42 ? 80 : 2)} Конецстроки${index + 1}`,
      article: "ДЛИННЫЙАРТИКУЛБЕЗПРОБЕЛОВ0123456789".repeat(4),
    }));
    data.totals = calculateTotals(data.lines, 1000, 20000);
    const result = await pdf(data);
    assertPages(result);
    expect(result.pages.length).toBeGreaterThan(4);
    const text = compact(result.text);
    expect(text.match(/работоспособности/gu)).toHaveLength(84 * 2 + 80);
    for (let index = 1; index <= 85; index++) {
      expect(text).toContain(`Строказаказа${index}`);
      expect(text).toContain(`Конецстроки${index}`);
    }
    let headerPages = 0;
    for (const page of result.pages) {
      const contents = words(page);
      const header = contents.filter((word) => word.text === "Наименование");
      const body = contents.filter((word) =>
        /^(Строказаказа|Разборка|Конецстроки)/u.test(word.text),
      );
      expect(header.length).toBeLessThanOrEqual(1);
      if (body.length) expect(header).toHaveLength(1);
      if (!header.length) continue;
      headerPages++;
      const headerBottom = Math.max(
        ...contents
          .filter(
            (word) => word.y >= header[0].y - 1 && word.y < header[0].y + 15,
          )
          .map((word) => word.bottom),
      );
      for (const word of body)
        expect(word.y, word.text).toBeGreaterThan(headerBottom - 0.5);
    }
    expect(headerPages).toBeGreaterThan(4);
    expect(text).toContain("Клиент: _______________________");
  }, 60000);
});
