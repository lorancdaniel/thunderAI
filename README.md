# ThunderAI Mail Generator (Thunderbird add-on)

Minimalny dodatek MailExtension do Thunderbirda:
- zapisuje OpenAI API key w ustawieniach dodatku,
- dodaje przycisk w oknie pisania maila,
- generuje temat i tresc maila przez OpenAI,
- wstawia wynik do aktualnego draftu.

## Wymagania

- Thunderbird 115+ (zalecany nowszy)
- OpenAI API key (`sk-...`)

## Instalacja jako dodatek tymczasowy

1. Spakuj pliki dodatku do `.zip` lub `.xpi` (manifest musi byc w katalogu glownym archiwum).
2. W Thunderbirdzie otworz `Tools -> Add-ons and Themes`.
3. Kliknij ikonke kola zebatego -> `Debug Add-ons`.
4. Kliknij `Load Temporary Add-on` i wskaz `manifest.json` z tego katalogu.

## Konfiguracja

1. Otworz ustawienia dodatku (`Add-ons and Themes -> ThunderAI -> Preferences`).
2. Wpisz:
   - `OpenAI API key`
   - model (domyslnie `gpt-4o-mini`)
   - domyslny jezyk
3. Zapisz ustawienia.

## Uzycie

1. Otworz nowe okno tworzenia wiadomosci.
2. Kliknij przycisk dodatku `Generate with OpenAI`.
3. Wpisz cel maila, wybierz ton i jezyk.
4. Kliknij `Generate and insert`.

Dodatek nadpisze temat i tresc aktualnego draftu wygenerowanym wynikiem.

## Uwagi bezpieczenstwa

- API key jest przechowywany w `messenger.storage.local` w profilu uzytkownika.
- Do produkcji warto rozwazyc backend proxy i tokeny krotkozyciowe zamiast trzymania klucza bezposrednio w kliencie.
