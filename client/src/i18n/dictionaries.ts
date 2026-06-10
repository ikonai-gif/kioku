/**
 * i18n dictionaries (PR-B1, LUCA-053). ru + en only.
 * Keys are NAMESPACED to avoid collisions (BRO4 M1): area.element.
 * Add new screens incrementally (PR-B2+). Missing keys fall back to [key]
 * (BRO4 M2) so gaps are visible in dev, never silent empty strings.
 */
export type Lang = "ru" | "en";

export const dictionaries: Record<Lang, Record<string, string>> = {
  ru: {
    "chat.inputPlaceholder": "Напишите сообщение…",
    "chat.send": "Отправить",
    "chat.menu.rooms": "Комнаты",
    "chat.menu.gallery": "Галерея",
    "chat.menu.knowledge": "База знаний",
    "chat.menu.connectors": "Почта и интеграции",
    "chat.menu.refreshSummary": "Обновить сводку",
    "chat.menu.themeLight": "Светлая тема",
    "chat.menu.themeDark": "Тёмная тема",
    "chat.menu.langRu": "Русский",
    "chat.menu.langEn": "English",
    "chat.menu.clearChat": "Очистить чат",
    "common.loading": "Загрузка…",
  },
  en: {
    "chat.inputPlaceholder": "Type a message…",
    "chat.send": "Send",
    "chat.menu.rooms": "Rooms",
    "chat.menu.gallery": "Gallery",
    "chat.menu.knowledge": "Knowledge",
    "chat.menu.connectors": "Mail & integrations",
    "chat.menu.refreshSummary": "Refresh summary",
    "chat.menu.themeLight": "Light theme",
    "chat.menu.themeDark": "Dark theme",
    "chat.menu.langRu": "Русский",
    "chat.menu.langEn": "English",
    "chat.menu.clearChat": "Clear chat",
    "common.loading": "Loading…",
  },
};
