# Blasentagebuch

Eine mobile-first Progressive Web App in Vanilla HTML, CSS und JavaScript. Einträge funktionieren sofort lokal und offline. Mit einem eigenen Supabase-Projekt werden sie über E-Mail-Anmeldung zwischen iPhone, iPad und Mac synchronisiert.

## Enthalten

- Schnellerfassung für `Getränk` und `Urinieren` mit automatischer, editierbarer Uhrzeit
- laufend aktualisierte Uhrzeit, solange sie für den aktuellen Eintrag nicht manuell geändert wurde
- mitgelieferte und eigene Getränketypen, jeweils bearbeitbar
- individuelle Mengenwahl pro Eintrag mit Schnelltasten und freiem Zahlenfeld
- Harndrang bei jedem Toilettengang in den Stufen leicht, mittel oder stark
- sicheres Löschen unbenutzter Getränke; verwendete Vorlagen bleiben geschützt
- medizinische Messtage nach persönlicher Schlaf- und Aufstehzeit statt nach Mitternacht
- Morgenurin als Abschluss der vorherigen Nachtmenge, getrennt von den eigentlichen Nachtgängen
- Tages-/Nachtmengen, Toilettengänge und Durchschnittsmenge
- geräteübergreifend synchronisierte Schlaf-/Aufstehzeiten und Ersatz-Nachtzeit mit rückwirkender Neuberechnung aller Einträge
- Vergleich für 7, 14 oder 30 Tage
- Bearbeiten und Löschen mit synchronisierten Löschmarkierungen
- druckoptimierte Arztansicht für einen frei wählbaren Zeitraum
- offlinefähige PWA und installierbare App-Oberfläche
- automatischer sowie manuell wählbarer Hell-/Dunkelmodus
- Supabase Auth, PostgreSQL und Row Level Security
- automatisches GitHub-Pages-Deployment

## Lokal öffnen

Die App muss über HTTP statt direkt als Datei geöffnet werden, damit PWA und Service Worker funktionieren:

```bash
python3 -m http.server 4173 -d dist
```

Danach `http://localhost:4173` aufrufen. Ohne Supabase bleiben die Daten ausschließlich im Browser dieses Geräts.

## Supabase einrichten

1. Ein neues Supabase-Projekt erstellen.
2. Den Inhalt von `supabase/schema.sql` im Supabase SQL Editor ausführen.
3. Unter **Authentication → Providers** E-Mail/Passwort aktivieren. Für ein privates Ein-Personen-Tagebuch kann die öffentliche Registrierung nach dem ersten Konto wieder deaktiviert werden.
4. Die **Project URL** und den öffentlichen **Publishable Key** aus den API-Einstellungen kopieren.
5. In der App unter **Einstellungen → Synchronisation** beides zusammen mit E-Mail und Passwort eintragen.

### Bestehendes Supabase-Projekt aktualisieren

Wer das Projekt bereits eingerichtet hat, führt im Supabase SQL Editor einmal die noch fehlenden Erweiterungen aus:

1. `supabase/add-user-settings.sql` für die geräteübergreifende Ersatz-Nachtzeit, falls noch nicht geschehen.
2. `supabase/add-sleep-events.sql` für Schlaf- und Aufstehzeiten.

Danach die App neu laden und unter **Einstellungen → Synchronisation → Jetzt synchronisieren** wählen. Schlafzeiten, Nachtzeit und alle bisherigen Einträge werden dann in Tagesansicht, Vergleich, Arztansicht und PDF nach derselben Messtag-Logik ausgewertet. Für ältere Tage ohne erfasste Schlafzeiten verwendet die App weiterhin die eingestellte Ersatz-Nachtzeit und ordnet frühmorgendliche Einträge dem vorherigen Messtag zu.

Der öffentliche Browser-Key ist kein Geheimnis. Der Schutz entsteht durch Authentifizierung und die RLS-Regeln in `schema.sql`. Einen Secret- oder `service_role`-Key niemals in die App oder in GitHub kopieren.

## Auf GitHub Pages veröffentlichen

1. Dieses Verzeichnis in ein GitHub-Repository legen und auf den Branch `main` pushen.
2. In GitHub unter **Settings → Pages → Build and deployment** als Quelle **GitHub Actions** auswählen.
3. Der Workflow `.github/workflows/pages.yml` veröffentlicht den Inhalt von `dist/` automatisch.

Alle Asset-Pfade sind relativ und funktionieren dadurch auch unter einer Projektadresse wie `https://name.github.io/repository/`.

## Datenschutz-Hinweis

Die Anwendung speichert Gesundheitsdaten. Vor echter Nutzung sollten Supabase-Region, Aufbewahrung, Backups, Kontoabsicherung und die rechtlichen Anforderungen des konkreten Einsatzes geprüft werden. Die App ist kein Medizinprodukt und ersetzt keine medizinische Beratung.
