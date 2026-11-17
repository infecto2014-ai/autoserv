# Навыки разработки

Установлены **в проект**, без записи в домашний каталог и без изменения глобальных настроек Codex. Это навыки для агентов разработки, они не входят в runtime CRM и не обращаются к клиентской базе.

## Superpowers

- Источник: https://github.com/obra/superpowers
- Версия в исходниках: `7.0.2`.
- Зафиксированный commit: `22f0b463e7a5e579904dd6211a520321035526f7`.
- Исходные навыки, вспомогательные скрипты, hooks, assets и Codex manifest сохранены в `.project-tools/superpowers/` без изменений. Лицензия: `.project-tools/superpowers/LICENSE` (MIT).
- 15 относительных ссылок `.agents/skills/<имя-навыка>` указывают на `.project-tools/superpowers/skills/<имя-навыка>`. Каждая открывает настоящий `SKILL.md`; внешние checkout не требуются.
- Точка входа: `.agents/skills/using-superpowers/SKILL.md`. Проверка результата: `.agents/skills/verification-before-completion/SKILL.md`.

Текущий upstream рекомендует установку Codex plugin через маркетплейс. Здесь используется проектная установка файлов Agent Skills: это обеспечивает доступ к навыкам в `.agents/skills` без изменения профиля пользователя. Она **не означает** установку глобального Marketplace plugin или регистрацию его hooks в приложении Codex. При открытии проекта новая сессия Codex должна обнаружить проектные навыки; в текущей сессии их можно прочитать по указанным путям.

## UI UX Pro Max

- Источник: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
- Зафиксированный commit: `e59ff376a41f7ca47b7541ad5c116495cbade3ee`.
- Версия CLI в исходниках: `2.5.0`; на момент установки она ещё не была опубликована в npm (`ETARGET` при обращении к этой версии).
- Поэтому выполнен **официальный генератор из зафиксированного checkout**, без переизобретения шаблонов: `generatePlatformFiles(projectRoot, 'codex', false, false)` из `cli/src/utils/template.ts` через Node 24.
- Результат: `.agents/skills/ui-ux-pro-max/SKILL.md`, локальные `data/` и `scripts/`, а также шесть комплектных соседних навыков (`banner-design`, `brand`, `design`, `design-system`, `slides`, `ui-styling`).
- Лицензия: `.agents/skills/ui-ux-pro-max/LICENSE` (MIT).
- Поисковик работает на Python 3, использует стандартную библиотеку и локальные CSV; интернет для поиска не нужен.

```bash
python3 .agents/skills/ui-ux-pro-max/scripts/search.py \
  "B2B SaaS CRM operations admin data dense dashboard" --design-system -p "СТО CRM"
python3 .agents/skills/ui-ux-pro-max/scripts/search.py \
  "form validation autosave data table accessible errors" --domain ux -n 5
python3 .agents/skills/ui-ux-pro-max/scripts/search.py \
  "server components forms authentication" --stack nextjs -n 3
```

## Проверено

На 17.11.2026 все 22 проектные точки обнаружения содержат читаемый `SKILL.md`. Команды поиска дизайн-системы, UX, типографики, палитры и Next.js выполнены с кодом выхода 0. Результат применения к CRM: `docs/DESIGN.md`.

Источники, commit SHA и SHA-256 установленных файлов записаны в `.project-tools/manifest.json`. В проекте нет вложенных `.git`, зависимости от `/workspace/work` и установки в домашний каталог.

## Правила использования и обновления

Пользовательские указания, AGENTS.md и TASK.md имеют приоритет над общими рекомендациями навыков. В частности, навыки не дают разрешения на commit, push, создание публичного репозитория, платный хостинг или публикацию данных. Автономная реализация MVP уже поручена пользователем; повторное согласование каждой обратимой операции не требуется.

Обновлять отдельно от разработки бизнес-функций: получить выбранный commit upstream в `work/`, проверить изменения навыков и лицензий, заменить vendor-копию/сгенерировать UX навыки официальным генератором и заново выполнить проверки выше. Обновить SHA и контрольные суммы manifest. Не использовать неприкреплённый `latest` в CI.
