# ThunderAI Monorepo (Thunderbird + Codex backend)

Repo zawiera dwa dodatki Thunderbird i jeden lokalny backend:

1. `ThunderAI Mail Generator` (root add-on)  
   Generowanie odpowiedzi w oknie Compose.
2. `thunderTODOcodex` (addon w `thunderTODOcodex/`)  
   Automatyczna lista TODO z maili, osadzona po prawej stronie okna Thunderbird.
3. `server/`  
   Lokalny backend HTTP, ktory uruchamia `codex` CLI, obsluguje logowanie OpenAI i persistence TODO.

W projekcie nie podaje sie klucza API w samym dodatku. Uwierzytelnianie odbywa sie przez `codex login --device-auth` po stronie backendu.

## Architektura

- Addony Thunderbird:
  - czytaja kontekst maili z API Thunderbird,
  - wysylaja zapytania do backendu (`http://127.0.0.1:8787`),
  - zapisuja ustawienia i stan w `storage.local`.
- Backend Node.js (`server/index.js`):
  - sprawdza stan logowania `codex login status`,
  - uruchamia flow OpenAI device auth,
  - wywoluje `codex exec` dla generowania odpowiedzi i TODO,
  - zapisuje stan TODO do:
    - `server/data/todo-state.json`
    - `server/data/todo-state.md`

## Struktura repo

```text
.
├── background.js                 # root add-on: compose generator
├── manifest.json                 # root add-on manifest
├── options/                      # root add-on settings UI
├── popup/                        # root add-on compose popup UI
├── thunderTODOcodex/             # drugi addon (TODO)
│   ├── background.js
│   ├── manifest.json
│   ├── options/
│   ├── popup/
│   └── experiments/todo_panel/   # Experiment API osadzajace panel po prawej
└── server/
    ├── index.js                  # backend HTTP
    ├── .env.example
    ├── data/                     # stan TODO (json + md)
    └── launchd/                  # autostart backendu na macOS
```

## Wymagania

- Thunderbird 115+
- Node.js 18+
- `codex` CLI dostepny w PATH
- Konto OpenAI/ChatGPT do logowania przez device auth

## Backend - szybki start

```bash
cd server
cp .env.example .env
node index.js
```

Domyslnie backend nasluchuje na `http://127.0.0.1:8787`.

### Autostart backendu na macOS (LaunchAgent)

Instalacja:

```bash
cd server/launchd
./install-launchagent.sh
```

Status / uninstall:

```bash
cd server/launchd
./status-launchagent.sh
./uninstall-launchagent.sh
```

## Addon 1: ThunderAI Mail Generator (root)

### Co robi

- Dziala w oknie Compose (`compose_action` popup).
- Generuje draft odpowiedzi przez backend (`POST /api/generate`).
- Ma tryb szybkiej odpowiedzi:
  - `Wykonano`
  - `Nie wykonano`
- Zachowuje podpis/ogon tresci przy podmianie draftu.
- Konfiguracja:
  - `Backend URL`
  - model (domyslnie `gpt-5.3-codex`)
  - domyslny jezyk
- Settings zawieraja flow:
  - `Connect OpenAI`
  - `Refresh status`
  - `Log out`

### Instalacja tymczasowa

1. Thunderbird -> `Tools` -> `Add-ons and Themes`.
2. Ikona kola zebatego -> `Debug Add-ons`.
3. `Load Temporary Add-on`.
4. Wskaz `manifest.json` z katalogu glownego repo.

## Addon 2: thunderTODOcodex (`thunderTODOcodex/`)

### Co robi

- Automatycznie odswieza TODO co 60 minut.
- Generuje TODO z maili przez backend (`POST /api/todos/generate`).
- Wyswietla panel TODO po prawej stronie okna `mail:3pane` (Experiment API).
- Status backendu online/offline + przycisk uruchomienia serwera.
- Akcje na TODO:
  - `Odpowiedz` (otwiera compose reply),
  - `Mail` (otwiera zrodlowa wiadomosc),
  - `Wykonane` (checkbox).
- Po wyslaniu odpowiedzi TODO automatycznie oznacza sie jako wykonane.
- Wykonane TODO trafiaja na dol listy.
- Po 3 dniach od `doneAt` element jest przenoszony do archiwum.
- Stan jest trzymany:
  - lokalnie w `storage.local`,
  - oraz synchronizowany do backendowych plikow stanu.
- Przy pustym local storage potrafi zaimportowac poprzedni stan z backendu.
- Przetwarza inkrementalnie tylko nowe maile (tracking `processedMessageKeys`), zeby nie regenerowac TODO ze starych wiadomosci.

### Instalacja tymczasowa

1. Thunderbird -> `Tools` -> `Add-ons and Themes`.
2. Ikona kola zebatego -> `Debug Add-ons`.
3. `Load Temporary Add-on`.
4. Wskaz `thunderTODOcodex/manifest.json`.
5. Po przeladowaniu dodatku z Experiment API zrob restart Thunderbird.

## Endpointy backendu

- `GET /health`
- `GET /auth/openai/status`
- `POST /auth/openai/start`
- `GET /auth/openai/poll?session_id=...`
- `POST /auth/openai/logout`
- `POST /api/generate`
- `POST /api/todos/generate`
- `GET /api/todos/state`
- `POST /api/todos/state`
- `PUT /api/todos/state`

## Konfiguracja backendu (`server/.env`)

- `HOST` (default `127.0.0.1`)
- `PORT` (default `8787`)
- `PUBLIC_BASE_URL` (default `http://127.0.0.1:8787`)
- `CODEX_BIN` (default `codex`)
- `CODEX_WORKDIR` (default `$HOME`)

## Typowy flow uruchomienia

1. Start backend (`node server/index.js` lub LaunchAgent).
2. Zaloaduj wybrany addon tymczasowo.
3. W ustawieniach dodatku ustaw `Backend URL`.
4. Wykonaj `Connect OpenAI` (device auth).
5. Uzywaj funkcji compose/TODO.

## Troubleshooting

- `Cannot reach backend at http://127.0.0.1:8787`:
  - uruchom `cd server && node index.js`
  - sprawdz `curl http://127.0.0.1:8787/health`
- Gdy addon z Experiment API zachowuje sie niestabilnie:
  - wylacz/wlacz addon,
  - zrestartuj Thunderbird,
  - zaladuj tylko najnowsza paczke XPI/manifest.
- Jesli TODO nie pojawia sie po reinstalacji:
  - sprawdz czy istnieje `server/data/todo-state.json`,
  - sprawdz czy backend odpowiada na `GET /api/todos/state`.
