# Fate RPG Tabletop

Виртуальный стол для Fate Core / Accelerated: приключения, персонажи, сцены и карта, броски кубиков, сетевые комнаты, физика 3D-кубиков.

Стек: Next.js / React / TypeScript, Zustand, Prisma / SQLite, Socket.IO / WebRTC, Rapier3D. Публичный доступ — localtunnel через общий шлюз.

## Подготовка исходников

Для сборки нужен Node.js 22. В корне проекта:

```powershell
npm.cmd ci
npm.cmd install --prefix mini-services/signaling
npm.cmd install --prefix mini-services/physics-service
Copy-Item .env.example .env
npx.cmd prisma generate
```

Если у вас уже есть игровая база, поместите её в `db/custom.db`. Для новой установки без пользовательских данных создайте пустую базу по схеме:

```powershell
npx.cmd prisma db push
```

Не используйте эту команду для обновления существующей игровой базы без резервной копии и проверки изменения схемы.

## Сборка и запуск

```powershell
npm.cmd run build
npm.cmd start
```

В Windows также доступны `build.bat`, `start.bat` и создаваемый сборкой `Fate RPG.exe`. Приложение открывается по адресу `http://localhost:3008`. Закрытие окна exe или «Ещё» → «Выход» в браузере мастера останавливает сервисы.

- [Production, exe и управление процессами](PRODUCTION.md)
- [Сетевая игра и localtunnel](LOCAL_NETWORK.md)
- [Архитектура и контекст разработки](context.md)

`.env`, пользовательская SQLite, зависимости, готовые сборки и журналы не хранятся в Git. Для установки зависимостей используйте актуальный `package-lock.json`; исторический `bun.lock` не отражает все изменения. Режим `npm run dev` предназначен для разработки и требует Bun для mini-services.
