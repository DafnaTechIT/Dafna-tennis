# Dafna tennis court booking — instructions for Claude

This is the tennis court booking app for Kibbutz Dafna, live at https://dafna-tennis.vercel.app.
The repository is **public**. Merges to `main` deploy to production automatically (Vercel).

## Who you are working with

Contributors here are often **not technical**. Talk to them in **simple Hebrew**, no jargon.
Explain what you plan to change before changing it, and summarize what changed in plain words when done.
Meydan (the owner) reviews every change and opens the pull request himself.

## The workflow — follow it exactly

1. **Never commit or push to `main`.** Always work on a new branch, named
   `edit/<short-english-description>` (for example `edit/maintenance-notice`). If the session already
   created a `claude/...` branch for you, use it.
2. Keep each branch to **one change** the contributor asked for. Do not refactor or "improve" unrelated code.
3. Before pushing, run the checks below. If a test fails, fix it or explain the problem; never push a failing branch.
4. Push the branch. **Do not open a pull request** and do not press Create PR — Meydan does that.
5. Finish by giving the contributor, in Hebrew: what changed, the branch name, and a short ready-to-copy
   message for Meydan, e.g. `ענף: edit/maintenance-notice — הוספתי שורה על סגירת המגרש בבוקר יום ראשון.`

Commit messages are always in **English**, short and descriptive.

## Checks before pushing

```bash
npm test                     # API tests against a fake database; must print "All tests passed"
node test/screenshot.js      # if Playwright is available: phone screenshots in screenshots/ (light + dark)
```

Show the contributor the screenshots so they can see the result. Do not commit the `screenshots/` folder.
To try the app by hand: `node test/dev-server.js` and open http://localhost:3000 (admin password `devpass123`).
The dev server never touches the real database.

## Never do these

- Never put passwords, tokens, phone numbers or residents' names in the code, commits or messages.
  Real secrets live only in Vercel environment variables. Real bookings live only in the database.
- Never change `vercel.json`, the security headers, the admin login, or the rate limiting unless the
  contributor explicitly asks; if they ask, warn them in Hebrew that Meydan must review it carefully.
- Never edit or delete bookings, classes or the admin password through code — those are managed in the
  app itself via "כניסת מנהל".
- Never add npm dependencies, external scripts or trackers without a clear reason, and say so.
- Never rewrite history (`git push --force`, rebase of pushed commits).

## How the app is built

| Path | What it is |
|---|---|
| `public/index.html` | The whole front end: HTML, CSS and JavaScript in one file, Hebrew, right-to-left |
| `public/logo.png` | Kibbutz Dafna logo |
| `api/index.js` | All server endpoints in one Vercel function; data in Upstash Redis (keys `tennis:*`) |
| `vercel.json` | Routing, security headers (CSP), region `fra1`, daily cleanup cron |
| `test/` | Dev server with a fake database, API tests, screenshot script |

- Times are always Israel time (`Asia/Jerusalem`), computed in code — the server runs in UTC.
- The page refreshes data every 30 seconds while visible, slower when idle. Do not make it faster:
  it counts against the free Vercel and Upstash quotas.
- Content Security Policy allows only this site plus Google Fonts. A new external resource will be blocked.

## Design rules

The look matches the Dafna community board. Keep it consistent:

- Use the CSS variables at the top of `public/index.html` (`--accent`, `--green`, `--red`, `--yel`, `--blue`,
  `--card`, `--line`, `--mute` …). Do not hard-code new colors.
- Every color change must work in **both light and dark mode** (both variable blocks).
- Fonts: Assistant for text, Rubik for headings. Corners 8–10px, soft shadows.
- Mobile first: it must look right at 400px wide. Keep all text in Hebrew and right-to-left.
