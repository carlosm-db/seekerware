# Company discovery — toward ~300 on-target companies

Resumable source of truth for the roster-growth task (plan approved 2026-07-22). Balanced across the
three live tracks. **Dedup before spend · verify once · no agents · count ≠ benefit.** Prod adds are
owner-run (`INSERT OR IGNORE` / paste into `/companies/add-urls`).

Progress: **120 active** (was 112; +8 added 2026-07-22, batches 1–3: 6 canada_coop + 2 colombia_perm) +
Nubank token fix (GH→Ashby) applied · target ~300 · remaining: **~180** (see Structural finding —
likely canada_coop-heavy). Added boards seed silently on their next poll (rule 4).

## On-target rubric (from the live `scoring` config, 2026-07-22)

- **canada_coop** — job LOCATION contains one of: canada, can, cad, vancouver, toronto, montreal,
  calgary, ottawa, british columbia, ontario, alberta. → Canadian employers (co-op / new-grad / skilled).
- **colombia_perm** — LOCATION contains: colombia, bogota, medellin, latam, latin america, south/central
  america, americas, worldwide, anywhere, global. REJECT if text says US-only / no sponsorship / must
  reside in US. → employers hiring in Colombia/LATAM.
- **contractor_usd** — LOCATION contains: remote, distributed, home based, teletrabajo, anywhere,
  worldwide, global. REJECT if location is geo-restricted (united states/usa/us, canada, uk, europe/emea,
  apac/asia/india, brazil, named US cities, hybrid). → globally-open remote (LATAM-eligible).

A candidate counts as on-target only if a **verify-once** board fetch shows ≥1 job whose location clears
one track's gate (verdict ≠ Skip under the live calibration).

## Dead / wrong tokens to fix (Phase 0)

| Company | ATS | Current token | Status | Resolution |
|---|---|---|---|---|
| Nubank | greenhouse | nubank | GH board empty (200/0 jobs) | **Moved to Ashby** — `ashby/nubank` = 98 jobs incl. Bogotá 9, Toronto 3. Fix: `UPDATE companies SET ats='ashby' WHERE token='nubank' AND ats='greenhouse'` (no (ashby,nubank) conflict). |
| SURA | successfactors | trabajaconnosotros.sura.com | Public feed empty (200, empty urlset + empty RSS) | No error, 0 jobs — harmless. Leave active, revisit; deactivate later if it stays empty. |

## Verified additions (per batch) — pending owner approval before add

### Batch 1 (2026-07-22) — 3 verified on-target
| Name | ATS | Token | Track | Evidence |
|---|---|---|---|---|
| Aylo | greenhouse | aylo | canada_coop | Montréal ×14 |
| Thinkific | greenhouse | thinkific | canada_coop | Distributed - Canada |
| Twilio | greenhouse | twilio | colombia_perm | Remote - Colombia ×17 (of 354; rest Skip via gates) |

Dropped: Render (ashby, remote=US-only), Linear (ashby, "North America" clears no gate).

### Batch 2 (2026-07-22) — 3 verified on-target
| Name | ATS | Token | Track | Evidence |
|---|---|---|---|---|
| Dialpad | greenhouse | dialpad | canada_coop | Vancouver ×11, Kitchener ×10 |
| D2L | greenhouse | d2l | canada_coop | Kitchener/Toronto/Vancouver Canada |
| Jane (Jane App) | ashby | jane | canada_coop | Canada ×20 |

Dropped: Kavak (lever, "Mexico City/São Paulo/Buenos Aires" — city labels don't match the
colombia_perm gate terms → would Skip).

### Batch 3 (2026-07-22) — 2 verified (owner seeds, via SF-board research)
| Name | ATS | Token | Track | Evidence |
|---|---|---|---|---|
| Bombardier | successfactors | jobs.bombardier.com | canada_coop | 2,490 jobs incl. Montréal/Toronto (freshness-first bounds the backlog) |
| ISA | successfactors | jobs.isa.co | colombia_perm | SF urlset; XM subsidiary = Bogotá/Colombia roles (CTEEP/Brazil ones Skip) |

Unsupported (owner-checked, not addable): **Comfama** (employment agency — comfama.com CMS +
computrabajo/magneto, no supported ATS), **ISAGEN** (elempleo/Indeed aggregators only). Confirms the
LATAM gap: supportable Colombian employers = big corps on SF/Workday; mid-size ones use local boards.

Method proven: big Canadian employers live on **SuccessFactors / Workday** (own-domain or myworkdayjobs
host) → find via web search + verify the feed. This is the repeatable path for canada_coop volume, at
~1 search + 1 probe per company (real token cost).

### Structural finding (important — 2026-07-22)
Reaching a **balanced ⅓/⅓/⅓ / 300** is **not realistic from the 6 supported ATSes**:
- **colombia_perm / LATAM:** the strong LATAM fintechs are ALREADY on the roster (Belvo, Kueski, Addi,
  dLocal, Bitso, Clara, Cobre, Xepelin, Yuno, Nubank). Most *other* LATAM employers use **Gupy /
  SmartRecruiters** (unsupported) or post city-specific labels (Mexico City, São Paulo) that don't clear
  the colombia_perm gate. Thin remaining pool.
- **contractor_usd / global-remote:** many are US-restricted (Render) or already on the roster (Zapier,
  Oyster, Remote, GitLab, Toptal, Turing, Truelogic, Gorilla). Thin remaining pool.
- **canada_coop:** the ONE deep pool — many Canadian employers, mostly on **Workday** (token = host/site,
  needs per-company URL lookup, not guessable). This is where real growth of 100+ is achievable.

**Recommendation:** grow canada_coop substantially (Workday URL research) and top up LATAM/remote
opportunistically; treat 300 as aspirational, not balanced. Alternative to unlock LATAM at scale: add a
**Gupy or SmartRecruiters connector** (a real dev project, separate proposal).

## Dedup baseline — 112 active companies (do NOT re-discover)

**ashby (36):** addi, alternativepayments, belvo, checkout.com, cohere, column, confluent, cuesta-partners,
float, gorilla, koho, kueski, leadbank, lightspeedhq, moderntreasury, mural, neofinancial, oyster, parafin,
payabli, paymentology, pebl, persona, posthog, ramp, sardine, slash-financial, socure, supabase, super.com,
the-global-talent-co, truelogic, trulioo, venn, wealthsimple, zapier

**greenhouse (33):** affirm, alloy, bitso, canonical, circleci, clara, cloudflare, cobre, cockroachlabs,
coinbase, elastic, faire, geotab, gitlab, globalrelay, gocardless, grafanalabs, hootsuite, leagueinc,
marqeta, mercury, mongodb, nortal, nubank, payoneer, postman, remotecom, sezzle, sourcegraph91, stripe,
turing, vercel, wizeline

**lever (16):** Flex, ciandt, coderio, dlocal, finix, kraken123, nium, toptal, trustly, tryjeeves, versapay,
waveapps, xepelin, yuno, zensurance, zeta

**successfactors (6):** careers.coastcapitalsavings.com (Coast Capital), empleo.grupobancolombia.com
(Bancolombia), jobs.canadalife.com (Canada Life), jobs.paysafe.com (Paysafe), jobs.scotiabank.com
(Scotiabank), trabajaconnosotros.sura.com (SURA)

**workable (1):** nuvei

**workday (20):** arcticwolf/External, autodesk/uni, bmo/campus, cae/career, cibc/campus, cibc/search,
ciena/Careers, cisco/Cisco_Careers, citi/2, cppib/cppinvestments, desjardins/Desjardins, intactfc/intactfc,
interac/Interac, manulife/MFCJH_Jobs, moneris/Moneris, omers/OMERS_External, rbc/RBCEARLYTALENT1,
santander/SantanderCareers, sunlife/Campus, td/TD_Bank_Careers
