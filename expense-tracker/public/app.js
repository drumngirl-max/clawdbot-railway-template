/* Telegram Mini App — учёт расходов (без внешних зависимостей). */

const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

// initData передаётся серверу для проверки подписи.
const INIT_DATA = tg ? tg.initData : "";

let currency = "₽";

// --- Тема Telegram -> CSS-переменные -----------------------------------------
function applyTheme() {
  if (!tg) return;
  const p = tg.themeParams || {};
  const root = document.documentElement.style;
  const map = {
    "--bg": p.bg_color,
    "--secondary-bg": p.secondary_bg_color,
    "--text": p.text_color,
    "--hint": p.hint_color,
    "--link": p.link_color,
    "--button": p.button_color,
    "--button-text": p.button_text_color,
    "--destructive": p.destructive_text_color,
  };
  for (const [k, v] of Object.entries(map)) {
    if (v) root.setProperty(k, v);
  }
  if (p.bg_color) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", p.bg_color);
  }
}

// --- Работа с API ------------------------------------------------------------
async function api(pathname, options = {}) {
  const res = await fetch(pathname, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: "tma " + INIT_DATA,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    let msg = "Ошибка запроса";
    try {
      const j = await res.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

function fmtMoney(n) {
  const value = Number(n || 0);
  const str = value % 1 === 0 ? value.toLocaleString("ru-RU") : value.toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return str + " " + currency;
}

function fmtDate(iso) {
  // iso = YYYY-MM-DD
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function toast(text) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 2500);
}

function haptic(type) {
  try {
    if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred(type);
  } catch {}
}

// --- Рендеринг ---------------------------------------------------------------
function renderSummary(s) {
  document.getElementById("totalToday").textContent = fmtMoney(s.today);
  document.getElementById("totalMonth").textContent = fmtMoney(s.month);

  const section = document.getElementById("chartSection");
  const bars = document.getElementById("bars");
  bars.innerHTML = "";

  if (!s.categories || s.categories.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const max = Math.max(...s.categories.map((c) => c.amount)) || 1;
  for (const c of s.categories) {
    const row = document.createElement("div");
    row.className = "bar-row";

    const head = document.createElement("div");
    head.className = "bar-head";
    const cat = document.createElement("span");
    cat.className = "cat";
    cat.textContent = c.category;
    const val = document.createElement("span");
    val.className = "val";
    val.textContent = fmtMoney(c.amount);
    head.append(cat, val);

    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = Math.max(4, (c.amount / max) * 100) + "%";
    track.append(fill);

    row.append(head, track);
    bars.append(row);
  }
}

function renderExpenses(list) {
  const wrap = document.getElementById("expenses");
  const empty = document.getElementById("empty");
  wrap.innerHTML = "";

  if (!list || list.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  for (const e of list) {
    const item = document.createElement("div");
    item.className = "expense";

    const main = document.createElement("div");
    main.className = "expense-main";

    const top = document.createElement("div");
    top.className = "expense-top";
    const catEl = document.createElement("span");
    catEl.className = "expense-cat";
    catEl.textContent = e.category;
    const amountEl = document.createElement("span");
    amountEl.className = "expense-amount";
    amountEl.textContent = fmtMoney(e.amount);
    top.append(catEl, amountEl);

    const sub = document.createElement("div");
    sub.className = "expense-sub";
    sub.textContent = fmtDate(e.date) + (e.note ? " · " + e.note : "");

    main.append(top, sub);

    const del = document.createElement("button");
    del.className = "expense-del";
    del.type = "button";
    del.setAttribute("aria-label", "Удалить");
    del.textContent = "×";
    del.addEventListener("click", () => removeExpense(e.id));

    item.append(main, del);
    wrap.append(item);
  }
}

// --- Действия ----------------------------------------------------------------
async function refresh() {
  try {
    const [summary, expenses] = await Promise.all([
      api("/api/summary"),
      api("/api/expenses"),
    ]);
    currency = summary.currency || currency;
    renderSummary(summary);
    renderExpenses(expenses.expenses);
  } catch (err) {
    toast(err.message);
  }
}

async function addExpense(evt) {
  evt.preventDefault();
  const btn = document.getElementById("submitBtn");
  const amount = document.getElementById("amount").value;
  const category = document.getElementById("category").value;
  const note = document.getElementById("note").value;
  const date = document.getElementById("date").value;

  if (!amount || Number(amount) <= 0) {
    toast("Введите сумму больше нуля");
    return;
  }

  btn.disabled = true;
  try {
    await api("/api/expenses", {
      method: "POST",
      body: JSON.stringify({ amount, category, note, date }),
    });
    document.getElementById("amount").value = "";
    document.getElementById("note").value = "";
    haptic("success");
    await refresh();
  } catch (err) {
    haptic("error");
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function removeExpense(id) {
  const doDelete = async () => {
    try {
      await api("/api/expenses/" + encodeURIComponent(id), { method: "DELETE" });
      haptic("success");
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  };

  if (tg && tg.showConfirm) {
    tg.showConfirm("Удалить эту запись?", (ok) => {
      if (ok) doDelete();
    });
  } else if (confirm("Удалить эту запись?")) {
    doDelete();
  }
}

// --- Инициализация -----------------------------------------------------------
async function init() {
  if (tg) {
    tg.ready();
    tg.expand();
    applyTheme();
    tg.onEvent("themeChanged", applyTheme);
  }

  // Дата по умолчанию — сегодня.
  document.getElementById("date").value = new Date().toISOString().slice(0, 10);

  // Загрузка конфигурации (валюта, категории).
  try {
    const cfg = await api("/api/config");
    currency = cfg.currency || currency;
    document.getElementById("currencyLabel").textContent = currency;
    const sel = document.getElementById("category");
    for (const c of cfg.categories || []) {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      sel.append(opt);
    }
  } catch (err) {
    toast(err.message);
  }

  document.getElementById("addForm").addEventListener("submit", addExpense);
  await refresh();
}

init();
