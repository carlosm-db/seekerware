# Actions-IP reachability probe — Colombian boards

Run 2026-08-10T06:42:10.471Z from a GitHub-hosted runner (egress IP 172.215.211.51).
Companion to 2026-08-10-latam-roster-mechanism.md §8/§9.3 — decides runner placement for the
elempleo/Magneto connectors. One fetch per page.

| page | HTTP | bytes | ms | signal |
|---|---|---|---|---|
| elempleo list (trabajo-epm) | 200 | 432409 | 598 | 24 offer links |
| elempleo detail | 200 | 254842 | 486 | JobPosting ld+json: YES |
| magneto list (grupo-exito) | 200 | 561712 | 655 | 20 offer links |
| magneto detail | 200 | 973637 | 2396 | JobPosting ld+json: YES |
| computrabajo home (reference) | 200 | 123614 | 264 |  |

Reading: 200 + offer links + JobPosting=YES on both rows of a source ⇒ the Actions poller can
host that connector directly. A 403/0 row ⇒ that source needs the fallback runner (owner PC /
self-hosted) per §8. Computrabajo is reference-only (expected 403 from datacenter IPs).

**Verdict (recorded 2026-08-10): PASS for both sources — elempleo AND Magneto serve full SSR
pages with JSON-LD JobPosting to GitHub-hosted runner IPs. The elempleo/Magneto connectors run
in the existing Actions poller; no fallback runner needed.** Surprise: even Computrabajo's home
answered 200 (July's blanket-403 finding was likely endpoint- or IP-range-specific) — if
Computrabajo is ever revisited, re-test its deeper pages from Actions first.

Probe artifacts were adopted on `main` on 2026-08-18 (`scripts/probe-co.mjs` +
`.github/workflows/probe-co.yml`), converted to `workflow_dispatch`-only and printing the report to
the job log instead of committing it back (no `contents: write`, no bot commits). The
`probe/actions-ip` branch was deleted. Reusable for the next non-ATS source: point the script at its
list + detail pages and read the same 200 / offer-links / JobPosting=YES signals.
