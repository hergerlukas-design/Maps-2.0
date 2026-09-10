# Reichweite — Tank- & Ladestopp-Navigation

Progressive Web App mit Turn-by-Turn-Navigation, die während der Fahrt die
Restreichweite überwacht und rechtzeitig passende, günstige Tankstellen oder
Ladesäulen entlang der Route vorschlägt.

## Was die App tut

- **Vollständige Navigation** von Start bis Ziel: Abbiegehinweise, Spurführung,
  Sprachansagen, automatische Neuberechnung beim Verlassen der Route.
- **Reichweiten-Überwachung im Hintergrund**: Beim Unterschreiten eines frei
  einstellbaren Schwellenwerts (Standard 215 km) fragt die App, ob getankt bzw.
  geladen werden soll.
- **Tank-Abfrage-Flow**: Bei *Ja* erscheinen mehrere Stationen im einstellbaren
  Suchradius (Standard 12 km) — die Auswahl wird als Zwischenstopp in die
  laufende Route eingefügt, nicht als neue Fahrt gestartet. Bei *Nein* fragt die
  App nach dem eingestellten Intervall (Standard 50 km) erneut.
- **Quick-Buttons** für Tankstelle, Ladesäule, Rastplatz und Toilette — die
  Suche läuft ab der aktuellen Position nach vorne, unabhängig vom
  Reichweiten-Schwellenwert.
- **Fahrzeugprofile**: Verbrenner (Super E5, E10, Diesel), Elektro (mit
  Steckertyp und Mindestladeleistung) oder Hybrid.

Die Reichweite wird **manuell eingegeben** und nie aus dem Fahrzeug gelesen.
Nach einem erreichten Stopp fragt die App den neuen Stand ab — sonst würde der
Monitor weiter vom alten Wert herunterzählen.

## Technik

| Bereich | Wahl |
|---|---|
| Frontend | React 19, TypeScript, Vite 8, Tailwind CSS 4 |
| Karte & Routing | Mapbox GL JS + Directions API |
| Backend | Express 5 (liefert Client aus **und** proxied die Daten-APIs) |
| Datenbank & Auth | Supabase (Postgres, Row Level Security) |
| Hosting | Fly.io (Docker) |
| Benachrichtigungen | Web Push (VAPID) + Service Worker |

### Warum ein eigener Server?

Der Express-Server ist keine Bequemlichkeit, sondern nötig:

1. **Schlüssel bleiben geheim.** Der Tankerkönig- und der GoingElectric-Key
   dürfen nicht im Browser-Bundle landen. Alles, was `VITE_` heißt, ist
   öffentlich.
2. **CORS.** Weder Tankerkönig noch GoingElectric senden CORS-Header; direkte
   Aufrufe aus dem Browser scheitern.
3. **Ratenbegrenzung und Cache.** Tankerkönig erlaubt eine Abfrage pro Query
   alle 5 Minuten, Overpass ist gespendete Infrastruktur. Eine Korridorsuche
   über 150 km stellt viele überlappende Kreisanfragen — die gehören
   zusammengefasst und zwischengespeichert, nicht pro Client wiederholt.

Der Mapbox-Token bleibt bewusst im Client: er ist für den Browser-Einsatz
gedacht und wird über Domain-Beschränkungen in der Mapbox-Konsole abgesichert.

## Datenquellen

| Zweck | Quelle | Key nötig |
|---|---|---|
| Kraftstoffpreise | Tankerkönig | ja (kostenlos, per Formular) |
| Ladesäulen | GoingElectric | ja (kostenlos, formlos per Mail) |
| Ladesäulen (Fallback) | Open Charge Map | nein (Key hebt das Limit an) |
| Rastplätze, Toiletten | OpenStreetMap Overpass | nein |
| Karte, Routing, Adresssuche | Mapbox | ja |

Fehlt ein Key, degradiert die App sichtbar statt zu scheitern: ohne
GoingElectric-Key wird automatisch Open Charge Map genutzt, ohne
Tankerkönig-Key meldet die Stopp-Suche das im UI, und unter *Einstellungen →
Datenquellen* steht, was gerade fehlt.

## Einrichtung

```bash
npm install
cp .env.example .env      # Schlüssel NUR in .env eintragen, nie in .env.example
npm run dev               # Client auf :5173, API auf :8787
```

`.env.example` ist eine Vorlage und liegt im Git — echte Schlüssel gehören
ausschließlich in die daraus kopierte `.env`, die per `.gitignore` ausgeschlossen
ist. Trägt man sie versehentlich in die Vorlage ein, blockiert GitHubs Push
Protection den Push.

`npm run dev` startet beides; Vite proxied `/api` an den Express-Server.

Ohne Mapbox-Token startet die App, zeigt aber statt der Karte einen Hinweis —
das ist beabsichtigt, damit sich der Rest der Oberfläche auch ohne Konto
ansehen lässt.

### Supabase

Ein Supabase-Projekt ist **optional**: Routenplanung und Navigation laufen ohne
Konto, Einstellungen liegen dann lokal im Browser.

Mit Projekt:

```bash
supabase db push          # oder den Inhalt der Migrationen im SQL-Editor ausführen
```

Die Migrationen liegen in `supabase/migrations/` und legen an:

- `profiles`, `vehicles`, `settings`, `favorites`, `trips`, `push_subscriptions`
- Row Level Security auf allen Tabellen — jeder Nutzer sieht ausschließlich
  eigene Zeilen
- CHECK-Constraints, die dieselben Grenzen erzwingen wie die UI
- einen Trigger, der bei jeder Registrierung Profil und Standardeinstellungen
  anlegt

`0002` entzieht den beiden Trigger-Funktionen das EXECUTE-Recht für `anon` und
`authenticated`: PostgREST veröffentlicht sonst jede Funktion im public-Schema
auch als `/rest/v1/rpc/…`, und `handle_new_user()` läuft als SECURITY DEFINER.

Nach dem Einspielen lohnt sich ein Blick auf die Advisories:

```bash
supabase inspect db          # oder im Dashboard unter Advisors
```

### Web Push

Ohne VAPID-Schlüsselpaar funktionieren die Hinweise in der geöffneten App
weiterhin — nur Push bei geschlossener App entfällt.

**Ohne Terminal:** Der Workflow *VAPID-Schlüssel erzeugen* (Reiter *Actions*)
erzeugt das Paar im Runner und legt es direkt als Fly-Secret ab. Der private
Schlüssel wird maskiert, nicht ausgegeben und nicht als GitHub-Secret
gespeichert. Als `subject` eine Kontaktadresse angeben (`mailto:…`), die die
Push-Dienste bei Problemen anschreiben können.

Der Workflow bricht ab, wenn bereits Schlüssel hinterlegt sind. Das ist
Absicht: Ein neues Paar macht **jede bestehende Push-Anmeldung ungültig**, weil
die Geräte den alten öffentlichen Schlüssel gespeichert haben. Bewusstes
Ersetzen geht über die Option `force_regenerate`.

**Am eigenen Rechner:**

```bash
npx web-push generate-vapid-keys
```

Die beiden Werte als `VAPID_PUBLIC_KEY` und `VAPID_PRIVATE_KEY` setzen.

## Deployment (Fly.io)

Zwei Wege. Der erste braucht kein Terminal und funktioniert auch vom Handy.

### A) Per GitHub Actions — ohne Terminal

Einmalig einzurichten, danach ist jeder Deploy ein Knopfdruck.

**1. Fly-Konto und Token.** Auf [fly.io](https://fly.io) registrieren, dann unter
*Account → Access Tokens* ein Token erstellen (Typ: Deploy Token). Der Wert
beginnt mit `Fly...` bzw. `fm2_...`.

**2. Secrets im Repository hinterlegen.** Auf GitHub im Repo:
*Settings → Secrets and variables → Actions → New repository secret*.

| Name | Pflicht | Wofür |
|---|---|---|
| `FLY_API_TOKEN` | ja | Deploy-Berechtigung |
| `VITE_MAPBOX_TOKEN` | ja | Karte, Routing, Adresssuche |
| `VITE_SUPABASE_URL` | nein | Konten und Synchronisierung |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | nein | dito |
| `TANKERKOENIG_API_KEY` | nein | Kraftstoffpreise |
| `GOINGELECTRIC_API_KEY` | nein | Ladesäulen (sonst Open Charge Map) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | nein | Web Push |

Alles außer den ersten beiden ist optional — fehlt ein Wert, schaltet die App
die betroffene Funktion sichtbar ab, statt zu scheitern.

**3. Deploy auslösen.** Reiter *Actions* → *Deploy zu Fly.io* → *Run workflow*.

Der Workflow prüft erst Typen und Tests und liefert nur bei grüner Suite aus.
Die Adresse der laufenden App steht danach in der Zusammenfassung des Laufs.

Die Aufteilung ist bewusst: `VITE_*`-Werte werden als `--build-arg` übergeben,
weil sie zur Build-Zeit ins Browser-Bundle eingebacken werden. Die Server-Keys
gehen als Fly-Secrets raus (`--stage`, damit kein zusätzlicher Neustart
entsteht) und landen dadurch nie im Image.

### B) Vom eigenen Rechner

```bash
fly launch --no-deploy --copy-config
fly secrets set TANKERKOENIG_API_KEY=… GOINGELECTRIC_API_KEY=… \
                VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=… VAPID_SUBJECT=mailto:…
fly deploy --build-arg VITE_MAPBOX_TOKEN=… \
           --build-arg VITE_SUPABASE_URL=… \
           --build-arg VITE_SUPABASE_PUBLISHABLE_KEY=…
```

## Projektstruktur

```
shared/types.ts          Vertrag zwischen Client und Server
server/
  providers/             Adapter: Tankerkönig, GoingElectric/OCM, Overpass
  routes/                /api/stops/*, /api/push/*
  lib/                   TTL-Cache, Ratenbegrenzung, Validierung
src/
  lib/geo.ts             Haversine, Snapping, Korridor-Sampling, Polylines
  navigation/engine.ts   Turn-by-Turn-Zustandsmaschine
  navigation/rangeMonitor.ts  Schwellenwert, Nachfrage-Intervall, kritische Reichweite
  services/              Mapbox, Supabase, Stopp-Suche und Bewertung, Push
  hooks/                 Geolocation, Wake Lock, Sprache, Session-Orchestrierung
  components/            Karte, Navigations-UI, Planer, Einstellungen, Konto
  sw.ts                  Service Worker: Precache, Kachel-Cache, Push
supabase/migrations/     Schema mit RLS
```

## Tests

```bash
npm test        # 66 Tests
npm run build   # Client
npm run build:server
```

Getestet ist die Logik, die sich ohne Karte, Browser und Netz prüfen lässt und
bei der Fehler teuer wären:

- **Geometrie** — Distanzen, Projektion auf Segmente, Snapping mit Suchfenster,
  Korridor-Sampling, Polyline-Dekodierung
- **NavigationEngine** — Fortschritt, Schrittwechsel, Bannerauswahl,
  Sprachansagen genau einmal, Off-Route-Erkennung bei schlechtem GPS,
  Wegpunkt- und Zielankunft
- **RangeMonitor** — Schwellenwert, 50-km-Nachfrage nach einem „Nein",
  kritische Reichweite trotz Snooze, kein Nachfragen wenn das Ziel in
  Reichweite liegt
- **Bewertung** — Preis gegen Umweg, Ladeleistung gegen Umweg, Dubletten aus
  zwei Ladesäulen-Quellen

## Bekannte Grenzen

- **Hintergrund-Tracking** ist im Web begrenzt. Solange die App offen ist
  (Display an oder Wake Lock aktiv), läuft die Überwachung zuverlässig. Friert
  der Browser den Tab ein, pausiert sie — eine echte Hintergrundverfolgung wie
  bei einer nativen App gibt es im Web nicht.
- **iOS** stellt Web Push nur bereit, wenn die PWA über *Teilen → Zum
  Home-Bildschirm* installiert und von dort gestartet wurde. Die App erkennt das
  und sagt es unter *Einstellungen → Benachrichtigungen prüfen*.
- **Akku**: `watchPosition` mit hoher Genauigkeit plus Wake Lock ist teuer. Das
  Display-Anlassen ist deshalb abschaltbar.
- **Ladesäulen-Verfügbarkeit** ist bei keiner der beiden Quellen zuverlässig in
  Echtzeit verfügbar; die App zeigt sie nur, wo sie gemeldet wird.
- Der Preis-Cache liegt im Prozess. Bei mehreren Fly-Maschinen hätte jede ihren
  eigenen — dann wäre Redis der nächste Schritt.
