# VATSIM 3D

A 3D perspective view of live VATSIM traffic around one airport (default **EGLL**).

```
node server.mjs        # then open http://localhost:5173/#EGLL
```

No build step and no npm dependencies. The page loads MapLibre GL 4.7.1 and deck.gl 9.0.38 from unpkg.

## Hosting

The whole app is the static `public/` folder, so it runs from any static host.

- **GitHub Pages**: <https://aviatorroyal.github.io/vatsim-3d/>. `.github/workflows/pages.yml` publishes `public/` on every push to `main`.
- **EC2 (ap-south-1)**: <http://16.4.34.135/>. nginx serves `/var/www/vatsim-3d`. Run `deploy/deploy-ec2.sh` to push updates. It defaults to `~/Downloads/ec2_in.pem` and `ubuntu@16.4.34.135`.

## How it works

| Piece | Source |
|---|---|
| Live pilots, controllers, ATIS | [VATSIM Data API v3](https://vatsim.dev/services/apis) `data.vatsim.net/v3/vatsim-data.json`, polled every 15 s (CORS-open, fetched directly by the browser) |
| Airport positions, FIR callsign prefixes | [VATSpy data project](https://github.com/vatsimnetwork/vatspy-data-project) |
| Runway geometry and field elevation | [OurAirports](https://ourairports.com/data/) `runways.csv` |
| Basemaps (no API key) | CARTO Dark/Positron, Esri World Imagery, OpenStreetMap |

- Only pilots within the chosen radius (10–150 NM) are kept and drawn. There's a 5 NM hysteresis so traffic at the edge doesn't flicker in and out.
- Aircraft are low-poly 3D meshes (`public/src/mesh.js`) placed at their altitude above the field. Pitch comes from the vertical rate and bank from the turn rate.
- Between the 15 s reports, positions are dead-reckoned from groundspeed, heading, turn rate and vertical rate. When a new report arrives, any error blends out over 2 s.
- Each aircraft gets a 3D trail, a vertical line down to the ground with a ground shadow, and a label with altitude and groundspeed.
- Online ATC means controllers whose callsign prefix matches the airport ICAO, its IATA code or its FIR's prefixes (for EGLL: `EGLL_`, `LHR_`, `LON_`, `LTC_`), plus the airport ATIS.

## Controls

- **Right-drag / Ctrl+drag**: rotate and tilt. **Scroll**: zoom.
- Click an aircraft (or a row in the Traffic list) to select it. **Follow** turns on a chase camera. Press `Esc` to deselect.
- Altitude exaggeration (1–6×) makes vertical separation easier to read.
- Switch airport with the ICAO box or the URL hash (`#EGKK`, `#KJFK`, …).

Colours: orange = departing, cyan = arriving, purple = local, grey = other, yellow = selected.
