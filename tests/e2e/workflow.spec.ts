import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
const database = process.env.DATABASE_URL;
if (!database || !new URL(database).pathname.endsWith("_test"))
  throw new Error("Workflow E2E требует отдельную БД с именем *_test");
const email = process.env.ADMIN_EMAIL,
  password = process.env.ADMIN_PASSWORD;
if (!email || !password)
  throw new Error(
    "Workflow E2E требует ADMIN_EMAIL и ADMIN_PASSWORD из окружения",
  );
async function login(page: Page, loginEmail: string, loginPassword: string) {
  await page.goto("/");
  await page.getByLabel("Электронная почта", { exact: true }).fill(loginEmail);
  await page.getByLabel("Пароль", { exact: true }).fill(loginPassword);
  await page
    .getByRole("button", { name: "Войти в рабочее пространство" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Обзор", exact: true }),
  ).toBeVisible();
}
async function saved(page: Page) {
  await expect(page.getByRole("status")).toContainText(/сохранен/, {
    timeout: 20000,
  });
}
test("клиент → автомобиль → осмотр → заказ → PDF → история и права мастера", async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  const suffix = Date.now().toString(),
    customer = `Тест клиента ${suffix}`,
    plate = `ТЕСТ${suffix.slice(-6)}`,
    masterName = `Мастер ${suffix}`,
    masterEmail = `master-${suffix}@example.test`,
    masterPassword = randomBytes(20).toString("hex");
  await login(page, email!, password!);
  await page.getByRole("link", { name: "Сотрудники", exact: true }).click();
  await page.getByRole("button", { name: "Новый сотрудник" }).click();
  await page.getByLabel("Имя сотрудника", { exact: true }).fill(masterName);
  await page.getByLabel("Электронная почта", { exact: true }).fill(masterEmail);
  await page.getByLabel("Пароль", { exact: true }).fill(masterPassword);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("link", { name: "Клиенты", exact: true }).click();
  await page.getByRole("button", { name: "Новый клиент" }).click();
  await page.getByLabel("ФИО / название", { exact: true }).fill(customer);
  await page.getByLabel("Телефон", { exact: true }).fill("+79990001122");
  await page
    .getByLabel("Комментарий", { exact: true })
    .fill("Синтетическая запись автоматической проверки");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("link", { name: "Автомобили", exact: true }).click();
  await page.getByRole("button", { name: "Добавить автомобиль" }).click();
  await page.getByLabel("Найти владельца", { exact: true }).fill(customer);
  await expect(
    page
      .getByRole("combobox", { name: "Владелец", exact: true })
      .locator("option")
      .filter({ hasText: customer }),
  ).toHaveCount(1);
  await page
    .getByRole("combobox", { name: "Владелец", exact: true })
    .selectOption({ label: `${customer} · +79990001122` });
  await page.getByLabel("Марка", { exact: true }).fill("Тестмарка");
  await page.getByLabel("Модель", { exact: true }).fill("Модель E2E");
  await page.getByLabel("Госномер", { exact: true }).fill(plate);
  await page.getByLabel("Пробег, км", { exact: true }).fill("125000");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("link", { name: "Заказы", exact: true }).click();
  await page.getByRole("button", { name: "Новый заказ" }).click();
  await page.getByLabel("Найти автомобиль", { exact: true }).fill(plate);
  const vehicleSelect = page.getByRole("combobox", {
    name: "Автомобиль и клиент",
    exact: true,
  });
  await expect(
    vehicleSelect.locator("option").filter({ hasText: plate }),
  ).toHaveCount(1);
  await vehicleSelect.selectOption({
    label: `Тестмарка Модель E2E · ${plate} · ${customer}`,
  });
  await page
    .getByRole("combobox", { name: "Ответственный мастер", exact: true })
    .selectOption({ label: masterName });
  await page
    .getByLabel("Жалоба / причина обращения", { exact: true })
    .fill("Проверить ходовую часть, заменить масло. Синтетическая проверка.");
  await page
    .getByRole("button", { name: "Создать заказ", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: /Заказ-наряд №/ }),
  ).toBeVisible();
  const orderUrl = page.url();
  await page.getByLabel("Поиск", { exact: true }).fill("Масло моторное");
  const item = page
    .locator(".inspection-item")
    .filter({ has: page.getByText("Масло моторное", { exact: true }) });
  await expect(item).toHaveCount(1);
  await item
    .getByLabel("Состояние: Масло моторное", { exact: true })
    .selectOption("REPAIR");
  await item.getByLabel("L", { exact: true }).check();
  await item
    .getByLabel("Цена работы Масло моторное", { exact: true })
    .fill("1200,50");
  await item.getByLabel("Цена работы Масло моторное", { exact: true }).blur();
  await item
    .getByLabel("Цена оригинала Масло моторное", { exact: true })
    .fill("2300,25");
  await item
    .getByLabel("Цена оригинала Масло моторное", { exact: true })
    .blur();
  await item
    .getByRole("combobox", { name: "Запчасть в заказ", exact: true })
    .selectOption("ORIGINAL");
  await page
    .getByLabel("Рекомендации клиенту", { exact: true })
    .fill("Повторный контроль через 1000 км.");
  await saved(page);
  await page.reload();
  await expect(
    page.getByLabel("Рекомендации клиенту", { exact: true }),
  ).toHaveValue("Повторный контроль через 1000 км.");
  await page.getByLabel("Поиск", { exact: true }).fill("Масло моторное");
  await expect(
    item.getByLabel("Состояние: Масло моторное", { exact: true }),
  ).toHaveValue("REPAIR");
  await expect(
    item.getByLabel("Цена работы Масло моторное", { exact: true }),
  ).toHaveValue("1 200,50");
  await item
    .getByLabel("Перенести Масло моторное в заказ", { exact: true })
    .check();
  await page.getByRole("button", { name: "В заказ (1)", exact: true }).click();
  await page.getByRole("tab", { name: /Работы и запчасти/ }).click();
  await expect(
    page.getByLabel("Название позиции 1", { exact: true }),
  ).toHaveValue("Масло моторное");
  await expect(page.locator(".total-final")).toContainText("3 500,75");
  await page.getByLabel("Скидка в рублях", { exact: true }).fill("100,25");
  await page.getByLabel("Скидка в рублях", { exact: true }).blur();
  await page.getByLabel("Оплачено в рублях", { exact: true }).fill("1000,50");
  await page.getByLabel("Оплачено в рублях", { exact: true }).blur();
  await page.getByRole("button", { name: "Сохранить оплату и скидку" }).click();
  await expect(page.locator(".total-balance")).toContainText("2 400,00");
  await page.getByRole("tab", { name: /Документы/ }).click();
  for (const title of ["Акт осмотра", "Заказ-наряд"]) {
    await page.getByRole("button", { name: title, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("iframe")).toHaveAttribute(
      "src",
      /\/api\/documents\//,
    );
    const href = await dialog
      .getByRole("link", { name: "Скачать PDF" })
      .getAttribute("href");
    const response = await page.request.get(href!);
    expect(response.ok()).toBeTruthy();
    expect(response.headers()["content-type"]).toContain("application/pdf");
    expect((await response.body()).subarray(0, 4).toString()).toBe("%PDF");
    await dialog.getByRole("button", { name: "Закрыть окно" }).click();
  }
  await expect(page.locator(".document-row")).toHaveCount(2);
  await page.getByRole("link", { name: "Автомобили", exact: true }).click();
  await page.getByLabel("Поиск", { exact: true }).fill(plate);
  await page.getByRole("button", { name: "История", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText(/Синтетическая проверка/),
  ).toBeVisible();
  await page.getByRole("dialog").getByRole("link").click();
  await expect(page).toHaveURL(orderUrl);
  await expect(page.getByRole('heading',{name:/Заказ-наряд №/})).toBeVisible();
  await page.getByLabel('Поиск',{exact:true}).fill('Масло моторное');
  await expect(page.getByText('Масло моторное',{exact:true})).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("desktop-1366.png"),
    fullPage: false,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({
    path: testInfo.outputPath("mobile-375.png"),
    fullPage: false,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await login(page, masterEmail, masterPassword);
  await expect(
    page.getByRole("link", { name: "Сотрудники", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Настройки", exact: true }),
  ).toHaveCount(0);
  await page.goto(orderUrl);
  await expect(
    page.getByRole("heading", { name: /Заказ-наряд №/ }),
  ).toBeVisible();
  await page.getByLabel("Поиск", { exact: true }).fill("Масло моторное");
  await expect(
    page.getByLabel("Цена работы Масло моторное", { exact: true }),
  ).toHaveCount(0);
  await item
    .getByLabel("Состояние: Масло моторное", { exact: true })
    .selectOption("DONE");
  await saved(page);
  await page.reload();
  await page.getByLabel("Поиск", { exact: true }).fill("Масло моторное");
  await expect(
    item.getByLabel("Состояние: Масло моторное", { exact: true }),
  ).toHaveValue("DONE");
  await page.getByRole("tab", { name: /Работы и запчасти/ }).click();
  await expect(
    page.getByRole("button", { name: "Сохранить строки" }),
  ).toHaveCount(0);
});
