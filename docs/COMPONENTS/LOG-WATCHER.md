# Log watcher

The app's logs, read for what a query cannot say (`factory logs`). Part of the [runtime plane](README.md#runtime-plane).

- **v1:** three checks, each with its own cursor, reading Loki. Signals count as `factory_signals_total{sense}`.

## New error patterns

Error records are reduced to a pattern:

- numbers, identifiers, hashes, quoted values and the request's own path taken out;
- the exception the record attaches kept.

A pattern is signalled by route when the previous day has not shown it, with the lines and trace ids, and the spans when Tempo already has the trace. The evidence names the route that served the error, or the root when none did, never the request's own path.

Error records are read a page of Loki's at a time, with no cap: the previous day's when it starts, to learn its patterns, and each check's window since the last, so a busy day is never held at once and no record is skipped. A pattern new on one page of a window gathers its records on the pages after: its signal counts them all and shows the last twenty. Loki returns an error record with only the fields the patterns, the signal and Verify read (`ERROR_FIELDS`), not its stack trace and the rest of its metadata.

## Reports

Each record of the widget becomes a `report` signal. The text goes to the inbox, and to no log line, metric label or error message.

## Agreement

Per route, it compares the requests counted in metrics, logged and traced, over two windows that ended minutes ago (Tempo answers late). The odd one out is `missing-log` or `wrong-metric`.

- **Routes.** The metrics and traces name the path asked for; the log names its route. A path takes its route from the window's log, or failing that from the last day's, asked for once an hour. The names are kept between windows, so a gap in the log longer than a day, or a lookup that failed, still finds each page's route. A gap is then one finding per route, not one per page.
- **Metrics.** Each series' counter at the window's end, less its counter at the start, before they are summed: a series with nothing at the start is new and counted from nothing, and one whose counter went down restarted, and counts from nothing too. A series with nothing at the start but a sample in the day before had a gap, and came back with its running total, which says nothing of the window. A route with such a series, in either window of the pair, is not judged, and the watcher logs how many were passed over; it is judged again once a pair of windows has no gap.
- **Traces.** Tempo counts each route's server spans itself, with a TraceQL metrics query, rather than listing their traces, so the count holds every request however busy the window. When Tempo says its answer is partial, the traces are left out and the metrics and the log are judged alone, as when Tempo has none of the window yet.
- **A silent log.** When more than one route's requests are missing from the log, and across every route it holds no more records than an edge of the window explains, the log is silent for everything. That is one `missing-log` signal on every route (`*`), showing the busiest routes' requests beside no records, and none per route. A pair of windows with one of them silent is the edge of the same gap, and is judged as it. Loki that stopped storing the app's records, and an app that stopped writing them, look the same.
