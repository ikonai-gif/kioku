# CLAUDE.md — KIOKU / IKONBAI Project Context
> Читается автоматически при каждом старте Claude Code. Не удалять.

---

## 🏗️ Архитектура проекта

### Репозитории
| Репо | Назначение |
|------|-----------|
| `ikonai-gif/kioku` | Основной backend + API |
| `ikonai-gif/ikonbai-v2` | Бизнес-логика, агенты, Stripe |
| `ikonai-gif/ikonbai-dashboard` | Dashboard UI (React, rest-express v9) |
| `ikonai-gif/ikonbai-client` | Mobile app (Capacitor 6, iOS/Android) |

### Стек
- **Backend:** Node.js, Express 5, TypeScript, PostgreSQL, Redis
- **Frontend:** React, Vite, Tailwind CSS
- **Mobile:** Capacitor 6 (iOS + Android)
- **AI Agents:** Anthropic Claude API, Retell AI (voice)
- **Payments:** Stripe Connect Express
- **Infra:** Railway, Supabase, Sentry, Pino logging

---

## 🤖 AI Агенты

### NIKA — Администратор
- Управляет записями, расписанием, клиентами
- Голосовые звонки через Retell AI
- Intent Router → маршрутизация запросов

### LUMA — Маркетолог
- Email кампании + автоматизации + сегменты
- WhatsApp, SMS рассылки
- SEO страницы
- IKON Boost кампании
- **Планируется:** таргетинг FB/Instagram/Google Ads

### REMI — Финансовый аналитик
- Выручка по периодам
- Stripe Connect выплаты мастерам
- **Планируется:** реальный P&L, LTV клиентов, прогноз выручки

---

## 📋 Правила работы с кодом

### ❗️ Никогда не трогать без явного разрешения
- `server/middleware/auth.ts` — авторизация
- `server/stripe/` — платёжная логика
- `migrations/` — БД миграции (только через отдельную задачу)
- `.env` файлы

### ✅ Стиль кода
- TypeScript строгий (`strict: true`)
- Async/await везде (не .then/.catch)
- Именование: camelCase для переменных, PascalCase для компонентов
- Комментарии на английском

### 🔄 Git workflow
- Ветки: `feature/`, `fix/`, `chore/`
- Коммиты: `feat:`, `fix:`, `chore:` префиксы
- Всегда запускать тесты перед коммитом: `npm test`

---

## 🚀 Запуск проекта

```bash
# Backend
cd server
npm install
npm run dev

# Dashboard
cd ikonbai-dashboard
npm install
npm run dev

# Mobile (iOS)
cd ikonbai-client
npm install
npx cap open ios
```

---

## 🎯 Текущие приоритеты (май 2026)

1. 🔴 Kanban-борд записей — рабочая доска для мастеров
2. 🔴 Client view toggle — переключение борда в режим клиента
3. 🟡 UI магазина дропшиппинга — backend уже готов (/api/store/)
4. 🟡 Реальные данные Remi — починить /api/boss/pulse (сейчас random)
5. 🟡 Таргетинг для Luma — FB/Instagram/Google Ads интеграция
6. 🟢 Audit log — migration 014

---

## 💡 Claude Code — правила сессии

1. **Сначала Plan Mode** (Shift+Tab) — покажи план, жди апрув
2. **Один шаг за раз** — не делай всё сразу
3. **После каждого изменения** — запусти тесты
4. **Если не уверен** — спроси, не угадывай
5. **Контекст заканчивается** — /compact когда много наговорили

---

*Обновлено: май 2026 | Luca (KIOKU AI Partner)*

---
