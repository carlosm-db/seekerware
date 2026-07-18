# Owner notes — one sitting, in this order (2026-07-18 build)

Everything below is YOURS to run/tap; the code is deployed. Est. 30–45 min.
No secrets or private values in this file — only where to put them.

## A. One-time setup (~10 min)

1. **Check secrets exist** (terminal, repo folder):
   `npx wrangler secret list`
   Expected: API_TOKEN, LOGIN_PASSWORD_HASH, SESSION_SECRET, TELEGRAM_BOT_TOKEN,
   TELEGRAM_CHAT_ID, GEMINI_API_KEY, GOOGLE_SA_KEY, DRIVE_FOLDER_ID,
   CV_TEMPLATE_DOC_ID.
2. **New secret for the bot** (any long random string — save it somewhere):
   `npx wrangler secret put TELEGRAM_WEBHOOK_TOKEN`
3. **Register the Telegram webhook** (one call; replace the three placeholders):
   `curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<your-worker>.workers.dev/tg/<WEBHOOK_TOKEN>"`
   Success looks like `{"ok":true,...,"description":"Webhook was set"}`.
4. **Share Google Drive with the service account** (the historic 404):
   open the `client_email` inside your GOOGLE_SA_KEY JSON
   (…@…iam.gserviceaccount.com) and share BOTH the CV template Doc AND the
   Drive folder with it as **Editor**.

## B. Console pass (phone is fine)

5. **Bank** (/blocks): you should see *My roles / My skills / My summary* with
   full text. Exercise it end to end: ＋Add role (code `TEST1`) → ＋Add bullet
   under it → edit the bullet → per-role approve → **Check template** (expect
   it to flag TEST1 having bullets but no `{{TEST1R…}}` tokens — that's it
   working) → retire TEST1.
6. **Calibration** (/config): remove or add any word chip → an orange
   "unsaved changes" banner appears → **Preview impact & activate** → watch
   the impact table → Activate. History now describes the change in words.
7. **Re-score** (/config → ♻️): confirm. Expected in the change list:
   the KOHO job moves to `canada_coop/Apply 67`; "Hybrid - US" / EMEA /
   Brazil / San-Francisco "remote" jobs drop off contractor_usd.
8. **Schedule** (/health): confirm or change "every 1h, 9:00–19:00
   America/New_York"; the next-run display should match.

## C. First CV

9. **Check template** (/blocks → Check template): fix anything it flags in
   the Doc (token typos, missing lines) and re-run until it says ✓ match.
10. **Sample**: open any job (Today or Jobs) → **Generate CV** → it builds a
    SAMPLE from draft blocks. Inspect Doc + PDF: no raw `{{` anywhere, all 5
    DLAB1 bullets filled, 4 skills lines, phone/location match the job's
    track, "Suggested tweaks" in the Doc but NOT the PDF. Edit bank text in
    /blocks and regenerate until it represents you.
11. **Approve the bank**: per role/section, or "Approve the ENTIRE bank"
    (it asks for confirmation now).
12. **Real CV**: tap **Generate CV** on the job again → "REAL CV queued" →
    the next scheduled run builds it. To force a run right now:
    `curl -X POST -H "Authorization: Bearer <API_TOKEN>" https://<your-worker>.workers.dev/api/run`
13. Verify: /cvs row typed **real** with its fill report; clean PDF in the
    Drive `archive/` folder. That's the project's core promise delivered.

## D. Kit + bot

14. **/applications**: pick an Apply job → **Build kit** → open the kit:
    matched answers, 🔴 unanswered, ⚖️ EEOC flagged (never auto-answered),
    form link, checklist.
15. **Bot**: send any text to your bot — reply "No question is pending…"
    proves the webhook. New job notifications now carry 📋 **View kit** /
    ✅ **I applied** buttons. Tap View kit → answer the red questions one by
    one in chat → each reply saves as a DRAFT answer.
16. Back in /applications: **approve** the draft answers you want reused
    forever; add common ones (work authorization, notice period, salary
    expectation) once — every future kit matches them automatically.

## E. Housekeeping

- No production reseed needed — the migration converted the data in place.
- Backup anytime (keep the file OUTSIDE the repo):
  `npx wrangler d1 export seekerware --remote --output=../seekerware-backup.sql`
- Update your OneDrive blocks master at leisure (D1 is now the source of truth).
- Parked, wake them whenever you say so: single-`schema.sql` repo cleanup;
  Spanish CV template (first Colombian application that wants one);
  AI-selected projects (after ~10 real CVs).

If ANY step doesn't match what's written here, stop and tell me what you saw.
