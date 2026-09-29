# strava_sync.py — Hevy -> Strava (name + description)

## HR

**Što radi.** Nakon treninga snage Garmin fenix 8 na Strava uploada "Weight Training" aktivnost s neupotrebljivom listom vježbi (automatska detekcija sata). Istina je Hevy trening. Skripta pronađe svaku Strava aktivnost tipa WeightTraining/Workout, upari je s Hevy treningom istog vremena (preklapanje termina, tolerancija 30 min) i prepiše **naziv** (= naslov iz Hevyja) i **opis** (čist zapis: `Front Squat — 60×6 (wu) · 80×10 @7.5 · …`, ukupni tonaža radnih serija, broj serija, teške serije RPE≥7, bilješke, podnožje `— synced from Hevy`). Strava API ne dopušta uređivanje same liste vježbi, samo naziv/opis — zato opis nosi čisti zapis.

Oznake: `(wu)` zagrijavanje (ne ulazi u tonažu), `(f)` do otkaza, `(d)` dropset, `@7.5` = RPE, `BW×8` = tjelesna težina.

**Jednokratno postavljanje (radiš ti; skripta nikad ne traži lozinke):**

1. Napravi Strava API aplikaciju na https://www.strava.com/settings/api — Application name: bilo što, Category: **Data Importer**, Website: `http://localhost`, Authorization Callback Domain: `localhost`. Kopiraj **Client ID** i **Client Secret** u
   `C:\Users\patri\.claude\cache\daily-dashboard\secrets\strava.json`
   (skripta pri prvom pokretanju sama napravi predložak).
2. Hevy Pro API ključ s https://hevy.com/settings?developer upiši u
   `C:\Users\patri\.claude\cache\daily-dashboard\secrets\hevy.env` kao `HEVY_API_KEY=...`
   (nije potreban uz `--hevy-source freddy-cache`).
3. Jednom pokreni `python tools/strava_sync.py auth` i klikni **Authorize** u pregledniku (callback `http://localhost:8765/callback`).
4. Pokreni `python tools/strava_sync.py sync --days 7 --dry-run`, pa ako plan izgleda dobro `python tools/strava_sync.py sync --days 7`.

**Naredbe**

```
python tools/strava_sync.py auth
python tools/strava_sync.py sync --days 7 [--dry-run] [--force] [--hevy-source api|freddy-cache]
python tools/strava_sync.py selftest
python tools/strava_sync.py fetch-hr [--days N | --since YYYY-MM-DD] [--force]
python tools/hevy_fetch.py [--days N | --all] [--since YYYY-MM-DD]
```

- Već sinkronizirane aktivnosti (opis sadrži `— synced from Hevy`) se preskaču osim uz `--force`.
- Postojeći opis bez našeg podnožja bit će **zamijenjen** (dry-run to naznači).
- `--hevy-source freddy-cache` čita sirove Hevy JSON-ove iz `C:\Users\patri\.claude\cache\daily-dashboard\strength\raw\hevy\*.json`.
- Izlazni kodovi: 0 ok, 2 treba postavljanje (nedostaju ključevi/tokeni), 3 dnevni Strava limit, 1 ostale greške.
- Tajne se nikad ne ispisuju i žive izvan repozitorija; `tools/` je u `.assetsignore` pa se ne deploya.

**Determinističko punjenje cachea za `build_strength.py` (bez ručnog prepisivanja):**

- `hevy_fetch.py` povlači treninge s Hevy API-ja (`/v1/workouts`, novije → starije, plus `/v1/workouts/events` za izmijenjene/obrisane) i sprema ih doslovno (oblik API-ja) kao `strength\raw\hevy\<datum start_time>_<id>.json`. Postojeći zapis se zamijeni samo ako je `updated_at` noviji (stari se zadrži kao `__superseded` samo ako se `start_time` promijenio); obrisani treninzi idu u `hevy\_deleted\`. Ključ iz `secrets\hevy.env`. Zadano `--days 14`.
- `strava_sync.py fetch-hr` za svaku WeightTraining/Workout aktivnost u prozoru (zadano 14 dana) povlači `time,heartrate` stream i piše `strength\raw\strava_hr\<lokalni datum>_<strava id>.json` u Garmin shemi (`startTime`, `sampleCount`, `streams.heart_rate.values`, `timestamps`) plus `source:"strava"`, `stravaId`, `name`. Postojeće datoteke se preskaču osim uz `--force`; 429 i `X-RateLimit-Usage` se poštuju. Ispisuje samo brojače.
- `build_strength.py` preferira `raw\strava_hr` pred `raw\garmin_hr` kad oba imaju istu aktivnost (start unutar 2 min); Strava-only datoteka se koristi kakva jest. Izvor je u izlazu kao `hr.source` (`strava` | `garmin`).

**Jutarnja rutina (kasnije):** nakon osvježavanja podataka pozvati `python tools/strava_sync.py sync --days 3` (po potrebi `--hevy-source freddy-cache` kad je cache svjež). Ako vrati kod 2, samo preskočiti korak i javiti da treba postavljanje.

## EN

**What it does.** After a gym session the Garmin fenix 8 uploads a "Weight Training" activity to Strava with a garbage exercise list (watch auto-detection). The truth is the Hevy workout. The script finds each Strava WeightTraining/Workout activity, matches it to the Hevy workout of the same time (time overlap, 30 min tolerance) and rewrites the Strava **name** (= Hevy title) and **description** (clean per-exercise log, work tonnage, set count, hard sets RPE>=7, notes, footer `— synced from Hevy`). Strava's API cannot edit the set list itself, only name/description, so the description carries the log.

Markers: `(wu)` warm-up (excluded from tonnage), `(f)` failure, `(d)` dropset, `@7.5` RPE, `BW×8` bodyweight.

**One-time setup (you do this; the script never asks for passwords):**

1. Create a Strava API application at https://www.strava.com/settings/api — Application name anything, Category **Data Importer**, Website `http://localhost`, Authorization Callback Domain `localhost`. Copy Client ID + Client Secret into `C:\Users\patri\.claude\cache\daily-dashboard\secrets\strava.json` (a template is created on first run).
2. Put the Hevy Pro API key from https://hevy.com/settings?developer into `C:\Users\patri\.claude\cache\daily-dashboard\secrets\hevy.env` as `HEVY_API_KEY=...` (not needed with `--hevy-source freddy-cache`).
3. Run `python tools/strava_sync.py auth` once and click **Authorize**.
4. Run `python tools/strava_sync.py sync --days 7 --dry-run`, then `python tools/strava_sync.py sync --days 7`.

**Deterministic cache fill for `build_strength.py` (no manual transcription):**

- `hevy_fetch.py` pulls workouts from the Hevy API (`/v1/workouts` newest to oldest, plus `/v1/workouts/events` for edited/deleted ones) and stores each verbatim (the API's shape) as `strength\raw\hevy\<start_time date>_<id>.json`. An existing file is replaced only when the API's `updated_at` is newer (the old copy is kept as `__superseded` only if `start_time` changed); deleted workouts move to `hevy\_deleted\`. Key from `secrets\hevy.env`. Default `--days 14`.
- `strava_sync.py fetch-hr` fetches the `time,heartrate` stream of every WeightTraining/Workout activity in the window (default 14 days) and writes `strength\raw\strava_hr\<local date>_<strava id>.json` in the Garmin schema (`startTime`, `sampleCount`, `streams.heart_rate.values`, `timestamps`) plus `source:"strava"`, `stravaId`, `name`. Existing files are skipped unless `--force`; 429 and `X-RateLimit-Usage` are honoured. Prints counts only.
- `build_strength.py` prefers `raw\strava_hr` over `raw\garmin_hr` when both hold the same activity (start within 2 min); a Strava-only file is used as is. The choice is recorded as `hr.source` (`strava` | `garmin`).

Activities already carrying the footer are left alone unless `--force`. An existing description without our footer is replaced (dry-run flags it). Exit codes: 0 ok, 2 setup needed, 3 daily rate limit, 1 other errors. Rate limits: `X-RateLimit-*` headers are read; the script waits for the next 15-minute window when nearly spent, and stops on the daily limit.

**Morning routine (later):** after the data refresh, call `python tools/strava_sync.py sync --days 3`; on exit code 2 skip the step and report that setup is pending.
