# VATSIM 3D

A 3D perspective view of live VATSIM traffic around one airport (default **EGLL**).

```
node server.mjs          # site: open http://localhost:5173/#EGLL
node server/tracks.mjs   # optional, second terminal: flight-path store for full trails
```

No build step and no npm dependencies to run it (Node 18+). The page loads MapLibre GL 4.7.1 and deck.gl 9.0.38 from unpkg. `npm install` is only needed to rebuild the 3D models (see [MODELS.md](MODELS.md)).

## Hosting

The site is the static `public/` folder, so it runs from any static host. Full flight paths also need the flight-path store below. Without it, trails start from when the page was opened.

- **GitHub Pages**: <https://aviatorroyal.github.io/vatsim-3d/>. `.github/workflows/pages.yml` publishes `public/` on every push to `main`.
- **EC2 (ap-south-1)**: <http://16.4.34.135/>. nginx serves `/var/www/vatsim-3d` and the flight-path API. Run `deploy/deploy-ec2.sh` to push updates (site and API). It defaults to `~/Downloads/ec2_in.pem` and `ubuntu@16.4.34.135`.

### Scanner blocking

Bots scan every public server for leaked secrets (`/.env`, `/.git/config`, `info.php` …). nginx closes those requests without replying (dotfiles other than `/.well-known/`, and any `.php`). fail2ban's `nginx-probe` jail (`deploy/fail2ban/`) bans an address after 3 such requests in 10 minutes: 1 day at first, doubling for repeat offenders up to 4 weeks. Localhost and the Tailscale network are never banned. Check it with `sudo fail2ban-client status nginx-probe`, and unban with `sudo fail2ban-client set nginx-probe unbanip <ip>`.

### Flight-path store (`server/tracks.mjs`)

A small Node service (no dependencies) on the EC2 host records the path of **every** pilot on VATSIM, so a trail shows the whole flight so far, not just the part this page has seen.

- It polls the Data API every 15 s and keys each flight by CID + callsign. Points are thinned as they arrive: straight, level flight needs few points.
- **Reconnects.** A pilot who disconnects before landing is kept for **1 hour**. If they come back in that time, the path continues and the client draws a straight, fainter line from the last known point to the new one.
- **Completed flights.** A flight is complete once it has been airborne and then reports two positions in a row on the ground at an airfield (under 45 kt, within 300 ft of the field elevation, within 5 NM of the field). When that pilot disconnects, the flight is freed straight away. If they take off again while still connected, a new flight starts.
- The store is saved to disk every minute and on shutdown, so a restart keeps the paths.
- API: `GET /api/tracks?cs=BAW123,EZY45` returns the points as `[lon, lat, altFt, unixSec, flags]` (flag 1 = reconnect gap, 2 = on the ground). `GET /api/health` gives counts and memory use.
- nginx forwards `/api/` to it on `127.0.0.1:8787`. It runs as the systemd unit `vatsim-tracks` with a 400 MB memory cap.
- GitHub Pages is HTTPS, so it calls the API at `https://16-4-34-135.sslip.io/api/`. nginx serves that with a Let's Encrypt certificate, which certbot renews automatically. `deploy/deploy-ec2.sh --https` gets the certificate on a fresh host, and port 443 must be open in the security group.
- Local: run `node server/tracks.mjs` next to `node server.mjs`, which forwards `/api/` to it. Scenario test: `node tools/test-tracks.mjs`.

## How it works

| Piece | Source |
|---|---|
| Live pilots, controllers, ATIS | [VATSIM Data API v3](https://vatsim.dev/services/apis) `data.vatsim.net/v3/vatsim-data.json`, polled every 15 s (CORS-open, fetched directly by the browser) |
| Airport positions, FIR callsign prefixes | [VATSpy data project](https://github.com/vatsimnetwork/vatspy-data-project) |
| Runway geometry and field elevation | [OurAirports](https://ourairports.com/data/) `runways.csv` |
| Basemaps (no API key) | CARTO Dark/Positron, Esri World Imagery, OpenStreetMap |

- Only pilots within the chosen radius (10–150 NM) are kept and drawn. There's a 5 NM hysteresis so traffic at the edge doesn't flicker in and out.
- **3D aircraft models.** All 2,788 ICAO Doc 8643 types are sorted into generic classes (narrow-body, wide-body, bizjet, turboprop, helicopter, tandem rotor, fighter, balloon, …). A type with its own model (A320, 737, 777, 787, A350, A380, E190, CRJ, Q400, ATR, Citation, EC135, CH-47 Chinook, F-16, weather balloon, …) uses it. Any other type uses its class's model. Models, licences and the build steps are in [MODELS.md](MODELS.md). There's also a gallery of every model at `/gallery.html`.
- **Model quality switch** (top right, **Models: High / Low**). High shows detailed models from zoom 11 in (airport or approach views). Low always uses the lightweight low-poly mesh (`public/src/mesh.js`) and never downloads a model. The choice is remembered in the browser, and `?quality=low` in the URL overrides it.
- **Performance.** At build time each model's parts are merged into a few draw calls, about 6 per model instead of about 100. At most 8 different models are drawn at once, and up to 12 stay loaded (hidden) so zooming out and back in doesn't reload them. Textures are capped at 512 px. Add `?perf` to the URL to log frame timings to the console. Pitch comes from the vertical rate and bank from the turn rate.
- Between the 15 s reports, positions are dead-reckoned from groundspeed, heading, turn rate and vertical rate. When a new report arrives, any error blends out over 2 s.
- Each aircraft gets a 3D trail of its whole flight so far (from the flight-path store), a vertical line down to the ground with a ground shadow, and a label with altitude and groundspeed. Selecting an aircraft shows when its path starts and how many times the pilot reconnected.
- Online ATC means controllers whose callsign prefix matches the airport ICAO, its IATA code or its FIR's prefixes (for EGLL: `EGLL_`, `LHR_`, `LON_`, `LTC_`), plus the airport ATIS.

## Controls

- **Right-drag / Ctrl+drag**: rotate and tilt. **Scroll**: zoom.
- Click an aircraft (or a row in the Traffic list) to select it. **Follow** turns on a chase camera. Press `Esc` to deselect.
- Altitude exaggeration (1–6×) makes vertical separation easier to read.
- Switch airport with the ICAO box or the URL hash (`#EGKK`, `#KJFK`, …).

Colours: orange = departing, cyan = arriving, purple = local, grey = other, yellow = selected.
