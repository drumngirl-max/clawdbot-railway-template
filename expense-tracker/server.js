import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Конфигурация (через переменные окружения) -----------------------------
const PORT = Number(process.env.PORT) || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CURRENCY = process.env.CURRENCY || "₽";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "expenses.json");
// Для локальной разработки без Telegram: разрешить фейкового пользователя.
const ALLOW_INSECURE_DEV = process.env.ALLOW_INSECURE_DEV === "1";
// Максимальный возраст initData (защита от повторов), сек. 0 = без проверки.
const MAX_AUTH_AGE = Number(process.env.MAX_AUTH_AGE ?? 86400);

if (!BOT_TOKEN && !ALLOW_INSECURE_DEV) {
  console.warn(
    "[warn] BOT_TOKEN не задан. Запросы из Telegram не пройдут проверку.\n" +
      "       Для локального теста запустите с ALLOW_INSECURE_DEV=1."
  );
}

// ---- Хранилище (JSON-файл) --------------------------------------------------
// Формат: { "<userId>": [ {id, amount, category, note, date, createdAt}, ... ] }
let store = {};
// Простая очередь записи, чтобы избежать гонок при одновременных запросах.
let writeChain = Promise.resolve();

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadStore() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    store = JSON.parse(raw) || {};
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("[store] не удалось прочитать данные, начинаю с пустого:", err.message);
    }
    store = {};
  }
}

function persist() {
  // Сериализуем текущее состояние и атомарно записываем во временный файл.
  const snapshot = JSON.stringify(store, null, 2);
  writeChain = writeChain.then(async () => {
    ensureDataDir();
    const tmp = DATA_FILE + ".tmp";
    await fsp.writeFile(tmp, snapshot, "utf8");
    await fsp.rename(tmp, DATA_FILE);
  });
  return writeChain;
}

// ---- Проверка подписи Telegram initData ------------------------------------
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function validateInitData(initData) {
  if (!initData || typeof initData !== "string") return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => [k, v])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const computed = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  // Сравнение с защитой от timing-атак.
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  if (MAX_AUTH_AGE > 0) {
    const authDate = Number(params.get("auth_date")) || 0;
    const age = Math.floor(Date.now() / 1000) - authDate;
    if (age > MAX_AUTH_AGE) return null;
  }

  const userRaw = params.get("user");
  if (!userRaw) return null;
  try {
    return JSON.parse(userRaw);
  } catch {
    return null;
  }
}

// ---- Middleware авторизации -------------------------------------------------
// Клиент присылает initData в заголовке: Authorization: tma <initData>
function auth(req, res, next) {
  const header = req.get("authorization") || "";
  const initData = header.startsWith("tma ") ? header.slice(4) : "";

  if (BOT_TOKEN) {
    const user = validateInitData(initData);
    if (!user || !user.id) {
      return res.status(401).json({ error: "Не удалось проверить подпись Telegram" });
    }
    req.userId = String(user.id);
    req.user = user;
    return next();
  }

  if (ALLOW_INSECURE_DEV) {
    req.userId = "dev-user";
    req.user = { id: "dev-user", first_name: "Dev" };
    return next();
  }

  return res.status(500).json({ error: "Сервер не настроен: отсутствует BOT_TOKEN" });
}

// ---- Валидация и работа с расходами -----------------------------------------
function userExpenses(userId) {
  if (!Array.isArray(store[userId])) store[userId] = [];
  return store[userId];
}

const KNOWN_CATEGORIES = [
  "Еда",
  "Транспорт",
  "Жильё",
  "Развлечения",
  "Здоровье",
  "Покупки",
  "Связь",
  "Другое",
];

function sanitizeExpense(body) {
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: "Сумма должна быть положительным числом" };
  }
  const category = String(body.category || "Другое").slice(0, 40).trim() || "Другое";
  const note = String(body.note || "").slice(0, 200).trim();
  // Дата в формате YYYY-MM-DD; по умолчанию — сегодня.
  let date = String(body.date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    date = new Date().toISOString().slice(0, 10);
  }
  return {
    value: {
      amount: Math.round(amount * 100) / 100,
      category,
      note,
      date,
    },
  };
}

// ---- Приложение -------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "64kb" }));

// Служебный эндпоинт для проверки живости.
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Конфиг для фронтенда (валюта, категории).
app.get("/api/config", (_req, res) => {
  res.json({ currency: CURRENCY, categories: KNOWN_CATEGORIES });
});

// Список расходов пользователя (по убыванию даты).
app.get("/api/expenses", auth, (req, res) => {
  const list = userExpenses(req.userId)
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
  res.json({ expenses: list, currency: CURRENCY });
});

// Сводка: сегодня, за месяц, по категориям за текущий месяц.
app.get("/api/summary", auth, (req, res) => {
  const list = userExpenses(req.userId);
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  let totalToday = 0;
  let totalMonth = 0;
  const byCategory = {};

  for (const e of list) {
    if (e.date === today) totalToday += e.amount;
    if (e.date.startsWith(month)) {
      totalMonth += e.amount;
      byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
    }
  }

  const categories = Object.entries(byCategory)
    .map(([category, amount]) => ({ category, amount: Math.round(amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount);

  res.json({
    currency: CURRENCY,
    today: Math.round(totalToday * 100) / 100,
    month: Math.round(totalMonth * 100) / 100,
    monthLabel: month,
    categories,
  });
});

// Добавить расход.
app.post("/api/expenses", auth, async (req, res) => {
  const parsed = sanitizeExpense(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const expense = {
    id: crypto.randomUUID(),
    ...parsed.value,
    createdAt: Date.now(),
  };
  userExpenses(req.userId).push(expense);
  await persist();
  res.status(201).json({ expense });
});

// Удалить расход по id.
app.delete("/api/expenses/:id", auth, async (req, res) => {
  const list = userExpenses(req.userId);
  const idx = list.findIndex((e) => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Расход не найден" });
  list.splice(idx, 1);
  await persist();
  res.json({ ok: true });
});

// Статика Mini App.
app.use(express.static(path.join(__dirname, "public")));

// ---- Запуск -----------------------------------------------------------------
// Слушатель поднимаем только при прямом запуске файла, а не при импорте
// (например, из тестов).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  loadStore();
  app.listen(PORT, () => {
    console.log(`Expense Tracker Mini App слушает на порту ${PORT}`);
    console.log(`Данные: ${DATA_FILE}`);
    if (ALLOW_INSECURE_DEV && !BOT_TOKEN) {
      console.log("Режим разработки: авторизация отключена (ALLOW_INSECURE_DEV=1)");
    }
  });
}

// Экспорт для тестов.
export { validateInitData, sanitizeExpense };
