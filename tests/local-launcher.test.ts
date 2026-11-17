import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createEnvironment,
  envValue,
  isCrmHealthy,
  main,
  npmInstallCommand,
  parseConfiguration,
  resolveLocalSchemaEngine,
  validateNode,
} from "../scripts/local.mjs";

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function config(overrides: Record<string, string> = {}) {
  return {
    ...parseConfiguration(
      createEnvironment({
        email: "admin@example.test",
        name: "Администратор",
        password: "private-$#\\-password",
      }),
    ).config,
    ...overrides,
  };
}
function contents(values: Record<string, string>) {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${envValue(value)}`)
    .join("\n");
}
async function healthServer(body: unknown, status = 200) {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test port");
  return address.port;
}

describe("локальный launcher", () => {
  it("создаёт случайные реквизиты БД и сохраняет буквальные спецсимволы пароля", () => {
    const first = config(),
      second = config();
    expect(first.POSTGRES_PASSWORD).toMatch(/^[a-f0-9]{64}$/);
    expect(first.POSTGRES_PASSWORD).not.toBe(second.POSTGRES_PASSWORD);
    expect(first.ADMIN_PASSWORD).toBe("private-$#\\-password");
    expect(first.APP_ORIGIN).toBe("http://localhost:3000");
    expect(first.TIMEZONE).toBe("Europe/Kaliningrad");
    expect(first.NEXT_TELEMETRY_DISABLED).toBe("1");
  });
  it("не создаёт пароль с молча изменённой escape-последовательностью", () => {
    expect(() =>
      createEnvironment({
        email: "admin@example.test",
        name: "Администратор",
        password: "private's-literal\\n-password",
      }),
    ).toThrow(/изменяет символы/);
    const escaped = createEnvironment({
      email: "admin@example.test",
      name: "Администратор",
      password: "private-literal\\n-password",
    });
    expect(parseConfiguration(escaped).config.ADMIN_PASSWORD).toBe(
      "private-literal\\n-password",
    );
  });
  it("не допускает внешние БД, подмену host и несовпадение Docker-реквизитов", () => {
    for (const DATABASE_URL of [
      "postgresql://sto:secret@external.test:5432/sto_crm",
      "postgresql://sto:secret@127.0.0.1:5544/sto_crm",
      "postgresql://sto:secret@127.0.0.1/sto_crm?host=external.test",
      "postgresql://sto:wrong@127.0.0.1/sto_crm",
    ]) {
      expect(() =>
        parseConfiguration(
          contents(config({ DATABASE_URL, POSTGRES_PASSWORD: "secret" })),
        ),
      ).toThrow();
    }
    const local = config({
      POSTGRES_PASSWORD: "p@ss:word#safe",
      DATABASE_URL: "postgresql://sto:p%40ss%3Aword%23safe@[::1]:5432/sto_crm",
    });
    expect(parseConfiguration(contents(local)).config.POSTGRES_PASSWORD).toBe(
      "p@ss:word#safe",
    );
  });
  it("ограничивает браузер локальным HTTP origin без пути или credentials", () => {
    for (const APP_ORIGIN of [
      "https://localhost:3000",
      "http://evil.test:3000",
      "http://localhost:3000/path",
      "http://user@localhost:3000",
      "http://localhost:3000?x=1",
    ]) {
      expect(() =>
        parseConfiguration(contents(config({ APP_ORIGIN }))),
      ).toThrow();
    }
    expect(
      parseConfiguration(
        contents(config({ APP_ORIGIN: "http://127.0.0.1:3001" })),
      ).port,
    ).toBe(3001);
  });
  it("проверяет Node и пароль, не выдавая секрет в ошибке", () => {
    for (const version of ["20.19.0", "22.11.0", "23.1.0", "25.0.0"])
      expect(() => validateNode(version)).toThrow();
    for (const version of ["22.12.0", "22.99.0", "24.0.0"])
      expect(() => validateNode(version)).not.toThrow();
    expect(() =>
      parseConfiguration(contents(config({ ADMIN_PASSWORD: "short" }))),
    ).toThrow(/12–256/);
    expect(
      npmInstallCommand("win32", "C:\\Windows\\System32\\cmd.exe"),
    ).toEqual([
      "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", "npm.cmd ci"],
    ]);
  });
  it("распознаёт только health CRM и не считает чужой JSON готовностью", async () => {
    expect(
      await isCrmHealthy(
        await healthServer({ service: "other", status: "ok" }),
      ),
    ).toBe(false);
    expect(
      await isCrmHealthy(
        await healthServer({ service: "sto-crm", status: "ok" }, 503),
      ),
    ).toBe(false);
    expect(
      await isCrmHealthy(
        await healthServer({ service: "sto-crm", status: "ok" }),
      ),
    ).toBe(true);
  });
  it("находит установленный schema engine без загрузки и отклоняет неполную установку", async () => {
    expect(await resolveLocalSchemaEngine(process.cwd())).toContain(
      "schema-engine-",
    );
    const root = mkdtempSync(path.join(tmpdir(), "sto-engine-test-"));
    directories.push(root);
    await expect(resolveLocalSchemaEngine(root)).rejects.toThrow(
      /автономная загрузка запрещена/,
    );
  });
  it("start не создаёт .env и требует готовую сборку без установки зависимостей", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sto-launcher-test-"));
    directories.push(root);
    await expect(main(["start", "--no-open"], root)).rejects.toThrow(
      /Setup-Windows/,
    );
    const unusedPort = await healthServer({});
    await new Promise<void>((resolve) =>
      servers[servers.length - 1].close(() => resolve()),
    );
    writeFileSync(
      path.join(root, ".env"),
      contents(config({ APP_ORIGIN: `http://localhost:${unusedPort}` })),
    );
    await expect(main(["start", "--no-open"], root)).rejects.toThrow(
      /production-сборка/,
    );
  });
  it("отказывает на занятом чужом порту и узнаёт уже запущенную CRM", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sto-launcher-test-"));
    directories.push(root);
    const foreignPort = await healthServer({
      service: "foreign",
      status: "ok",
    });
    writeFileSync(
      path.join(root, ".env"),
      contents(config({ APP_ORIGIN: `http://localhost:${foreignPort}` })),
    );
    await expect(main(["start", "--no-open"], root)).rejects.toThrow(
      /занят другим сервисом/,
    );
    const crmPort = await healthServer({ service: "sto-crm", status: "ok" });
    writeFileSync(
      path.join(root, ".env"),
      contents(config({ APP_ORIGIN: `http://localhost:${crmPort}` })),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(main(["start", "--no-open"], root)).resolves.toBeUndefined();
    expect(output).toHaveBeenCalledWith(
      `CRM уже работает: http://localhost:${crmPort}`,
    );
  });
});
