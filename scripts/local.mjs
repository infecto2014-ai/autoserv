#!/usr/bin/env node
/** Local production launcher; dependency-free so setup also works before npm ci. */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const usage = `Локальная CRM автосервиса\n\nnode scripts/local.mjs setup [--no-open]  Подготовка (нужен интернет)\nnode scripts/local.mjs start [--no-open]  Автономный запуск\nnode scripts/local.mjs --help\n\nSetup создаёт .env через мастер, устанавливает зависимости, подготавливает БД и сборку.\nStart использует только установленные зависимости и локальный Docker-образ.\nОстановка сервера: Ctrl+C. Данные PostgreSQL сохраняются в Docker volume.`;

export function validateNode(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  if (!((major === 22 && minor >= 12) || major === 24))
    throw new Error(
      "Нужен Node.js 22.12+ (ветка 22) или Node.js 24 LTS. Установите его и заново откройте окно.",
    );
}

export function parseConfiguration(contents) {
  const config = parseEnv(contents.replace(/^\uFEFF/, ""));
  for (const name of [
    "DATABASE_URL",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "APP_ORIGIN",
    "ADMIN_EMAIL",
    "ADMIN_NAME",
    "ADMIN_PASSWORD",
    "TIMEZONE",
  ]) {
    if (!config[name]?.trim())
      throw new Error(
        `В .env не заполнено поле ${name}. Исправьте файл; существующие данные не изменены.`,
      );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.ADMIN_EMAIL))
    throw new Error("В .env некорректен ADMIN_EMAIL.");
  if (config.ADMIN_PASSWORD.length < 12 || config.ADMIN_PASSWORD.length > 256)
    throw new Error("ADMIN_PASSWORD в .env должен содержать 12–256 символов.");
  let database, origin;
  try {
    database = new URL(config.DATABASE_URL);
    origin = new URL(config.APP_ORIGIN);
  } catch {
    throw new Error("В .env некорректен DATABASE_URL или APP_ORIGIN.");
  }
  if (
    !["postgresql:", "postgres:"].includes(database.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) ||
    (database.port && database.port !== "5432")
  )
    throw new Error(
      "DATABASE_URL должен указывать только на локальную PostgreSQL (localhost/127.0.0.1/::1:5432).",
    );
  let dbName, user, password;
  try {
    dbName = decodeURIComponent(database.pathname.slice(1));
    user = decodeURIComponent(database.username);
    password = decodeURIComponent(database.password);
  } catch {
    throw new Error("Некорректное URI-кодирование в DATABASE_URL.");
  }
  if (
    dbName !== config.POSTGRES_DB ||
    user !== config.POSTGRES_USER ||
    password !== config.POSTGRES_PASSWORD ||
    ["postgres", "template0", "template1"].includes(dbName)
  )
    throw new Error(
      "DATABASE_URL должен совпадать с POSTGRES_DB, POSTGRES_USER и POSTGRES_PASSWORD; системные базы запрещены.",
    );
  if (
    [...database.searchParams.keys()].some((key) =>
      ["host", "hostaddr", "socket"].includes(key.toLowerCase()),
    )
  )
    throw new Error(
      "Параметр host в DATABASE_URL запрещён: используйте локальный адрес в URL.",
    );
  if (
    origin.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error(
      "APP_ORIGIN должен быть http://localhost:3000 (или http://127.0.0.1 с нужным портом), без пути.",
    );
  if (Number(origin.port || 80) < 1)
    throw new Error("APP_ORIGIN должен содержать порт от 1 до 65535.");
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone: config.TIMEZONE }).format();
  } catch {
    throw new Error("В .env некорректен TIMEZONE.");
  }
  return { config, origin: origin.origin, port: Number(origin.port || 80) };
}

// Node's dotenv parser does not support escaping a quote inside the same quote type.
export function envValue(value) {
  if (/[\r\n\0]/.test(value))
    throw new Error(
      "Значение .env не должно содержать перевод строки или NUL.",
    );
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("#") && !/^\s|\s$/.test(value) && !/^["']/.test(value))
    return value;
  throw new Error(
    "Для совместимого .env не сочетайте оба вида кавычек и # в одном значении.",
  );
}

export function createEnvironment({ email, name, password }) {
  const pgPassword = randomBytes(32).toString("hex");
  const config = {
    DATABASE_URL: `postgresql://sto:${pgPassword}@127.0.0.1:5432/sto_crm?schema=public`,
    POSTGRES_DB: "sto_crm",
    POSTGRES_USER: "sto",
    POSTGRES_PASSWORD: pgPassword,
    APP_ORIGIN: "http://localhost:3000",
    ADMIN_EMAIL: email.trim().toLowerCase(),
    ADMIN_NAME: name.trim(),
    ADMIN_PASSWORD: password,
    SERVICE_NAME: "Автосервис",
    TIMEZONE: "Europe/Kaliningrad",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const contents =
    Object.entries(config)
      .map(([key, value]) => `${key}=${envValue(value)}`)
      .join("\n") + "\n";
  const parsed = parseConfiguration(contents).config;
  if (Object.entries(config).some(([key, value]) => parsed[key] !== value))
    throw new Error(
      "Формат .env изменяет символы значения. Используйте другой пароль/имя без сочетания апострофа и буквальных \\n/\\r; файл не создан.",
    );
  return contents;
}

async function hiddenQuestion(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function")
    throw new Error(
      "Для скрытого ввода пароля откройте Setup-Windows.cmd в обычном терминале.",
    );
  process.stdout.write(prompt);
  emitKeypressEvents(process.stdin);
  const previousRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return await new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(previousRaw);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onKey = (text, key = {}) => {
      if (key.ctrl && key.name === "c")
        return finish(new Error("Подготовка отменена."));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") value = [...value].slice(0, -1).join("");
      else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text))
        value += text;
    };
    process.stdin.on("keypress", onKey);
  });
}

async function setupEnvironment(root) {
  const filename = path.join(root, ".env");
  if (existsSync(filename)) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      ".env отсутствует. Запустите Setup-Windows.cmd в интерактивном терминале для создания администратора.",
    );
  console.log(
    "Первоначальная настройка. Пароли не отображаются и не отправляются в интернет.",
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let email, name;
  try {
    email = await rl.question("Email администратора: ");
    name = await rl.question("Имя администратора: ");
  } finally {
    rl.close();
  }
  const password = await hiddenQuestion(
    "Пароль администратора (12–256 символов): ",
  );
  const confirmation = await hiddenQuestion("Повторите пароль: ");
  if (password !== confirmation)
    throw new Error("Пароли не совпали. Повторите Setup.");
  const contents = createEnvironment({ email, name, password });
  writeFileSync(filename, contents, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    ".env создан. Сохраните выбранные данные входа в надёжном месте.",
  );
}

function redact(line, config) {
  for (const value of [
    config.DATABASE_URL,
    config.POSTGRES_PASSWORD,
    config.ADMIN_PASSWORD,
    encodeURIComponent(config.POSTGRES_PASSWORD),
    encodeURIComponent(config.ADMIN_PASSWORD),
  ].sort((a, b) => b.length - a.length))
    if (value) line = line.split(value).join("[скрыто]");
  return line;
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.root,
      env: options.env,
      shell: false,
      windowsHide: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines = [];
    for (const [stream, output] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      const reader = createInterface({ input: stream });
      reader.on("line", (line) =>
        output.write(redact(line, options.config) + "\n"),
      );
      lines.push(reader);
    }
    // Windows does not forward POSIX signals identically. child.kill is the Node
    // cross-platform termination API; database remains running in Docker.
    const stop = () => {
      options.stopped = true;
      child.kill("SIGTERM");
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    child.on("error", (error) => {
      cleanup();
      reject(
        new Error(
          `Не удалось запустить ${path.basename(command)} (${error.code || "ошибка"}). Проверьте установку Node.js и Docker Desktop.`,
        ),
      );
    });
    child.on("close", (code) => {
      cleanup();
      if (options.stopped)
        reject(new Error("Сервер остановлен. Данные PostgreSQL сохранены."));
      else if (code === 0) resolve();
      else
        reject(
          new Error(
            `${path.basename(command)} завершился с кодом ${code}. См. сообщение выше.`,
          ),
        );
    });
    function cleanup() {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      for (const reader of lines) reader.close();
    }
  });
}

export function npmInstallCommand(
  platform = process.platform,
  comspec = process.env.ComSpec ||
    process.env.COMSPEC ||
    "C:\\Windows\\System32\\cmd.exe",
) {
  // npm.cmd cannot be spawned directly on Windows. The command text is fixed:
  // no user input, paths, or environment values are concatenated into shell code.
  return platform === "win32"
    ? [comspec, ["/d", "/s", "/c", "npm.cmd ci"]]
    : ["npm", ["ci"]];
}

async function portAvailable(port) {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) =>
      error.code === "EADDRINUSE"
        ? resolve(false)
        : reject(
            new Error(`Не удалось проверить порт ${port} (${error.code}).`),
          ),
    );
    server.listen({ port, host: "127.0.0.1" }, () =>
      server.close(() => resolve(true)),
    );
  });
}

export async function isCrmHealthy(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
      redirect: "error",
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("application/json")
    )
      return false;
    const body = await response.json();
    return body?.service === "sto-crm" && body?.status === "ok";
  } catch {
    return false;
  }
}

function openBrowser(origin) {
  // URL has already passed strict localhost validation; no shell is used.
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", origin]]
      : process.platform === "darwin"
        ? ["open", [origin]]
        : ["xdg-open", [origin]];
  const child = spawn(command, args, {
    shell: false,
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => console.log(`Откройте браузер вручную: ${origin}`));
  child.unref();
}

export async function resolveLocalSchemaEngine(root) {
  try {
    const { default: platform } = await import(
      pathToFileURL(
        path.join(root, "node_modules/@prisma/get-platform/dist/index.js"),
      ).href
    );
    const target = await platform.getBinaryTargetForCurrentPlatform();
    const binary = path.join(
      root,
      `node_modules/@prisma/engines/schema-engine-${target}${process.platform === "win32" ? ".exe" : ""}`,
    );
    if (!existsSync(binary)) throw new Error("missing");
    return binary;
  } catch {
    throw new Error(
      "Локальный движок Prisma не найден. Выполните Setup-Windows.cmd с интернетом; автономная загрузка запрещена.",
    );
  }
}

export async function main(args = process.argv.slice(2), root = projectRoot) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return;
  }
  const [mode, ...flags] = args;
  if (
    !["setup", "start"].includes(mode) ||
    flags.some((flag) => flag !== "--no-open")
  )
    throw new Error(usage);
  validateNode();
  if (mode === "setup") await setupEnvironment(root);
  if (!existsSync(path.join(root, ".env")))
    throw new Error(".env отсутствует. Сначала запустите Setup-Windows.cmd.");
  const settings = parseConfiguration(
    readFileSync(path.join(root, ".env"), "utf8"),
  );
  const { config, port, origin } = settings;
  const env = {
    ...process.env,
    ...config,
    APP_ORIGIN: origin,
    NEXT_TELEMETRY_DISABLED: "1",
    PRISMA_HIDE_UPDATE_MESSAGE: "1",
    CHECKPOINT_DISABLE: "1",
  };
  const options = { root, env, config, stopped: false };
  const local = (relative) => path.join(root, relative);
  const prepareEngine = async () => {
    env.PRISMA_SCHEMA_ENGINE_BINARY = await resolveLocalSchemaEngine(root);
  };
  const prisma = () =>
    run(
      process.execPath,
      [local("node_modules/prisma/build/index.js"), "migrate", "deploy"],
      options,
    );
  if (mode === "start") {
    if (!(await portAvailable(port))) {
      if (!(await isCrmHealthy(port)))
        throw new Error(
          `Порт ${port} занят другим сервисом или CRM ещё не готова. Освободите порт или измените APP_ORIGIN в .env. Браузер не открыт.`,
        );
      console.log(`CRM уже работает: ${origin}`);
      if (!flags.includes("--no-open")) openBrowser(origin);
      return;
    }
    for (const filename of [
      "node_modules/next/dist/bin/next",
      "node_modules/prisma/build/index.js",
      ".next/BUILD_ID",
    ])
      if (!existsSync(local(filename)))
        throw new Error(
          "Готовая production-сборка не найдена. Сначала выполните Setup-Windows.cmd с интернетом.",
        );
  }
  if (mode === "start") await prepareEngine();
  // Explicit empty env-file prevents Compose interpolation of secrets containing $.
  const temporary = mkdtempSync(path.join(tmpdir(), "sto-crm-compose-"));
  const emptyEnv = path.join(temporary, "empty.env");
  writeFileSync(emptyEnv, "", { mode: 0o600 });
  const docker = (args) =>
    run(
      "docker",
      ["compose", "--env-file", emptyEnv, "-f", local("compose.yaml"), ...args],
      options,
    );
  try {
    console.log("Проверка Docker Desktop и Compose…");
    await docker(["version"]);
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], options);
    if (mode === "setup") {
      console.log("Установка закреплённых зависимостей (нужен интернет)…");
      const [command, npmArgs] = npmInstallCommand();
      await run(command, npmArgs, options);
      console.log("Загрузка образа PostgreSQL (нужен интернет)…");
      await docker(["pull", "db"]);
    }
    console.log("Запуск локальной PostgreSQL без загрузок…");
    await docker(["up", "-d", "--pull", "never", "--no-build", "--wait", "db"]);
    console.log("Проверка и применение локальных миграций…");
    await prepareEngine();
    await prisma();
    if (mode === "setup") {
      await run(
        process.execPath,
        [local("node_modules/tsx/dist/cli.mjs"), local("prisma/seed.ts")],
        options,
      );
      await run(
        process.execPath,
        [local("node_modules/next/dist/bin/next"), "build"],
        options,
      );
      console.log(
        "Подготовка завершена. Запустите Start-Windows.cmd. Интернет для обычного запуска не нужен.",
      );
      return;
    }
    console.log(`Запуск CRM: ${origin}. Остановка: Ctrl+C.`);
    let done = false;
    const server = run(
      process.execPath,
      [
        local("node_modules/next/dist/bin/next"),
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      options,
    ).finally(() => {
      done = true;
    });
    // Attach rejection handling immediately while readiness is being polled.
    let failure;
    server.catch((error) => {
      failure = error;
    });
    const deadline = Date.now() + 90_000;
    let healthy = false;
    while (!done && Date.now() < deadline) {
      if (await isCrmHealthy(port)) {
        healthy = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (healthy) {
      console.log(`CRM готова: ${origin}`);
      if (!flags.includes("--no-open")) openBrowser(origin);
    } else if (!done)
      console.error(
        "За 90 секунд CRM не подтвердила готовность. Проверьте сообщения сервера; браузер не открыт. Ctrl+C — остановить.",
      );
    await server;
    if (failure) throw failure;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
