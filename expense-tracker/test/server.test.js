import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// Для проверки подписи модуль читает BOT_TOKEN при импорте.
process.env.BOT_TOKEN = "12345:TEST-TOKEN";
process.env.MAX_AUTH_AGE = "0"; // отключаем проверку возраста в тестах

const { validateInitData, sanitizeExpense } = await import("../server.js");

function buildInitData(botToken, user, extra = {}) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify(user),
    ...extra,
  });
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

test("validateInitData принимает корректную подпись", () => {
  const user = { id: 42, first_name: "Тест" };
  const initData = buildInitData("12345:TEST-TOKEN", user);
  const result = validateInitData(initData);
  assert.ok(result);
  assert.equal(result.id, 42);
});

test("validateInitData отклоняет подделанную подпись", () => {
  const user = { id: 42, first_name: "Тест" };
  const initData = buildInitData("другой-токен", user);
  assert.equal(validateInitData(initData), null);
});

test("validateInitData отклоняет пустые данные", () => {
  assert.equal(validateInitData(""), null);
  assert.equal(validateInitData(null), null);
});

test("sanitizeExpense отвергает неположительную сумму", () => {
  assert.ok(sanitizeExpense({ amount: 0 }).error);
  assert.ok(sanitizeExpense({ amount: -5 }).error);
  assert.ok(sanitizeExpense({ amount: "abc" }).error);
});

test("sanitizeExpense нормализует корректный расход", () => {
  const { value, error } = sanitizeExpense({
    amount: "199.999",
    category: "Еда",
    note: "  кофе  ",
    date: "2026-07-14",
  });
  assert.equal(error, undefined);
  assert.equal(value.amount, 200);
  assert.equal(value.category, "Еда");
  assert.equal(value.note, "кофе");
  assert.equal(value.date, "2026-07-14");
});

test("sanitizeExpense подставляет сегодняшнюю дату при некорректной", () => {
  const { value } = sanitizeExpense({ amount: 10, date: "не-дата" });
  assert.match(value.date, /^\d{4}-\d{2}-\d{2}$/);
});
