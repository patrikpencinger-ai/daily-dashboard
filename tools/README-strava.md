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
python tools/strava_sync.py sync --days 7 [--dry-run] [--force] [--hevy-source api|freddy-cache] [--via-worker | --direct]
python tools/strava_sync.py selftest
python tools/strava_sync.py fetch-hr [--days N | --since YYYY-MM-DD] [--force] [--dry-run] [--via-worker | --direct]
python tools/hevy_fetch.py [--days N | --all] [--since YYYY-MM-DD]
```

**Jedan vlasnik Strava tokena (Worker).** Strava može rotirati refresh token pri svakom osvježavanju. Kad token osvježavaju dva klijenta (Worker `hevy-hook` u KV `strava:tokens` i lokalni `secrets\strava.json`), jedan može poništiti drugoga, a jutarnja rutina tada tiho puca. Zato je **Worker jedini Strava API klijent**. `fetch-hr` i `sync` zadano idu preko Workera kad god postoji `secrets\hevy-webhook.txt`. Tada se pozivaju `GET https://hevy.er45.com/live/hr?since=…`, `GET /live/hr/<id>` i `POST /live/strava/sync?days=N`, a zaglavlje `Authorization` nosi vrijednost iz te datoteke (nikad se ne ispisuje). Datoteke u `raw\strava_hr` imaju isto ime i isti sadržaj kao prije. `--via-worker` forsira taj put.
- `--direct` = **samo za hitne slučajeve** (Worker ne radi): skripta tada zove Stravu izravno sa `strava.json`, pa opet postoje dva vlasnika tokena. Nakon toga pokreni `python tools/strava_sync.py auth`, pa `powershell -ExecutionPolicy Bypass -File tools\set_live_secrets.ps1 -Only STRAVA_REFRESH_TOKEN`.
- `auth` ostaje lokalan; služi samo za novi početni token koji se zatim preda Workeru.
- Preko Workera `sync` koristi Hevy ključ Workera (`--hevy-source` vrijedi samo uz `--direct`) i toleranciju uparivanja od ±90 min (lokalno 30 min). Jedan poziv obradi najviše 25 aktivnosti; ostatak ispiše kao `deferred`.
- Izlazni kodovi preko Workera: 0 ok; 2 = Worker odbija ključ (401), nedostaju tajne ili Strava token (503) ili nema `hevy-webhook.txt`; 3 = Strava limit; 1 = Worker nedostupan ili druga greška (mrežne greške i 5xx se ponove dvaput).

- Već sinkronizirane aktivnosti (opis sadrži `— synced from Hevy`) se preskaču osim uz `--force`.
- Postojeći opis bez našeg podnožja bit će **zamijenjen** (dry-run to naznači).
- `--hevy-source freddy-cache` čita sirove Hevy JSON-ove iz `C:\Users\patri\.claude\cache\daily-dashboard\strength\raw\hevy\*.json`.
- Izlazni kodovi: 0 ok, 2 treba postavljanje (nedostaju ključevi/tokeni), 3 dnevni Strava limit, 1 ostale greške.
- Tajne se nikad ne ispisuju i žive izvan repozitorija; `tools/` je u `.assetsignore` pa se ne deploya.

**Determinističko punjenje cachea za `build_strength.py` (bez ručnog prepisivanja):**

- `hevy_fetch.py` povlači treninge s Hevy API-ja (`/v1/workouts`, novije → starije, plus `/v1/workouts/events` za izmijenjene/obrisane) i sprema ih doslovno (oblik API-ja) kao `strength\raw\hevy\<datum start_time>_<id>.json`. Postojeći zapis se zamijeni samo ako je `updated_at` noviji (stari se zadrži kao `__superseded` samo ako se `start_time` promijenio); obrisani treninzi idu u `hevy\_deleted\`. Ključ iz `secrets\hevy.env`. Zadano `--days 14`.
- `strava_sync.py fetch-hr` za svaku WeightTraining/Workout aktivnost u prozoru (zadano 14 dana) povlači `time,heartrate` stream i piše `strength\raw\strava_hr\<lokalni datum>_<strava id>.json` u Garmin shemi (`startTime`, `sampleCount`, `streams.heart_rate.values`, `timestamps`) plus `source:"strava"`, `stravaId`, `name`. Postojeće datoteke se preskaču osim uz `--force`; 429 i `X-RateLimit-Usage` se poštuju. Ispisuje samo brojače.
- `build_strength.py` preferira `raw\strava_hr` pred `raw\garmin_hr` kad oba imaju istu aktivnost (start unutar 2 min); Strava-only datoteka se koristi kakva jest. Izvor je u izlazu kao `hr.source` (`strava` | `garmin`).

**Jutarnja rutina:** naredbe su iste kao prije (`fetch-hr --days 3`, `sync --days 3`, REFRESH.md §1f), ali sada idu preko Workera. Ako Worker ne radi, korak završi s kodom različitim od 0; rutina to zapiše u izvještaj i nastavi. `--direct` se ne koristi rutinski.

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

**Single Strava token owner (the Worker).** Strava may rotate the refresh token on any refresh. With two refreshers (the `hevy-hook` Worker's KV `strava:tokens` and the local `secrets\strava.json`), one can invalidate the other, and the morning pipeline then breaks silently. So the **Worker is the only Strava API client**. `fetch-hr` and `sync` go through it by default whenever `secrets\hevy-webhook.txt` exists. They call `GET https://hevy.er45.com/live/hr?since=…`, `GET /live/hr/<id>` and `POST /live/strava/sync?days=N`, with that file's value as the `Authorization` header (never printed). The `raw\strava_hr` files keep the same names and the same bytes as before. `--via-worker` forces this route.
- `--direct` is for **emergencies only** (the Worker is down). It calls Strava with `strava.json` and so re-establishes a second token owner. Afterwards run `python tools/strava_sync.py auth`, then `powershell -ExecutionPolicy Bypass -File tools\set_live_secrets.ps1 -Only STRAVA_REFRESH_TOKEN`.
- `auth` stays local; it only produces a fresh seed token for the Worker.
- Via the Worker, `sync` uses the Worker's Hevy key (`--hevy-source` applies to `--direct` only) and a ±90 min match tolerance (30 min locally). One call handles at most 25 activities; the rest are reported as `deferred`.
- Exit codes via the Worker: 0 ok; 2 = the Worker rejects the key (401), secrets or the Strava token are missing (503), or there is no `hevy-webhook.txt`; 3 = Strava rate limit; 1 = the Worker is unreachable or another error (network errors and 5xx are retried twice). `fetch-hr --dry-run` lists what would be fetched and writes nothing.

Activities already carrying the footer are left alone unless `--force`. An existing description without our footer is replaced (dry-run flags it). Exit codes: 0 ok, 2 setup needed, 3 daily rate limit, 1 other errors. Rate limits: `X-RateLimit-*` headers are read; the script waits for the next 15-minute window when nearly spent, and stops on the daily limit.

**Morning routine:** the commands are unchanged (`fetch-hr --days 3`, `sync --days 3`, REFRESH.md §1f), but they now go via the Worker. If the Worker is down, the step exits non-zero; the routine logs it in the report and continues. `--direct` is never used in the routine.


## Mac cron (svakih 30 min) / Mac cron (every 30 min)

**HR.** Na Mac miniju `launchd` agent `com.dash.strength-pipeline` svakih 30 min pokreće `tools/strength_cron.sh`: `git pull --ff-only` → `hevy_fetch.py --days 3` → `strava_sync.py fetch-hr --days 3` → `build_strength.py`. Ako se promijenio sadržaj `strength-data.json` (sam `meta.refreshedAt` se ne računa) ili `training-data.json` (`volWork`), skripta commita po imenu (`strength: YYYY-MM-DD HH:MM`), pusha na `origin/main` i provjeri da je `origin == HEAD`. Uvijek šalje heartbeat `POST https://hevy.er45.com/live/pipeline` (`Authorization` = `secrets/hevy-webhook.txt`, JSON `{host, ranAt, changed, commit, durationS, errors}`; non-2xx se samo zapiše). Preskače se dok postoji svjež (< 90 min) `~/.claude/cache/daily-dashboard/routine.lock`, koji jutarnja rutina stvara na početku i briše na kraju. Log: `~/.claude/cache/daily-dashboard/strength/cron.log` (rotacija na 1 MB). Izlazni kodovi: 0 ok/preskočeno, 1 korak cjevovoda pao, 2 `git pull --ff-only` nije uspio, 3 commit/push nije uspio, 4 postavke (nema repoa/pythona, neočekivani lokalni commiti ili prljave generirane datoteke). Python na Macu je 3.9: `build_strength.py` zato zamjenjuje `sum()` za floatove s `math.fsum` (Python 3.12+ već zbraja kompenzirano pa su izlazi na PC-u i Macu jednaki).

Instalacija: `cp tools/launchd/com.dash.strength-pipeline.plist ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dash.strength-pipeline.plist`; odmah: `launchctl kickstart -k gui/$(id -u)/com.dash.strength-pipeline`; uklanjanje: `launchctl bootout gui/$(id -u)/com.dash.strength-pipeline`.

**EN.** On the Mac mini a `launchd` agent `com.dash.strength-pipeline` runs `tools/strength_cron.sh` every 30 min (steps above). It commits by name and pushes only when the content of `strength-data.json` (ignoring `meta.refreshedAt`) or `training-data.json` (`volWork`) changed, verifies `origin == HEAD`, and always POSTs a heartbeat to `/live/pipeline` (non-2xx is logged, not fatal). It skips while a fresh (< 90 min) `routine.lock` exists; the morning routine creates it at the start and removes it at the end (REFRESH.md §1f). Exit codes: 0 ok/skipped, 1 pipeline step failed, 2 pull not fast-forward, 3 commit/push failed, 4 setup problem. Python 3.9 on the Mac: `build_strength.py` shadows `sum()` with `math.fsum` for floats so a 3.9 build equals a 3.12+ build byte for byte (apart from `refreshedAt`).
