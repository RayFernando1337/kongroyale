# Memory by device

`devices.json` holds the numbers behind the dashboard's "Memory by device" page, and `device-chart.mts` draws them as one line chart per metric, release by release, for each kind of computer. The page is built by `build.mts` with the rest of the dashboard.

## Adding a measurement

1. Add a method to `methods` if the run used a new harness or machine: a short `label`, the `device`, the `method` in plain words, and the `source` (the drive folder or report it came from).
2. Add a point to the line it belongs to, in the release slot of the newest tag the build contains (`git describe --tags --match 'kong-v*' <sha>`): `main` for builds after the newest release.

```json
{ "slot": "main", "mb": 6900, "low": 6850, "high": 6950, "kind": "measured", "build": "main 0c1713f", "m": "safari-gate", "n": 2, "date": "2026-11-07", "note": "..." }
```

| Field | Meaning |
|---|---|
| `mb` | The value in MB. The page writes it in GB of 1,000 MB, as the measurement reports do |
| `low`, `high` | The spread across runs, drawn as a whisker. Leave them out for a single run |
| `kind` | `measured`, `estimate` or `planned`. Estimates and plans need a `note` with the arithmetic and `n: 0`; plans also name their `work` |
| `killed` | Safari closed the tab in the run |
| `m`, `n`, `date` | The method id, the number of runs, and the date (UTC) |

`readDevices` throws when a point lacks any of these, so a build fails rather than shows a number without its source. A line with `"same": "sku/chart/line"` copies another line's points, which is how the 12 GB and 8 GB Macs reuse the 16 GB Mac's Safari numbers against their estimated limits.

When RAY-227's 12 GB and 10 GB measurement lands in the project drive (handoffs/mem-12gb/), add its main points to the 16 GB Mac charts (defaults and a low-memory line for `?lowmem=1&geofree=1&farimp=1`), and replace the estimated limits on the 12 GB chart with its own.
