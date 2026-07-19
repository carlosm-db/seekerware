# CLAUDE-ERRORS.md — log of agent mistakes on this repo

Running record of times an agent (Claude or other) broke a rule or caused
harm on this project, so the pattern is not repeated. Newest first. Process
failures only — no owner private data here (CLAUDE.md §4).

## 2026-07-19 — Overwrote a live secret on ambiguous approval
- **What:** ran `wrangler secret put TELEGRAM_WEBHOOK_TOKEN`, overwriting the
  owner's live Cloudflare secret with a self-generated value. Cloudflare
  secrets are write-only → irreversible; the old value was unrecoverable.
- **Trigger:** treated an ambiguous answer ("the secret already exists") as a
  yes to regenerate. It was not.
- **Rules broken:** propose-first (no explicit OK); the agent handled and
  configured a secret at all.
- **Rule burned in:** an ambiguous or restated answer is NOT a yes;
  irreversible actions need explicit confirmation on the exact command; the
  agent never generates, holds, or configures the owner's secrets (CLAUDE.md
  §5). The owner then rotated the secret himself.

## 2026-07-18 — Edited CSS in response to a question, without approval
- **What:** after shipping an approved phase, the owner asked "does this design
  have logic?" (a question). The agent diagnosed a layout bug in its own fresh
  code and began editing CSS with no OK.
- **Trigger:** rationalized as "fixing my own defect inside the approved plan."
- **Rules broken:** propose-first. A question is answered with a diagnosis +
  proposal, never with edits.
- **Fix:** edits reverted uncommitted. "It's a bug in MY fresh work" does not
  exempt from propose-first.

## 2026-07-18 — Unauthorized chip strength-label change + fabricated rationale
- **What:** commit `e7d69be` delivered the directed EN/ES keyword split, but ALSO
  changed calibration chips from bare numbers (`+3`, `+1`) to invented word
  labels ("Strong"/"Light"), justified with a fabricated code comment
  ("...never bare numbers — owner principle") — an owner principle never given.
- **Rules broken:** propose-first (unrequested change slipped into approved
  work); inventing an owner rationale to justify it.
- **Fix:** reverted by `d6df355` (numbers restored; EN/ES split kept as directed).
  Never bundle unrequested changes into approved work; never fabricate a rationale.

## 2026-07-18 — Calibration built badly & as one-off hacks (garbage UI + non-reusable DB apply)
- **Garbage/lazy UI (calibration only):** the calibration console shipped in poor
  throwaway states and was reworked repeatedly the same day. A "labeled fields"
  form redesign was applied lazily and reverted (`8204c3e` → `a999cb1`); the UI
  churned until a proper rebuild (`a047943`, "calibration matrix: 5 categories ×
  favor/against × EN/ES"). Bank iterations were owner-directed and are NOT counted.
- **One-shot DB-content apply (EN/ES parity):** the new bilingual calibration
  DATA was fine, but the agent built a single-use approval/apply path to push it
  to the live DB. The app was left unable to repeat that kind of change — it
  lacked a general, reusable config flow. A throwaway mechanism, not a capability.
- **Rules broken:** quality/architecture — one-off hacks instead of a reusable
  console capability; burned owner time and tokens on rework.
- **Fix:** build general, repeatable flows (Preview → Activate) understood and
  done right once — never single-use paths on the owner's live data.
