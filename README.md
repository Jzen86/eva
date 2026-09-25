# Eva

Персональный AI-компаньон в Telegram. Умеет память, самообучение, голос, картинки — и
**любой провайдер LLM, какой захочешь подключить**.

Форк и выжимка из [Aimagine-life/Betsy](https://github.com/Aimagine-life/Betsy) (MIT, Wildbots 2025).
Апстрим мёртв — один сплющенный коммит, обновлений ждать неоткуда.

## Что изменилось против апстрима

Апстрим — 223 файла и 32 017 строк, из них 19 тысяч занимает режим `multi`
(Postgres + drizzle + AWS S3 + OpenTelemetry), который в реальности не работал.
Здесь осталось **61 файл и ~7 000 строк** в `src/` — только то, что действительно исполняется.

Выкинуто: `multi/`, веб-панель `ui/`, `server.ts`, `auth-relay/`, Electron-приложение,
лендинг, 16 мёртвых зависимостей (`viem`, `@aws-sdk`, `drizzle-orm`, `sharp`, `pg`, ...).
`node_modules`: 491 МБ → 138 МБ.

Переписано:
- **Провайдеры** — реестр (`src/core/llm/registry.ts`) с произвольными OpenAI-совместимыми
  адресами вместо вшитого OpenRouter. Готовые шаблоны для openrouter / openai / google /
  groq / deepseek / together / cerebras, любой свой адрес — тоже.
- **Модели** — ролевые профили (`fast` / `strong` / `study` / `embed` / `image`) с
  переключением на лету, без перезапуска.
- **Роутер** — фолбэки с общим дедлайном, а не шестью минутами тишины; ловит 5xx и
  сетевые сбои, а не только «кончились деньги».
- **Память** — русская стемминг-нормализация для FTS, семантический дедуп.
- **Личность** — границы того, что Ева может менять в себе сама.

## Провайдеры

Любой OpenAI-совместимый эндпоинт. Прописывается в `config.yaml`:

```yaml
providers:
  openrouter: { api_key: "..." }        # base_url подставится сам
  google:     { api_key: "..." }        # Gemini через официальный OpenAI-эндпоинт
  my-server:  { base_url: "http://127.0.0.1:1234/v1", api_key: "..." }

models:
  fast:   { provider: openrouter, model: google/gemini-2.5-flash }
  strong: { provider: google,     model: gemini-2.5-pro }

fallbacks:                               # перебор при кончившихся деньгах или 5xx
  - { provider: openrouter, model: qwen/qwen3-coder:free }
```

Хочется сменить модель — можно не редактировать конфиг: у Евы есть тулза
`switch_model`, и она сама переключит роль по просьбе, **проверив модель
одним запросом и откатившись, если та не ответила**. Список моделей
провайдера она тоже спросит сама (`GET {base_url}/models`).

Единственное, что осталось привязано к OpenRouter по существу, — генерация
картинок: режим `modalities:["image"]` в чат-комплишенах не входит в
спецификацию OpenAI. Адрес вынесен в `image_gen.base_url`, но чужой эндпоинт
сработает, только если он тоже это умеет.

## Установка

```bash
npm install
cp config.example.yaml ~/.eva/config.yaml   # заполнить токены и ключи
npm run build && npm start
```

## Разработка

```bash
npm run dev        # tsx src/index.ts
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

## Данные и секреты

В репозитории **нет** ни конфига, ни базы, ни ключей — только код.
`config.example.yaml` с заглушками, реальный `config.yaml` и `*.db` в `.gitignore`.
Живут в `~/.eva/` (путь к конфигу переопределяется `EVA_CONFIG_PATH`).

## Лицензия

MIT. Апстрим — MIT, Copyright (c) 2025 Wildbots.
