import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

const money = (amount: number) => new RegExp(`${amount.toLocaleString("ru-RU").replace(/\s/g, "\\s")},00\\s*₽`);
const orderDate = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Kaliningrad" }).format();

async function loseFirstResponse(page: Page, url: string, status: number) {
  const requests: unknown[] = [];
  await page.route(url, async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      expect((await route.fetch()).status()).toBe(status);
      await route.abort("failed");
    } else await route.continue();
  });
  return async () => {
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    await page.unroute(url);
  };
}

async function readAct(page: Page, path: string) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("dialog").getByRole("link", { name: "Скачать PDF" }).click(),
  ]);
  await download.saveAs(path);
  expect(execFileSync("pdfinfo", [path], { encoding: "utf8" })).toMatch(/Page size:\s*595[\d.]* x 841[\d.]* pts/);
  return execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" });
}

test("приёмщик выдаёт автомобиль с долгом, проводит доплату и сохраняет версии акта", async ({ page }, info) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (err) => browserErrors.push(err.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Долг клиентов/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Новый заказ" })).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("overview.png") });

  await page.getByRole("link", { name: "Сотрудники" }).click();
  await page.getByLabel("Имя мастера").fill("Илья Тестов");
  await page.getByRole("button", { name: "Добавить мастера" }).click();
  await expect(page.getByText("Мастер «Илья Тестов» добавлен.")).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveCount(0);

  await page.getByRole("link", { name: "Заказы", exact: true }).click();
  await page.getByRole("button", { name: "Новый заказ" }).click();
  const intake = page.getByRole("dialog", { name: "Новый заказ" });
  await intake.getByLabel("Марка").fill("Лада");
  await page.keyboard.press("Tab");
  await expect(intake.getByLabel("Телефон")).toBeFocused();
  await intake.getByLabel("Телефон").fill("+79990001122");
  await intake.getByLabel("Жалоба / причина обращения").fill("Стук при запуске двигателя");
  await intake.getByText("Дополнительные сведения").click();
  await intake.getByLabel("Имя клиента").fill("Александр Ёлкин");
  await intake.getByLabel("Модель").fill("Веста");
  await intake.getByLabel("Госномер").fill("А123ВЕ39");
  await intake.getByLabel("Мастер").selectOption({ label: "Илья Тестов" });
  // The real Worker commits first. Chromium loses the response.
  const confirmIntake = await loseFirstResponse(page, "**/api/intake", 201);
  await intake.getByRole("button", { name: "Создать заказ" }).click();
  await expect(intake.getByRole("alert")).toContainText("Повторите отправку");
  await expect(intake.getByLabel("Жалоба / причина обращения")).toHaveValue("Стук при запуске двигателя");
  await intake.getByRole("button", { name: "Повторить отправку" }).click();
  await expect(page.getByRole("heading", { name: "Акт осмотра автомобиля" })).toBeVisible();
  await confirmIntake();
  const orderUrl = page.url();

  await page.getByLabel("Группа заказа").selectOption("APPROVAL");
  await expect(page.getByLabel("Группа заказа")).toHaveValue("APPROVAL");
  await page.getByRole("tab", { name: /Работы и запчасти/ }).click();
  await page.getByRole("button", { name: "Внести оплату" }).click();
  await page.getByRole("dialog").getByLabel("Сумма, ₽").fill("500");
  await page.getByRole("button", { name: "Записать оплату" }).click();
  await expect(page.getByText(/Получено авансом.*500,00/)).toBeVisible();
  await page.getByRole("tab", { name: /^Осмотр/ }).click();
  await page.getByPlaceholder("Найти пункт осмотра").fill("Масло моторное");
  await page.getByLabel("Состояние: Масло моторное").selectOption("REPAIR");
  await page.getByLabel("Цена работы Масло моторное").fill("1800");
  await page.getByLabel("Цена аналога Масло моторное").fill("250");
  await page.getByLabel("Запчасть в заказ").selectOption("ANALOG");
  await page.getByLabel("Рекомендации клиенту").fill("Контроль уровня масла через неделю.");
  await page.getByLabel("Перенести Масло моторное в заказ").check();
  await expect(page.getByRole("status", { name: "" }).filter({ hasText: "Все изменения сохранены" })).toBeVisible();
  await page.getByRole("button", { name: "В заказ (1)" }).click();
  const works = page.locator(".line-section").filter({ has: page.getByRole("heading", { name: "Работы", exact: true }) });
  const parts = page.locator(".line-section").filter({ has: page.getByRole("heading", { name: "Запчасти", exact: true }) });
  await works.getByLabel("Решение клиента").selectOption("APPROVED");
  await parts.getByLabel("Источник детали").selectOption("CUSTOMER");
  await parts.getByLabel("Решение клиента").selectOption("APPROVED");
  await page.getByRole("button", { name: "Сохранить строки" }).click();
  await expect(page.locator(".total-final")).toContainText(money(1800));
  await expect(page.getByText("Без оплаты сервису")).toBeVisible();

  await works.getByLabel("Цена за единицу, ₽").fill("2000");
  await page.getByRole("button", { name: "Сохранить строки" }).click();
  await expect(page.getByText(/нужно согласовать повторно/)).toBeVisible();
  await expect(works.getByLabel("Решение клиента")).toHaveValue("PENDING");
  await works.getByLabel("Решение клиента").selectOption("APPROVED");
  await works.getByLabel("Выполнено").check();
  await parts.getByLabel("Выполнено").check();
  await works.getByRole("button", { name: "Добавить работу" }).click();
  const declined = works.locator(".line-card").filter({ has: page.getByRole("button", { name: "Удалить: новая строка" }) });
  await declined.getByLabel("Наименование").fill("Замена ремня");
  await works.locator(".line-card").filter({ has: page.getByRole("button", { name: "Удалить: Замена ремня" }) }).getByLabel("Решение клиента").selectOption("DEFERRED");
  await page.getByRole("button", { name: "Сохранить строки" }).click();
  await expect(page.getByText("Вне итога")).toBeVisible();
  await expect(page.locator(".total-final")).toContainText(money(2000));

  const discount = page.getByLabel("Скидка на работы, ₽");
  await discount.fill("2500");
  await page.getByRole("tab", { name: /^Документы/ }).click();
  await expect(page.getByRole("alert").first()).toContainText("Сохраните или отмените изменения");
  await page.getByRole("button", { name: "Сохранить скидку" }).click();
  await expect(page.getByRole("alert").first()).toContainText("Скидка превышает стоимость работ");
  await expect(discount).toHaveValue(/2\s500,00/);
  await discount.fill("200");
  await page.getByRole("button", { name: "Сохранить скидку" }).click();
  await expect(page.locator(".total-balance")).toContainText(money(1300));
  await page.locator(".financial-layout").screenshot({ path: info.outputPath("order-finances.png") });
  await page.getByLabel("Группа заказа").selectOption("READY");
  await page.getByRole("button", { name: "Выдать автомобиль" }).click();
  const delivery = page.getByRole("dialog", { name: "Выдача автомобиля" });
  await expect(delivery).toContainText(money(1300));
  await expect(delivery.getByLabel(/Включить рекомендации/)).not.toBeChecked();
  await delivery.getByLabel(/Включить рекомендации/).check();
  const confirmDelivery = await loseFirstResponse(page, "**/api/orders/*/deliver", 200);
  await delivery.getByRole("button", { name: "Выдать и сформировать акт" }).click();
  await expect(delivery.getByRole("alert")).toContainText("Повторите отправку");
  await delivery.getByRole("button", { name: "Повторить выдачу" }).click();
  await expect(page.getByRole("dialog", { name: /Акт выполненных работ/ })).toBeVisible();
  await confirmDelivery();
  const first = await readAct(page, info.outputPath("act-v1.pdf"));
  expect(first).toContain("TOP-СЕРВИС");
  expect(first).toContain("Контроль уровня масла через неделю");
  expect(first).toContain("Замена ремня");
  expect(first).toMatch(/Остаток долга.*1[\s ]300,00/);
  expect(first).toContain("Деталь клиента");
  expect(first).toContain("Тестовый приёмщик");
  execFileSync("pdftoppm", ["-singlefile", "-png", "-scale-to", "1000", info.outputPath("act-v1.pdf"), info.outputPath("act-v1")]);
  await page.getByRole("dialog").getByRole("button", { name: "Закрыть окно" }).click();

  await page.getByRole("link", { name: "Обзор", exact: true }).click();
  await page.getByRole("link", { name: /Долг клиентов/ }).click();
  await expect(page.getByLabel("Только с долгом")).toBeChecked();
  await expect(page.getByLabel("Период")).toHaveValue("all");
  await page.getByRole("link", { name: /^№ / }).click();
  expect(page.url()).toBe(orderUrl);
  await page.getByRole("tab", { name: /Работы и запчасти/ }).click();
  await page.getByRole("button", { name: "Внести оплату" }).click();
  await page.getByRole("dialog").getByLabel("Сумма, ₽").fill("1300");
  const confirmSettlement = await loseFirstResponse(page, "**/api/orders/*/payments", 200);
  await page.getByRole("button", { name: "Записать оплату" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Повторите отправку");
  await page.getByRole("button", { name: "Повторить отправку" }).click();
  await expect(page.locator(".total-balance")).toContainText(money(0));
  await confirmSettlement();

  await page.getByRole("link", { name: "Клиенты и авто" }).click();
  await page.getByLabel("Поиск клиентов и авто").fill("александр ёлкин");
  await page.getByLabel("Период").selectOption("custom");
  await page.getByLabel("С", { exact: true }).fill(orderDate());
  await page.getByLabel("По", { exact: true }).fill(orderDate());
  await page.getByRole("button", { name: "История" }).click();
  await expect(page.getByRole("dialog")).toContainText("Стук при запуске двигателя");
  await page.getByRole("dialog").getByRole("link", { name: /^№ / }).click();
  await page.getByRole("button", { name: "Изменить сведения" }).click();
  await page.getByLabel("Комментарий к заказу").fill("Контроль после выдачи");
  await page.getByRole("button", { name: "Сохранить сведения" }).click();
  await expect(page.getByText(/Актуальный акт требуется/)).toBeVisible();
  await page.getByRole("tab", { name: /Документы/ }).click();
  await page.getByRole("button", { name: "Новая версия акта" }).click();
  await page.getByRole("button", { name: "Сформировать акт", exact: true }).click();
  await expect(page.getByRole("dialog", { name: /Акт выполненных работ/ })).toBeVisible();
  const revised = await readAct(page, info.outputPath("act-v2.pdf"));
  expect(revised).toContain("Контроль после выдачи");
  expect(revised).toMatch(/Остаток долга.*0,00/);
  expect(revised).not.toContain("Замена ремня");
  await page.getByRole("dialog").getByRole("button", { name: "Закрыть окно" }).click();
  await page.locator(".document-row").filter({ hasText: "версия 1" }).getByRole("button", { name: "Просмотр" }).click();
  expect(await readAct(page, info.outputPath("act-v1-reopen.pdf"))).toBe(first);
  await page.getByRole("dialog").getByRole("button", { name: "Закрыть окно" }).click();
  await page.getByRole("tab", { name: /Работы и запчасти/ }).click();
  await page.getByRole("button", { name: "Оформить возврат" }).click();
  const refund = page.getByRole("dialog", { name: "Возврат оплаты" });
  await refund.getByLabel("Исходный платёж").selectOption({ index: 1 });
  await refund.getByLabel("Сумма, ₽").fill("50");
  await refund.getByLabel("Причина возврата").fill("Корректировка платежа");
  await refund.getByRole("button", { name: "Записать возврат" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Корректировка платежа" })).toBeVisible();
  await expect(page.locator(".total-balance")).toContainText(money(50));
  expect(browserErrors).toEqual([]);
});
