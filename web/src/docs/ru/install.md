# Установка и обновление

На этой странице — всё, что нужно для промышленной установки pgscope: требования, сборка, Docker-образы и Docker Compose, база для хранения, запуск под systemd, HTTPS через обратный прокси, установка в закрытом контуре, обновление, резервное копирование и удаление. Если нужно просто попробовать pgscope, начните с [быстрого старта](quickstart.md). Все переменные окружения описаны на странице [Настройка pgscope](config.md).

## Требования {#requirements}

| Что | Требование |
|---|---|
| Сборка сервера | Go 1.26 или новее (`go 1.26.0` в `go.mod`; образ собирается на `golang:1.27-alpine`) |
| Сборка веб-интерфейса | Node.js 20.19+ или 22.12+ и npm (этого требует Vite 8; образ собирается на `node:22-alpine`) |
| Запуск | Linux; pgscope — один исполняемый файл без внешних зависимостей, веб-интерфейс встроен в него |
| База для хранения | PostgreSQL. pgscope не проверяет версию и не объявляет минимальную; схема использует только давно доступные возможности (`jsonb`, BRIN-индекс, `ON CONFLICT`, `ADD COLUMN IF NOT EXISTS`). Отдельные версии на совместимость не проверялись: берите версию, которая поддерживается сообществом; готовый compose-файл использует `postgres:17-alpine` |
| Docker (по желанию) | Docker Engine с плагином Docker Compose v2 (`docker compose`) |
| Сеть | входящий HTTP(S) к pgscope от браузеров, хостов с pgdash CLI и агентов; исходящее подключение к базе для хранения; при необходимости — к SMTP-серверу и адресам вебхуков |

Нагрузка на pgscope и объём базы для хранения зависят от числа серверов, объектов в них (таблиц, индексов, запросов) и интервала отправки отчётов. Во время приёма pgscope держит отчёт в памяти целиком, поэтому отчёты серверов с десятками тысяч таблиц требуют заметно больше памяти. Как оценить и сократить объём данных — на странице [Хранение данных](data.md).

## Сборка из исходников {#build}

```bash
cd web
npm ci
npm run build        # собирает веб-интерфейс в web/dist
cd ..
go build -o pgscope .
```

Веб-интерфейс собирается первым: каталог `web/dist` встраивается в исполняемый файл при компиляции (`//go:embed`), без него `go build` завершится ошибкой.

Чтобы получить статически собранный файл для другого Linux-хоста (так собирается и Docker-образ):

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o pgscope .
```

Для ARM-серверов укажите `GOARCH=arm64`. Проверить сборку можно тестами: `go test ./...`.

Агент для Docker собирается из того же репозитория: `go build -o pgscope-agent ./cmd/pgscope-agent` (обычно его используют в виде образа, см. ниже).

## Docker-образы {#docker-images}

Образы собираются из корня репозитория на машине с доступом в интернет:

```bash
docker build -t pgscope:2026.10.26 -t pgscope:latest .
docker build -f Dockerfile.agent --build-arg VERSION=2026.10.26 -t pgscope-agent:2026.10.26 -t pgscope-agent:latest .
```

| Образ | Что внутри |
|---|---|
| `pgscope` (`Dockerfile`) | статически собранный `pgscope` на базе `alpine:3.22` с корневыми сертификатами. Работает от непривилегированного пользователя `pgscope` (uid 10001), слушает порт 8080. Настраивается только переменными окружения |
| `pgscope-agent` (`Dockerfile.agent`) | `pgscope-agent` и pgmetrics, собранный из исходников ровно той версии, которую использует pgscope (берётся из `go.mod`). Работает от root, потому что обращается к `/var/run/docker.sock`. Аргумент сборки `VERSION` — версия агента, которую видно на странице «Агенты» |

Помечайте образы версией, а не только `latest`: так обновление и откат сводятся к смене тега. В `deploy/docker-compose.yml` тег задаётся переменной `PGSCOPE_IMAGE`, в compose-файлах агента — `PGSCOPE_AGENT_IMAGE`.

Как развернуть агент, описано на странице [Docker и Docker Swarm](docker.md).

## Запуск через Docker Compose {#compose}

Файл `deploy/docker-compose.yml` запускает два сервиса:

- `db` — `postgres:17-alpine`, база и пользователь `pgscope`, данные в томе `pgscope-data`, проверка готовности через `pg_isready`;
- `pgscope` — образ `${PGSCOPE_IMAGE:-pgscope:latest}`, стартует после того, как база готова, публикует порт `${PGSCOPE_PORT:-8080}`. Подключается к базе по `postgres://pgscope@db:5432/pgscope?sslmode=disable`, пароль передаётся драйверу через `PGPASSWORD`, поэтому спецсимволы в нём не нужно экранировать.

Настройки задаются в файле `deploy/.env`:

```bash
PGSCOPE_DB_PASSWORD=надёжный-пароль
PGSCOPE_BASE_URL=https://pgscope.example.com
PGSCOPE_PORT=127.0.0.1:8080
PGSCOPE_SMTP_ADDR=mail.example.local:25
PGSCOPE_SMTP_FROM=pgscope@example.com
```

`PGSCOPE_PORT=127.0.0.1:8080` публикует порт только на локальном интерфейсе — так делают, когда обратный прокси работает на том же хосте. Остальные переменные (`PGSCOPE_MIN_REPORT_INTERVAL`, сроки хранения, SMTP, AI) передаются в контейнер из `.env` с теми же значениями по умолчанию, что и у самого pgscope (см. [Переменные Docker Compose](config.md#compose-vars)).

```bash
cd deploy
docker compose up -d
docker compose ps
docker compose logs -f pgscope
```

> [!WARNING]
> `PGSCOPE_DB_PASSWORD` применяется к базе только при первом запуске, когда том `pgscope-data` ещё пуст: так работает официальный образ PostgreSQL. Если позже поменять пароль только в `.env`, pgscope перестанет подключаться к базе. Сначала смените пароль в самой базе (`docker compose exec db psql -U pgscope -d pgscope -c "ALTER ROLE pgscope PASSWORD '…'"`), затем в `.env`, и выполните `docker compose up -d`.

`docker compose down` останавливает сервисы и сохраняет данные; `docker compose down -v` удаляет и том с данными.

## База для хранения {#storage-db}

pgscope хранит всё — пользователей, сессии, отчёты, временные ряды, правила и каналы — в одной базе PostgreSQL, заданной переменной `PGSCOPE_DB`. Её можно разместить на одном из наблюдаемых серверов, но лучше выделить отдельный: иначе нагрузка от записи отчётов попадёт в собственные графики, а сбой этого сервера отключит и мониторинг.

### Создание базы и роли {#storage-create}

```bash
sudo -u postgres psql -c "CREATE ROLE pgscope LOGIN PASSWORD 'надёжный-пароль'"
sudo -u postgres createdb -O pgscope pgscope
```

Какие права нужны:

- При каждом запуске pgscope выполняет `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` и `ALTER TABLE … ADD COLUMN IF NOT EXISTS` в схеме по умолчанию (обычно `public`). Роли нужно право `CREATE` в этой схеме, а таблицы pgscope должны принадлежать ей: `ALTER TABLE` разрешён только владельцу таблицы. Проще всего сделать роль владельцем базы, как в примере выше (в PostgreSQL 15 и новее право создавать объекты в `public` по умолчанию есть только у владельца базы).
- Права суперпользователя и расширения не нужны.
- Всегда запускайте pgscope под одной и той же ролью. Если таблицы создала другая роль, запуск завершится ошибкой `schema setup: …`.

Строка подключения — URL или строка `ключ=значение` в формате libpq. Пароль можно передать в URL, через `PGPASSWORD` или `~/.pgpass`; размер пула соединений — параметром `pool_max_conns` (см. [PGSCOPE_DB](config.md#pgscope-db)).

### Схема и миграции {#schema}

Отдельного инструмента миграций и таблицы версий нет. Схема описана одним скриптом из идемпотентных команд (`IF NOT EXISTS`), который выполняется при каждом запуске:

- на пустой базе он создаёт все таблицы и индексы;
- после обновления pgscope добавляет новые таблицы, столбцы и индексы, существующие данные не меняются;
- при ошибке pgscope пишет в лог `schema setup: …` и завершается.

| Таблица | Что хранит |
|---|---|
| `users`, `sessions` | учётные записи (хеши паролей bcrypt, API-ключи, язык) и сессии браузеров |
| `servers`, `shares`, `invites` | серверы, совместный доступ, неиспользованные приглашения |
| `reports` | полные отчёты pgmetrics в сжатом виде |
| `metrics` | временные ряды: строка на объект (сервер, база, таблица, индекс, запрос и т. д.) на каждый отчёт |
| `alert_rules`, `change_rules`, `notifiers` | правила оповещений, настройки оповещений об изменениях, каналы уведомлений |
| `alert_state`, `events` | текущие сработавшие оповещения и история оповещений и изменений |
| `agents` | последние сигналы pgscope-agent и состояние их целей |

Самые большие таблицы — `metrics` и `reports`. Старые данные удаляются автоматически раз в час (см. [Хранение данных](data.md#retention)). Не меняйте схему вручную.

## Запуск как сервис systemd {#systemd}

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin pgscope
sudo install -m 755 pgscope /usr/local/bin/pgscope
sudo install -d -m 750 -o root -g pgscope /etc/pgscope
sudo install -m 640 -o root -g pgscope /dev/null /etc/pgscope/pgscope.env
sudoedit /etc/pgscope/pgscope.env
```

Файл `/etc/pgscope/pgscope.env` (пароли не попадают в unit-файл и в вывод `systemctl show`):

```bash
PGSCOPE_DB=postgres://pgscope@dbhost:5432/pgscope?sslmode=verify-full&sslrootcert=/etc/pgscope/db-ca.crt
PGPASSWORD=надёжный-пароль
PGSCOPE_BASE_URL=https://pgscope.example.com
PGSCOPE_LISTEN=127.0.0.1:8080
PGSCOPE_SMTP_ADDR=mail.example.local:25
PGSCOPE_SMTP_FROM=pgscope@example.com
```

Файл `/etc/systemd/system/pgscope.service`:

```ini
[Unit]
Description=pgscope PostgreSQL monitoring
Wants=network-online.target
After=network-online.target

[Service]
User=pgscope
Group=pgscope
EnvironmentFile=/etc/pgscope/pgscope.env
ExecStart=/usr/local/bin/pgscope
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pgscope
journalctl -u pgscope -f
```

- `sslrootcert` — корневой сертификат центра, которым подписан сертификат базы для хранения. Если он есть в системном хранилище, укажите `sslrootcert=system`; если база принимает подключения без TLS, используйте `sslmode=disable` (см. [PGSCOPE_DB](config.md#pgscope-db)).
- pgscope не пишет файлов на диск, поэтому `ProtectSystem=strict` ему не мешает. Логи идут в stderr и попадают в журнал systemd.
- С `ProtectHome=true` каталоги `/home` недоступны, поэтому файл `~/.pgpass` не прочитается. Передавайте пароль через `PGPASSWORD`, как в примере, или положите файл паролей в `/etc/pgscope` и укажите его в `PGPASSFILE`.
- Если база для хранения работает на том же хосте, добавьте в `[Unit]` строку `After=postgresql.service`. Если база недоступна при запуске, pgscope завершается, а `Restart=always` перезапускает его через 5 секунд.
- Сигналы остановки pgscope не обрабатывает особо: процесс завершается сразу. Отчёт, который сохранялся в этот момент, не будет записан (транзакция откатится). pgscope-agent повторяет неудачную отправку один раз через 5 секунд.

## Reverse proxy и HTTPS {#reverse-proxy}

pgscope отдаёт только HTTP, встроенного TLS нет. По сети передаются пароли, cookie сессий и API-ключи (они в теле каждого отчёта), поэтому в промышленной установке перед pgscope ставят обратный прокси с HTTPS: nginx, Caddy, HAProxy или балансировщик. Требования к прокси:

1. **Отдельное имя хоста, корневой путь.** Веб-интерфейс загружает `/assets/…` и обращается к `/api/…` по абсолютным путям, поэтому размещение в подкаталоге (`https://example.com/pgscope/`) не поддерживается.
2. **Размер тела запроса.** pgscope принимает отчёты размером до 256 МиБ (до 2 ГиБ после распаковки gzip); более крупный отчёт он отклоняет с кодом 400. У nginx по умолчанию предел 1 МиБ, и крупные отчёты получат от прокси ошибку 413. Поставьте `client_max_body_size 256m`.
3. **Таймауты.** Сохранение большого отчёта и ответ AI-чата могут занимать больше минуты. Увеличьте таймаут чтения ответа (в nginx — `proxy_read_timeout`).
4. **Заголовок `X-Forwarded-Proto: https`** — чтобы cookie сессии получала флаг Secure (см. [ниже](#secure-cookie)).
5. **`PGSCOPE_BASE_URL` с `https://`** — публичный адрес, который видят пользователи. Из него строятся ссылки в оповещениях и приглашениях и готовые команды в интерфейсе.
6. **pgscope слушает только локальный интерфейс**: `PGSCOPE_LISTEN=127.0.0.1:8080` для бинарного файла или `PGSCOPE_PORT=127.0.0.1:8080` для Docker Compose.

### Пример для nginx {#nginx}

```nginx
server {
    listen 443 ssl;
    server_name pgscope.example.com;

    ssl_certificate     /etc/nginx/tls/pgscope.example.com.crt;
    ssl_certificate_key /etc/nginx/tls/pgscope.example.com.key;

    # отчёты pgmetrics бывают большими; pgscope принимает до 256 МиБ
    client_max_body_size 256m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}

server {
    listen 80;
    server_name pgscope.example.com;
    return 301 https://$host$request_uri;
}
```

После настройки прокси:

- в `PGSCOPE_BASE_URL` укажите `https://pgscope.example.com` и перезапустите pgscope;
- в заданиях pgdash CLI используйте `--base-url=https://pgscope.example.com/api/v1`, у агентов — `PGSCOPE_URL=https://pgscope.example.com`. Указывайте сразу `https://`: перенаправление с HTTP на HTTPS для POST-запросов с отчётами не годится;
- если сертификат выпущен внутренним центром сертификации, клиенты должны ему доверять: добавьте корневой сертификат в системное хранилище хостов с pgdash CLI, а агенту передайте его через `SSL_CERT_FILE` (см. [Docker и Docker Swarm](docker.md)).

> [!TIP]
> Регистрация в pgscope открыта всем, кто может открыть веб-интерфейс, и отключить её настройкой нельзя. Когда учётные записи владельцев созданы, регистрацию можно закрыть на прокси, например `location = /api/signup { return 403; }`. Приглашения в команду продолжат работать: они создают учётные записи через другой адрес (`/api/invite/…`).

### Cookie сессии и флаг Secure {#secure-cookie}

После входа, регистрации или принятия приглашения pgscope выдаёт cookie `pgscope_session` с атрибутами `HttpOnly`, `SameSite=Lax`, `Path=/` и сроком 30 дней. Флаг `Secure` (передавать только по HTTPS) ставится, если выполнено хотя бы одно условие:

- запрос пришёл с заголовком `X-Forwarded-Proto: https`;
- `PGSCOPE_BASE_URL` начинается с `https://`.

Что из этого следует:

| Ситуация | Результат |
|---|---|
| Прокси с HTTPS, `PGSCOPE_BASE_URL=https://…` | cookie всегда с `Secure`, даже если прокси не передаёт `X-Forwarded-Proto` |
| Прокси с HTTPS передаёт `X-Forwarded-Proto: https`, но `PGSCOPE_BASE_URL` начинается с `http://` | cookie с `Secure`, вход работает, но ссылки в оповещениях, приглашениях и командах в интерфейсе ведут на `http://`. Исправьте `PGSCOPE_BASE_URL` |
| Прокси с HTTPS без `X-Forwarded-Proto`, `PGSCOPE_BASE_URL=http://…` | cookie без `Secure`: вход работает, но браузер может отправить cookie и по незащищённому HTTP |
| `PGSCOPE_BASE_URL=https://…`, а pgscope открыт напрямую по `http://хост:8080` | браузер не сохраняет cookie с `Secure`, полученную по HTTP: после входа снова показывается страница входа. Открывайте pgscope через HTTPS-адрес. Для адреса `http://localhost` некоторые браузеры делают исключение и cookie сохраняют |
| Без прокси, `PGSCOPE_BASE_URL=http://…` (пробная установка) | cookie без `Secure`, всё работает по HTTP |

Заголовок `X-Forwarded-Proto` pgscope принимает от любого клиента. Это безопасно: заголовок влияет только на флаг `Secure` cookie в ответе этому же клиенту.

## Установка в закрытом контуре {#air-gapped}

pgscope работает без доступа в интернет. Интернет нужен только для сборки: npm-пакетов, Go-модулей (в том числе исходников pgmetrics для образа агента) и базовых образов Docker (`node:22-alpine`, `golang:1.27-alpine`, `alpine:3.22`, а для compose-файла — `postgres:17-alpine`). Собирайте на машине с доступом в интернет и переносите результат файлами.

**Docker-образы:**

```bash
# на машине с интернетом, в корне репозитория
docker build -t pgscope:2026.10.26 .
docker build -f Dockerfile.agent --build-arg VERSION=2026.10.26 -t pgscope-agent:2026.10.26 .
docker pull postgres:17-alpine
docker save pgscope:2026.10.26 postgres:17-alpine | gzip > pgscope-images.tar.gz
docker save pgscope-agent:2026.10.26 | gzip > pgscope-agent.tar.gz

# в контуре
docker load -i pgscope-images.tar.gz          # на хосте pgscope
docker load -i pgscope-agent.tar.gz           # на каждом Docker-хосте и узле Swarm
```

Вместо переноса файлов можно загрузить образы во внутренний registry. Тег укажите в `deploy/.env`: `PGSCOPE_IMAGE=pgscope:2026.10.26`.

**Бинарные файлы.** Соберите статический `pgscope` (см. [Сборка из исходников](#build)) или извлеките готовые файлы из образов. Образ агента содержит pgmetrics, который можно использовать и в заданиях cron вместе с pgdash CLI:

```bash
docker create --name pgscope-tmp pgscope:2026.10.26
docker cp pgscope-tmp:/usr/local/bin/pgscope ./pgscope
docker rm pgscope-tmp

docker create --name agent-tmp pgscope-agent:2026.10.26
docker cp agent-tmp:/usr/local/bin/pgmetrics ./pgmetrics
docker rm agent-tmp
```

Оба файла собраны статически (`CGO_ENABLED=0`) и запускаются на любом Linux той же архитектуры, что и машина сборки. Для другой архитектуры собирайте образы с `docker buildx build --platform …` или бинарный файл с нужным `GOARCH`.

**pgdash CLI** в образы не входит: скачайте готовую сборку со страницы проекта на машине с интернетом и перенесите её вместе с остальными файлами.

**Функции, которым нужен интернет**, в контуре не используйте: каналы Slack, PagerDuty, VictorOps и xMatters и AI-чат. Вместо них — email через внутренний SMTP-сервер ([Почта (SMTP)](config.md#smtp)) и вебхуки на внутренние адреса ([Формат вебхука](notifications.md#webhook)). AI-чат выключен, пока не задан `PGSCOPE_AI_KEY`.

## Обновление {#upgrade}

Порядок обновления:

1. Сделайте резервную копию базы для хранения (см. [ниже](#backup)).
2. Соберите или загрузите новую версию pgscope.
3. Перезапустите сервер pgscope:
   - Docker Compose: укажите новый тег в `PGSCOPE_IMAGE` (или пересоберите `pgscope:latest`) и выполните `docker compose up -d`;
   - systemd: замените `/usr/local/bin/pgscope` и выполните `sudo systemctl restart pgscope`.
4. Проверьте лог. При запуске pgscope сам добавит в схему новые таблицы, столбцы и индексы.
5. После сервера обновите агенты: пересоберите образ `pgscope-agent` из того же исходного кода (в нём pgmetrics той же версии, что использует pgscope) и перезапустите их (`docker compose up -d` или `docker service update --image …`).

Сервер обновляют первым: новые агенты могут рассчитывать на возможности новой версии сервера (это рекомендация, а не проверенная гарантия совместимости). pgscope принимает отчёты любой версии pgmetrics, если в них есть время сбора (`metadata.at`): неизвестные поля он пропускает, отсутствующие считает пустыми. Поэтому задания cron с pgdash CLI и старые агенты продолжают отправлять отчёты обновлённому серверу. Данные, которые собирают только новые версии pgmetrics, появятся после обновления pgmetrics на хостах.

Что происходит во время обновления:

- пока pgscope перезапускается, отчёты не принимаются. pgscope-agent повторяет отправку один раз через 5 секунд; если сервер ещё не поднялся, отчёт пропускается, и на графиках будет пропуск в одну точку;
- ограничения частоты отчётов хранятся в памяти и после перезапуска сбрасываются;
- сессии пользователей хранятся в базе, повторно входить не нужно.

**Откат.** Изменения схемы только добавляют объекты, поэтому старая версия, как правило, запускается на обновлённой базе. Однако откат не проверялся, и надёжный путь — вернуть прежний образ или бинарный файл вместе с резервной копией, сделанной перед обновлением.

**Обновление PostgreSQL в составе Docker Compose.** Каталог данных нельзя открыть другой основной версией PostgreSQL: если просто поменять тег `postgres:17-alpine` на следующую версию, база не запустится. Переносите данные через `pg_dump` и восстановление в новый том или через `pg_upgrade`.

## Резервное копирование и восстановление {#backup}

Всё состояние pgscope находится в базе для хранения, исполняемый файл и образы состояния не содержат. Бэкапьте её как обычную базу PostgreSQL: логическими копиями `pg_dump` или физическими средствами (`pg_basebackup`, pgBackRest и т. п.).

> [!WARNING]
> В резервной копии лежат API-ключи (в открытом виде), токены сессий и приглашений, хеши паролей, адреса вебхуков и ключи интеграций каналов уведомлений, а также тексты запросов из отчётов. Храните копии так же бережно, как саму базу.

Логическая копия, бинарный файл и systemd:

```bash
pg_dump -Fc -h dbhost -U pgscope -d pgscope -f pgscope-$(date +%F).dump
```

Docker Compose (в каталоге `deploy`):

```bash
docker compose exec -T db pg_dump -U pgscope -Fc pgscope > pgscope-$(date +%F).dump
```

Копия только настроек — учётные записи, серверы, доступы, правила и каналы — без объёмной истории:

```bash
pg_dump -Fc -h dbhost -U pgscope -d pgscope \
  --exclude-table-data=reports --exclude-table-data=metrics --exclude-table-data=events \
  -f pgscope-settings-$(date +%F).dump
```

После восстановления такой копии список серверов сохранится вместе со сводкой последнего отчёта, но страницы серверов будут пусты, пока не придут новые отчёты, а графики начнутся с момента восстановления.

Восстановление, бинарный файл и systemd (`dropdb` и `createdb` — от имени суперпользователя или роли с правом `CREATEDB`):

```bash
sudo systemctl stop pgscope
dropdb -h dbhost -U postgres pgscope
createdb -h dbhost -U postgres -O pgscope pgscope
pg_restore -h dbhost -U pgscope -d pgscope --no-owner pgscope-2026-10-26.dump
sudo systemctl start pgscope
```

Восстановление, Docker Compose:

```bash
docker compose stop pgscope
docker compose exec -T db dropdb -U pgscope pgscope
docker compose exec -T db createdb -U pgscope pgscope
docker compose exec -T db pg_restore -U pgscope -d pgscope --no-owner < pgscope-2026-10-26.dump
docker compose start pgscope
```

## Удаление {#uninstall}

1. **Остановите сбор.** Удалите задания cron с pgdash CLI. Остановите агенты: `docker compose down` в каталоге с их compose-файлом на каждом хосте; в Swarm — `docker stack rm pgscope-agent` и `docker secret rm pgscope_api_key pgscope_monitor_password`.
2. **Остановите pgscope.**
   - Docker Compose: `docker compose down` сохраняет том с данными, `docker compose down -v` удаляет его вместе со всеми данными.
   - systemd: `sudo systemctl disable --now pgscope`, затем удалите `/etc/systemd/system/pgscope.service`, `/usr/local/bin/pgscope`, `/etc/pgscope` и пользователя `pgscope`.
3. **Удалите базу для хранения**, если она на отдельном сервере PostgreSQL: `dropdb pgscope` и `DROP ROLE pgscope;`.
4. **Уберите роль мониторинга** на наблюдаемых серверах: `DROP ROLE pgmon;` (или `pgscope_monitor` для агента). Если `pg_stat_statements` и `auto_explain` включали только ради pgscope, уберите их из `shared_preload_libraries` (нужен перезапуск PostgreSQL) и выполните `DROP EXTENSION pg_stat_statements;` в базах.
5. **Удалите образы**: `docker image rm pgscope:2026.10.26 pgscope-agent:2026.10.26`.

Чтобы удалить из pgscope один сервер, а не всю установку, воспользуйтесь разделом «Команда и настройки» этого сервера (см. [Команда, профиль и аккаунт](teams.md#server-settings)).
