# 🎯 Chatshouse Admin System

Система мониторинга качества работы операторов дейтинг-платформы [chatshouse.com](https://chatshouse.com) с AI-анализом диалогов через Claude.

🔗 **Admin Panel (live):** https://chatshouse-admin-production.up.railway.app/panel/  
🔑 **Admin Secret:** `chatshouse_admin_2024`

---

## 🏗️ Архитектура

```
┌─────────────────────────────────────────────────────────┐
│  Chrome Extension (устанавливается каждому сотруднику)  │
│  Отслеживает все профили девушек + диалоги + письма     │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTP + WebSocket
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Backend Server (Railway)                               │
│  Node.js + SQLite + WebSocket + Claude AI (MWAPI)       │
│  https://chatshouse-admin-production.up.railway.app     │
└──────────┬──────────────────────────────────────────────┘
           │ WebSocket (live updates)
           ▼
┌─────────────────────────────────────────────────────────┐
│  Admin Panel (браузер руководителя)                     │
│  /panel/ — Workers, Online, Dialogs, Mails, Alerts     │
└─────────────────────────────────────────────────────────┘
```

**Ключевая концепция:** 1 сотрудник → управляет 5–15 профилями девушек → у каждой свои диалоги с мужчинами.

---

## 🚀 Быстрый старт

### Admin Panel (уже развёрнута на Railway)
Просто открой: https://chatshouse-admin-production.up.railway.app/panel/
- Backend URL: уже заполнен
- Admin Secret: `chatshouse_admin_2024`

### Chrome Extension (для каждого сотрудника)
1. Скопируй папку `extension/` на компьютер сотрудника
2. Chrome → `chrome://extensions/`
3. Включи **Developer mode** (верхний правый угол)
4. **Load unpacked** → выбери папку `extension`
5. Нажми иконку расширения → впиши имя сотрудника → Save
6. Открой chatshouse.com — данные пойдут в панель автоматически

### Запуск локально (для разработки)
```bash
cd backend
npm install
# создай .env с ключами (см. .env.example)
node server.js
# Admin Panel: http://localhost:4000/panel
```

---

## 📁 Структура проекта

```
chatshouse-admin/
├── backend/                    # Node.js сервер
│   ├── server.js               # Основной сервер (Express + WebSocket + Claude AI)
│   ├── package.json            # Зависимости
│   ├── railway.toml            # Конфиг деплоя Railway
│   ├── .gitignore
│   └── panel/                  # Admin Panel (копия для Railway)
│       └── index.html
├── extension/                  # Chrome Extension
│   ├── manifest.json           # Манифест (Manifest V3)
│   ├── background.js           # Service Worker — WebSocket, sync, уведомления
│   ├── content.js              # Контент-скрипт — перехват API, overlay
│   ├── popup.html              # Попап расширения (имя сотрудника, статус)
│   ├── popup.js                # Логика попапа
│   └── icons/                  # Иконки расширения
├── panel/                      # Admin Panel (локальная версия)
│   └── index.html
└── README.md                   # Этот файл
```

---

## 🔧 Переменные окружения (backend/.env)

```env
ANTHROPIC_API_KEY=sk-...        # API ключ Claude (через MWAPI провайдер)
ANTHROPIC_BASE_URL=https://api.mwapi.dev  # Прокси провайдер
CLAUDE_MODEL=claude-haiku-4-5-20251001    # Модель Claude
ADMIN_SECRET=chatshouse_admin_2024        # Пароль для Admin Panel
PORT=4000                                  # Порт сервера
```

---

## 🤖 AI Score модель (Claude Haiku через MWAPI)

Анализирует каждый диалог и возвращает JSON:
```json
{
  "score": 72,
  "comment": "Good engagement but uses some template phrases",
  "tips": [
    "Ask more personal questions about his interests",
    "Avoid generic openers like 'Hello love'",
    "Maintain flirty tone when he is online"
  ],
  "issues": ["template_message", "slow_response"]
}
```

**Критерии оценки:**
| Score | Grade | Описание |
|-------|-------|----------|
| 90–100 | A | Отличная персонализация, флирт, живой диалог |
| 75–89 | B | Хорошее качество, в основном персонализировано |
| 55–74 | C | Среднее, есть шаблоны |
| 35–54 | D | Плохое качество, много шаблонов |
| 0–34 | F | Игнорирование сообщений или полный шаблон |

---

## 🔔 Система алертов

Автоматические алерты (каждые 2 минуты):

| Тип | Условие | Severity |
|-----|---------|----------|
| `online_waiting` | Мужчина онлайн, нет ответа >5 мин | 🔴 High |
| `slow_response` | Нет ответа >30 мин | 🟡 Medium |

Алерты отправляются:
- В Chrome-уведомление на компьютере сотрудника
- В overlay на странице chatshouse.com
- В Admin Panel → Alerts раздел

---

## 📊 Admin Panel — разделы

| Раздел | Описание |
|--------|----------|
| **Dashboard** | Общая статистика: workers online, profiles, dialogs, men online, alerts |
| **Workers** | Карточки каждого сотрудника с его профилями, AI score, алертами |
| **Online Monitor** | Все онлайн-мужчины в реальном времени, сортировка по срочности |
| **Dialogs** | Все диалоги с AI score, фильтры по worker/profile/score/status |
| **Mails** | Мониторинг писем (вкладка Letters) по всем профилям |
| **Alerts** | Все автоматические уведомления с фильтрами |

---

## 🧩 Chrome Extension — функции

**Overlay на странице chatshouse.com:**
- 🔴 **Urgent** — мужчина онлайн и ждёт >3 мин, с бейджем профиля `[Svitlana]`
- 💬 **Dialogs** — все активные диалоги по всем профилям сотрудника
- 💡 **AI Tips** — советы Claude после анализа конкретного диалога
- ✉️ **Mails** — непрочитанные письма по всем профилям

**Уведомления Chrome:**
- Появляются при высоко-приоритетных алертах
- Требуют подтверждения (не исчезают автоматически)

**Попап расширения:**
- Показывает статистику только этого сотрудника
- Имя сотрудника (настраивается)
- Статус подключения к backend

---

## 🗄️ База данных (SQLite)

| Таблица | Описание |
|---------|----------|
| `workers` | Сотрудники (ID генерируется в браузере, сохраняется в localStorage) |
| `profiles` | Профили девушек (ulid с сайта → worker_id) |
| `dialogs` | Диалоги (id, profile_ulid, worker_id, ai_score, ai_comment, ai_tips) |
| `messages` | Сообщения (id, profile_ulid, contact_ulid, body, is_incoming) |
| `mails` | Письма (аналогично dialogs) |
| `alerts` | Алерты (worker_id, profile_name, contact_name, severity) |
| `events` | Лог событий (открытие диалогов и т.д.) |

---

## 🌐 API эндпоинты (Backend)

### Extension → Backend
| Метод | URL | Описание |
|-------|-----|----------|
| POST | `/api/sync` | Синхронизация всех профилей и диалогов сотрудника |
| POST | `/api/messages` | Добавление сообщений диалога |
| POST | `/api/event` | Лог события (открытие диалога и т.д.) |
| POST | `/api/offline` | Пометить сотрудника офлайн |

### Admin Panel → Backend
| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/api/admin/state` | Полное состояние (workers, profiles, dialogs, alerts) |
| GET | `/api/admin/messages/:profileUlid/:contactUlid` | Сообщения диалога |
| GET | `/api/admin/mails` | Письма |
| GET | `/api/admin/alerts` | Алерты |
| POST | `/api/admin/alerts/read` | Пометить алерты прочитанными |
| POST | `/api/admin/analyze` | Запустить AI анализ диалога |
| GET | `/health` | Статус сервера |

### WebSocket события
| Событие | Направление | Описание |
|---------|-------------|----------|
| `auth_admin` | Client → Server | Аутентификация admin |
| `auth_worker` | Client → Server | Аутентификация сотрудника |
| `initial_data` | Server → Admin | Начальное состояние при подключении |
| `sync_update` | Server → Admin | Обновление при синхронизации extension |
| `new_alert` | Server → All | Новый алерт |
| `ai_score_updated` | Server → All | Результат AI анализа |
| `ai_tips` | Server → Worker | Советы AI для конкретного сотрудника |
| `notification` | Server → Worker | Уведомление (онлайн-ожидание и т.д.) |
| `worker_offline` | Server → Admin | Сотрудник вышел офлайн |

---

## 🚂 Деплой на Railway

Проект задеплоен на Railway:
- **URL:** https://chatshouse-admin-production.up.railway.app
- **Project ID:** fb44b4b6-cc26-4400-b279-1c865a5b6ee4
- **Service ID:** b52202b8-2449-4c48-9804-f90b0f13ea0c

Редеплой после изменений:
```bash
cd backend
/Users/work/.railway/bin/railway up --service b52202b8-2449-4c48-9804-f90b0f13ea0c
```

Railway переменные окружения (уже настроены):
- `ANTHROPIC_API_KEY` — ключ Claude AI
- `ANTHROPIC_BASE_URL` — `https://api.mwapi.dev`
- `CLAUDE_MODEL` — `claude-haiku-4-5-20251001`
- `ADMIN_SECRET` — `chatshouse_admin_2024`

---

## 🔑 Как работает идентификация сотрудников

Расширение генерирует уникальный ID сотрудника при первой установке:
```javascript
// Сохраняется в localStorage браузера
id = 'w_' + Date.now().toString(36) + '_' + Math.random().toString(36)
```

Этот ID привязывается ко всем профилям которые открывает сотрудник. Имя сотрудника задаётся вручную в popup расширения.

---

## 📝 Заметки по разработке

### Как chatshouse.com определяет активный профиль
Сайт использует параметр `x_ulid` в URL: `/dialogs?x_ulid=01J56Z307XW1D7XZGRF4N4TZE6`
Extension перехватывает этот параметр чтобы знать какой профиль активен.

### Почему нет прямого CORS-доступа
API chatshouse.com (`api.chatshouse.com`) разрешает запросы только с `https://chatshouse.com`. Extension обходит это через `credentials: 'include'` в том же браузере.

### AI анализ запускается автоматически когда
- В диалоге накопилось 5+ сообщений
- Прошло >5 минут с последнего анализа
- Вручную через кнопку "Analyze with AI" в Admin Panel

### Модель claude-haiku-4-5-20251001 через MWAPI
MWAPI (api.mwapi.dev) — провайдер-прокси для Claude API. Доступные модели:
- `claude-haiku-4-5-20251001` ← используется (быстрая, дешёвая)
- `claude-sonnet-5-5` (точнее, дороже)
- `claude-opus-4-8` (самая умная)

---

## ✅ Текущий статус

- [x] Backend запущен на Railway
- [x] Admin Panel доступна публично
- [x] Chrome Extension готов к установке
- [x] Claude AI анализ работает
- [x] WebSocket live-обновления
- [x] Алерты (online waiting, slow response)
- [x] Мониторинг Letters/Mails
- [ ] Persistent storage (Railway Volume) — данные сбрасываются при редеплое
- [ ] Авторизация сотрудников (сейчас ID генерируется автоматически)
