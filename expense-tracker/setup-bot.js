/*
 * Одноразовая настройка Telegram-бота: делает так, чтобы кнопка меню бота
 * открывала это Mini App, и добавляет команду /start.
 *
 * Запуск:
 *   BOT_TOKEN=123:ABC WEBAPP_URL=https://ваш-домен node setup-bot.js
 */

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;

if (!BOT_TOKEN || !WEBAPP_URL) {
  console.error("Нужны переменные BOT_TOKEN и WEBAPP_URL.");
  console.error("Пример: BOT_TOKEN=123:ABC WEBAPP_URL=https://app.example.com node setup-bot.js");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function call(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`${method} → ${json.description || res.status}`);
  }
  return json.result;
}

async function main() {
  // 1) Кнопка меню открывает Mini App.
  await call("setChatMenuButton", {
    menu_button: {
      type: "web_app",
      text: "💰 Расходы",
      web_app: { url: WEBAPP_URL },
    },
  });
  console.log("✓ Кнопка меню настроена на Mini App");

  // 2) Команда /start в списке команд.
  await call("setMyCommands", {
    commands: [{ command: "start", description: "Открыть учёт расходов" }],
  });
  console.log("✓ Команда /start добавлена");

  console.log("\nГотово. Откройте бота в Telegram и нажмите кнопку меню.");
}

main().catch((err) => {
  console.error("Ошибка:", err.message);
  process.exit(1);
});
