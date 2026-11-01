# Room Time Tracker

Tap-in / tap-out room timer for a physician, with dictation time and an anonymous patient survey.
Runs on Cloudflare Workers + D1 (free tier is plenty). Reminders use Firebase Cloud Messaging.

## What it does
- **Room tag**: first tap = in, tap again = out. Tapping a different room closes the old one (marked "inferred").
- **Dictation tag**: leaves the room and starts dictation, tied to the last room. Tap again, or tap any room, to end it.
- **End-of-day tag**: closes whatever is open. Anything still open the next day stays flagged and out of the averages.
- **Reminder**: one push after 35 min (adjustable) with no tap, during clinic hours. Tapping it opens **Fix**, where he enters the real time.
- **Auto-closed visits longer than 45 min** are left out of averages until he sets the real time.
- **Patient survey** (`/s/...`): radio buttons only. Stores only month + AM/PM + answers. No room, no clock time, no link to the visit log. Results show only once a month has 5+ responses.

## Deploy (no installs needed on a locked-down PC; all in the browser)
1. **GitHub**: create a private repo and upload this folder's contents.
2. **Cloudflare dashboard** > Workers & Pages > Create > import the GitHub repo.
3. **D1**: Storage & Databases > D1 > create `room-tracker`. Open its Console tab and paste in `schema.sql`. Copy the database ID into `wrangler.toml`.
4. **Secrets** (Worker > Settings > Variables and Secrets, type "Secret"):
   - `ADMIN_PASSCODE`: a long passcode (use a passphrase, 4+ words).
   - `FCM_SERVICE_ACCOUNT`: paste the whole service-account JSON (step 5).
5. **Firebase** (console.firebase.google.com): create a project, add a Web app and copy its config into `FIREBASE_WEB_CONFIG` in `wrangler.toml`. Project settings > Cloud Messaging > Web Push certificates > generate a key pair and put the public key in `FIREBASE_VAPID_KEY`. Project settings > Service accounts > Generate new private key (this JSON is the secret in step 4).
6. Set `PUBLIC_URL` in `wrangler.toml` to your worker's `https://...workers.dev` address (or custom domain), then redeploy.
7. Open the site on his iPhone in **Safari**, sign in, go to **Setup**, create the tags (Room 1..N, Dictation, End of day, Patient survey).
8. Write each tag URL to a sticker (NTAG213) with the free **NFC Tools** app. Print the survey URL as a QR code too.
9. **iPhone setup**: in Safari, Share > Add to Home Screen, open the Home Screen app, sign in, tap **Turn on reminders** and allow notifications.

Note: on iPhone, tapping a tag opens **Safari**, while the Home Screen app is a separate browser. He signs in once in each (the session lasts a year).

## Security baseline
| Item | Status |
|---|---|
| Server-side authorization on every API call | Done. Only login and the patient survey submit are public, on purpose. |
| CSRF protection | Done. State changes are POST-only with Origin + custom-header checks and SameSite=Lax cookies. Tapping a tag loads a page first, then POSTs. |
| Security headers (CSP, X-Frame-Options, nosniff, HSTS, referrer, permissions) | Done on every response. |
| No secrets in page source or client storage | Done. Passcode and service account are Worker secrets; sessions are HttpOnly cookies and stored hashed. The Firebase web config is public by design. |
| Input validation / parameterized queries | Done. All SQL is bound parameters; slugs, times and answers are validated. |
| Login brute-force protection | Done (10 failures / 15 min locks sign-in). Side effect: someone could lock him out for 15 min by guessing. |
| **Automatic off-site backups** | **NOT done.** D1 keeps 30 days of point-in-time restore, but that lives in the same Cloudflare account. Add a nightly export to a second location (e.g. an R2 bucket in another account, or Google Drive) before relying on this for records. |

## Not yet verified
- Real Cloudflare deploy: the dev tooling could not be installed in my sandbox, so I tested the Worker against a SQLite stand-in for D1 (`npm test`, `node test/serve.mjs` for a local preview).
- Push notifications end to end (needs your Firebase project and a real iPhone).
- NFC background tag reading on his specific iPhone (works on iPhone XS and newer).

## Files
`src/logic.js` rules and calculations · `src/worker.js` routes, auth, survey, cron · `src/fcm.js` push sender · `public/` pages and styles · `schema.sql` · `test/` 13 logic + 13 end-to-end tests
