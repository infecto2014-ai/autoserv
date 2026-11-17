import { existsSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/server/auth";
import { inspectionGroups } from "./catalog";
if (existsSync(".env")) process.loadEnvFile(".env");
const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (
    !email ||
    !email.includes("@") ||
    !password ||
    password.length < 12 ||
    password.length > 256
  )
    throw new Error(
      "Укажите ADMIN_EMAIL и ADMIN_PASSWORD (12–256 символов) в окружении",
    );
  const timezone =
    process.env.TIMEZONE ||
    process.env.SERVICE_TIMEZONE ||
    "Europe/Kaliningrad";
  new Intl.DateTimeFormat("ru-RU", { timeZone: timezone }).format();
  const exists = await prisma.user.findUnique({ where: { email } });
  if (!exists)
    await prisma.user.create({
      data: {
        name: process.env.ADMIN_NAME || "Администратор",
        email,
        passwordHash: await hashPassword(password),
        role: "ADMIN",
      },
    });
  await prisma.serviceSettings.upsert({
    where: { id: "main" },
    create: {
      id: "main",
      name: process.env.SERVICE_NAME || "Автосервис",
      timezone,
    },
    update: {},
  });
  let sortOrder = 0;
  const items = Object.entries(inspectionGroups).flatMap(([category, names]) =>
    names.map((name) => ({
      category,
      name,
      sortOrder: sortOrder++,
      laborPriceCents: 0,
    })),
  );
  await prisma.catalogItem.createMany({ data: items, skipDuplicates: true });
  console.log(
    `Seed завершён: ${items.length} пунктов каталога; администратор ${exists ? "уже существует (пароль не изменён)" : "создан"}. Клиенты и заказы не добавляются.`,
  );
}
main().finally(() => prisma.$disconnect());
