# thunderTODOcodex

Dodatek Thunderbird, ktory:
- automatycznie (co 60 minut) czyta maile,
- generuje liste TODO przez Codex backend,
- zapisuje TODO lokalnie oraz synchronizuje je do plikow backendu (`server/data/todo-state.json` i `server/data/todo-state.md`),
- pokazuje status backendu (online/offline),
- ma przycisk uruchomienia backendu (LaunchAgent),
- pozwala kliknac pozycje TODO i otworzyc zrodlowego maila,
- pozwala od razu odpowiedziec na mail z TODO i oznaczyc pozycje jako wykonana,
- po 3 dniach przenosi wykonane TODO do archiwum,
- przetwarza inkrementalnie tylko nowe maile (tracking `processedMessageKeys`),
- przez Experiment API osadza panel TODO po prawej stronie w oknie `mail:3pane`,
- moze utrzymywac panel stale otwarty.

## Wymagania

- dzialajacy backend z tego repo (`server/index.js`)
- zalogowany `codex` (`codex login --device-auth`)

## Instalacja

1. W Thunderbird: `Tools -> Add-ons and Themes`.
2. Ikona kola zebatego -> `Debug Add-ons`.
3. `Load Temporary Add-on`.
4. Wskaz `thunderTODOcodex/manifest.json`.
5. Po przeladowaniu dodatku zamknij i uruchom ponownie Thunderbird (Experiment API).

## Uzycie

1. Otworz ustawienia dodatku (`thunderTODOcodex Settings`) i zapisz backend URL/model/jezyk.
2. Kliknij `Wymus odswiezenie teraz`, aby wygenerowac TODO natychmiast.
3. Uzywaj akcji `Odpowiedz`, `Mail`, `Wykonane` bezposrednio na kartach TODO.
4. W ustawieniach mozesz wlaczyc tryb `Panel TODO zawsze otwarty`.
5. Auto-odswiezanie dziala co 60 minut.
