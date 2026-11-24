# Lucid Analytics

Lucid is a small, self-hosted web analytics dashboard I built for my own sites. I wanted a useful view of traffic without paying for a hosted analytics product or adding cookie-based visitor tracking to my sites.

This repository is a personal software project and a record of how I approached that problem. It is not a hosted service or a commercial product.

## What it does

Lucid collects page views and custom events through a lightweight script, then shows the results in a password-protected dashboard. It runs on Cloudflare Workers with Cloudflare D1 as its database.

The dashboard includes:

- Daily page-view and product-action totals, with optional event-based revenue totals
- Independent breakdowns for referrer domain, channel, page, country, browser, operating system and device
- Daily and monthly charts, plus retained all-time totals
- A password-protected dashboard and configurable location exclusions
- Session replay: a list of recorded visitors; click one to watch the visit and jump to how the page looked after each click

The feature set grew from questions I wanted to answer about my own sites. The project is still single-tenant: one dashboard password protects the instance, and there is no signup, billing, or multi-customer account system.

## Privacy choices and trade-offs

**Session replay records individual visits.** Unlike the daily counters below, the tracker also records each visit with rrweb (page structure, clicks, scrolls, mouse movement) under a random per-tab session ID, plus the visit's country and browser/OS/device. Form input values are always masked. Recordings are kept for 30 days and then deleted by a daily cron. Any site using this tracker should say so in its privacy notice; review whether consent is required where the site operates. The tracker stops recording when the site's `listvintAnalyticsConsent()` hook returns false or `listvintStopLucid()` is called.

To keep part of a page out of recordings, add `data-lucid-mask` (text replaced with asterisks) or `data-lucid-block` (element not recorded at all) to it.

The daily totals are separate. New analytics are stored as independent daily counters. The `daily_analytics` table does not receive visitor or session IDs, event-level timestamps, event properties, full referrer URLs, IP addresses or full user-agent strings. The worker uses the request IP and user-agent only transiently to apply configured location exclusions and classify broad country/browser/device categories. Dimensions are counted independently; the database does not keep a row linking an action to a particular page, location or device.

The `events` and `session_quality` tables retain historical visit-level records from before aggregate-only ingestion was introduced. The migration does not delete them. Per-visit, journey, event-feed and automation-detail endpoints are disabled; historical rows remain in D1 until the operator deletes them manually. Daily aggregates also have no automatic expiry.

Listvint turns aggregate analytics on by default and provides a browser-level off switch in its Privacy settings. This code structure does not by itself determine which privacy notice or legal basis applies to a deployment; review the data and rules applicable where the site operates.

## A few implementation decisions

- **Self-hosted collection:** the tracking endpoint, dashboard and database run in the owner's Cloudflare account.
- **Small tracker:** for the daily counters it sends only a safe page path, a fixed event name and (on page views) the referrer origin. The session recorder (~76KB) is loaded separately so the base script stays small. Custom properties and query strings are ignored.
- **Daily aggregation:** counters are stored by UTC date and a single independent dimension, without a person-level event sequence.
- **Listvint deployment retention:** new aggregate counts and older historical event/visit rows have no automatic expiry. The operator must clear them manually.
- **No billing system:** this began as a tool for my own use, so account plans, subscriptions and customer management are outside its scope.

## Tech stack

- JavaScript on Cloudflare Workers
- Cloudflare D1 (SQLite) for event and configuration storage
- Static HTML, CSS and JavaScript for the dashboard and tracking script
- Wrangler for local development and deployment

## Run the regression tests

Use Node.js 22.13 or later. The tests use Node's built-in `node:sqlite` module
and do not need a Cloudflare account or deployed database.

Run the checks from the repository root:

```bash
node scripts/test-event-validation.mjs
node scripts/test-automation.mjs
node scripts/test-automation-api.mjs
node scripts/test-replays.mjs
```

The automation tests create temporary in-memory SQLite databases; they do not
read or modify a deployed Lucid database.

## Run your own instance

Lucid is built around Cloudflare Workers and D1. To create a separate instance:

1. Install Node.js and authenticate Wrangler with your Cloudflare account:

   ```bash
   npx wrangler login
   ```

2. Create a D1 database, then set your Cloudflare account ID and the database ID in `wrangler.toml`:

   ```bash
   npx wrangler d1 create lucid-analytics
   ```

3. Apply the schema to that database:

   ```bash
   npx wrangler d1 execute lucid-analytics --remote --file=./schema.sql
   ```

4. Create the R2 bucket that stores session recordings (bound as `REPLAYS` in `wrangler.toml`):

   ```bash
   npx wrangler r2 bucket create lucid-replays
   ```

5. Set the dashboard password as a Worker secret:

   ```bash
   npx wrangler secret put DASH_PASSWORD
   ```

6. Apply the migrations (including `010-session-replay.sql`), set `ALLOWED_SITES` in `wrangler.toml` to the site origins allowed to send events, then deploy:

   ```bash
   npx wrangler d1 migrations apply listvint-analytics --remote
   npx wrangler deploy
   ```

The repository excludes deployment-specific analytics notes, historical corrections and raw traffic snapshots. The Workers and D1 free allowances have limits and can change. Check Cloudflare's current terms for your account; this project does not guarantee zero hosting costs.

## Add the tracker

Add the deployed Worker URL and your site domain to the page:

```html
<script defer data-domain="example.com"
        src="https://your-worker.example.workers.dev/tracker.js"></script>
```

Custom events can be sent with `stats`:

```js
stats('/price_estimate_complete');
stats('/sign_in_failed');
```

For this Listvint deployment, accepted action names are explicitly allowlisted in `src/worker.js`. Add a fixed path there before calling it from the site; event properties are not accepted or stored.

## Repository map

| Path | Purpose |
| --- | --- |
| `src/worker.js` | Aggregate event collection, authentication and dashboard APIs |
| `src/replays.js` | Session replay upload, listing, playback and 30-day cleanup |
| `public/tracker.js` | Site tracking script (counters + session recording) |
| `public/visitors.js` | Dashboard Visitors panel and replay viewer |
| `public/vendor/` | rrweb recorder and player (MIT, see `NOTICE.md`) |
| `public/` | Dashboard assets |
| `schema.sql` | Schema for a fresh database |
| `migrations/` | Incremental schema changes |
| `wrangler.toml` | Worker and D1 configuration |

## Project status

Lucid is an evolving personal project. It has useful reporting for the sites it was built around, but it is not a general-purpose analytics platform: it has no self-service onboarding, team accounts, public reports, or guarantee of compatibility with every deployment.
