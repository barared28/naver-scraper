# Naver Scraper

Naver Smartstore scraper built with NestJS + Puppeteer, featuring Browserless, proxies, fingerprinting, captcha solver, a browser pool, and a warm-up mechanism. Designed for stable scraping and reduced detection.

## Architecture Overview

- `Browserless`: Connect Puppeteer to a remote Chromium via WebSocket for stability and isolation. See `src/browser/browser-pool.service.ts:52-58`.
- `Proxy`: Each browser instance uses a distinct proxy via `--proxy-server` and per-page authentication. See `src/browser/browser-pool.service.ts:36-43` and `src/browser/browser-warmer.service.ts:249-255`.
- `Fingerprint`: Uses `fingerprint-generator` + `fingerprint-injector` to create pages with realistic fingerprints (device, OS, locale, screen). See `src/browser/browser-warmer.service.ts:235-245`.
- `Browser Pool`: Manages a pool of browsers connected to Browserless; request queue, timeouts, release, and cleanup. See `src/browser/browser-pool.service.ts`.
- `Captcha Solver`: Solves Naver captcha via Anthropic (Claude) using the captcha image and prompt. See `src/captcha/captcha-solver.service.ts`.
- `Warm Up`: Sequential navigation across Google/Naver/Search/Product to prime cookies/session and reduce captcha likelihood. See `src/browser/browser-warmer.service.ts`.

## Prerequisites

- Node.js 18+ and `yarn`
- Docker (to run Browserless)
- Tokens/keys:
  - `BROWSERLESS_TOKEN`
  - `ANTHROPIC_API_KEY` (Claude)
- Proxy list in `ip:port:username:password` format (JSON array)

## Quick Setup (Local Dev + Browserless Container)

1. Install dependencies:
   ```bash
   yarn install
   ```
2. Copy `.env.example` to `.env` and fill in values:
   - `PORT=3000`
   - `BROWSERLESS_TOKEN=...`
   - `ANTHROPIC_API_KEY=...`
   - `PROXIES=["ip:port:username:password", "..."]`
   - Set `MAX_THREAD` to the number of proxies.
   - `BROWSERLESS_URL` when running Browserless via container:
     - If NestJS runs on host: `localhost:3001`
     - If NestJS runs inside the same Docker network: `browserless:3000`

3. Run Browserless (Chromium) via Docker:
   ```bash
   docker run -d \
     -p 3001:3000 \
     -e TOKEN=$BROWSERLESS_TOKEN \
     --name browserless \
     ghcr.io/browserless/chromium
   ```

4. Run NestJS app:
   ```bash
   yarn start:dev
   # or production
   yarn build && yarn start:prod
   ```

Note: The repo includes `compose.yml` for orchestration, but no `Dockerfile` for the NestJS service. You can run NestJS locally as above, or add your own Dockerfile for full docker-compose usage.

## `.env` Configuration

See `.env.example`. Key variables:

- `PORT`: NestJS HTTP port (default 3000). See `src/main.ts:5-7`.
- `BROWSERLESS_URL`: Host:port for Browserless WebSocket, no scheme (`ws://` is added programmatically). See `src/browser/browser-pool.service.ts:52-55`.
- `BROWSERLESS_TOKEN`: Browserless access token. See `src/browser/browser-pool.service.ts:46-51`.
- `MAX_THREAD`: Max browsers in the pool; capped by proxy count. See `src/browser/browser-pool.service.ts:20-23`.
- `MAX_WAIT_TIME`: Max waiting time in the request queue. See `src/browser/browser-pool.service.ts:10,100-109`.
- `PREPARE_INTERVAL`: Interval between periodic warm-ups. See `src/browser/browser-warmer.service.ts:54,62-64`.
- `IDLE_THRESHOLD`: Idle threshold before a browser is scheduled for warm-up. See `src/browser/browser-warmer.service.ts:55,62-64`.
- `ANTHROPIC_API_KEY`: Captcha solver API key. See `src/captcha/captcha-solver.service.ts:11-15`.
- `PROXIES`: JSON array of `ip:port:username:password`. See `src/browser/browser-pool.service.ts:19,36-43`.

## Running the Service

- Scrape product: `GET /naver?productUrl=<PRODUCT_URL>`
  - Returns `product` and `benefit` payloads captured from XHR API calls on the product page.
- Search products: `GET /naver/search?keyword=<KEYWORD>`
  - Returns a list of Smartstore product URLs from search results.

Examples:

```bash
curl "http://localhost:3000/naver?productUrl=https://smartstore.naver.com/.../products/12345?withWindow=false"

curl "http://localhost:3000/naver/search?keyword=아이폰"
```

## Infrastructure Details

### Browserless

- Connection via `puppeteer.connect` with a `browserWSEndpoint` including `token` and `launch` args. See `src/browser/browser-pool.service.ts:52-58`.
- Launch args set the proxy and a distinct `user-data-dir` per proxy to isolate profiles. See `src/browser/browser-pool.service.ts:36-45`.

### Fingerprint

- `FingerprintGenerator` configured to `desktop/macos/chrome/ko-KR` with 1920×1080 screen. See `src/browser/browser-warmer.service.ts:35-47`.
- `newInjectedPage` creates a page with the fingerprint so headers, navigator, screen, etc., look natural. See `src/browser/browser-warmer.service.ts:237-245`.

### Proxy

- `.env` format: `PROXIES=["ip:port:username:password", ...]`.
- Proxy is set via Chromium arg `--proxy-server=http://ip:port`. See `src/browser/browser-pool.service.ts:36-43`.
- Page-level authentication via `page.authenticate({username, password})`. See `src/browser/browser-warmer.service.ts:249-255`.

### Browser Pool

- Pool size equals `MAX_THREAD` or proxy count (whichever is smaller). See `src/browser/browser-pool.service.ts:20-23`.
- FIFO allocation with `inUse`, `lastUsedAt`, and a waiting queue with timeout. See `src/browser/browser-pool.service.ts:88-119,151-170,172-182`.
- `cleanup` disables interception and removes listeners before releasing the browser back to the pool. See `src/browser/browser-pool.service.ts:214-231`.

### Captcha Solver

- Detects Naver captcha (`window.WtmCaptcha`), grabs `#rcpt_img` and message. See `src/captcha/captcha-solver.service.ts:62-85`.
- Sends to Anthropic (Claude Sonnet 4.5) and uses the plain text answer. See `src/captcha/captcha-solver.service.ts:17-46`.
- Fills the answer and proceeds with navigation. See `src/captcha/captcha-solver.service.ts:88-121`.

### Warm Up Mechanism

- Startup: waits for all browsers to connect, then warms all of them initially. See `src/browser/browser-warmer.service.ts:81-111,145-156`.
- Periodic: every `PREPARE_INTERVAL`, selects browsers idle beyond `IDLE_THRESHOLD` for warming. See `src/browser/browser-warmer.service.ts:162-189`.
- Warm-up steps: set viewport, check IP, navigate Google → Naver → Shopping → Random search → Random product. See `src/browser/browser-warmer.service.ts:241-315`.
- On success, mark browser `isPrepared` and reset `lastUsedAt`. See `src/browser/browser-warmer.service.ts:319-325`.

## Scraping Workflow

1. Acquire a browser from the pool (`getBrowser`). See `src/scraper/scraper.service.ts:23`.
2. Enable interception to skip heavy resources and listen for product/benefit API responses. See `src/scraper/scraper.service.ts:35-75`.
3. Navigate with captcha solver (`gotoWithCaptchaSolver`). See `src/scraper/scraper.service.ts:79-83`.
4. Wait up to 90s for both responses and return data. See `src/scraper/scraper.service.ts:85-105`.
5. Cleanup and release the browser back to the pool. See `src/scraper/scraper.service.ts:110-114` + `src/browser/browser-pool.service.ts:214-231`.

## Troubleshooting

- `BROWSERLESS_URL` with Docker Compose:
  - Within a shared Docker network: `browserless:3000` (container internal port).
  - From host: `localhost:3001` (published port).
- Ensure `PROXIES` is valid JSON (double quotes) and credentials are correct.
- `ANTHROPIC_API_KEY` must be set; without it, captcha solving won’t work.
- If frequent captchas occur, increase `PREPARE_INTERVAL`, adjust `IDLE_THRESHOLD`, or diversify fingerprints.
- If browser acquisition times out, increase `MAX_THREAD` or `MAX_WAIT_TIME`.

## License

This code is private (UNLICENSED). Do not publish any tokens or credentials.

## Testing with `yarn test`

- The `test` script runs `ts-node test/test.ts` as defined in `package.json`.
- Ensure the NestJS server is running and accessible from the test script.
- Default test targets `http://localhost:3001` for API calls. Align your server port accordingly.

Steps:

- Start Browserless:
  - `docker run -d -p 3001:3000 -e TOKEN=$BROWSERLESS_TOKEN --name browserless ghcr.io/browserless/chromium`
- Start the NestJS app:
  - `yarn start:dev`
  - or `yarn build && yarn start:prod`
- Run tests:
  - `yarn test`

What the test does (`test/test.ts`):

- Collects Smartstore product URLs by calling `GET /naver/search?keyword=<keyword>` for keywords.
- Saves the list to `test/result/urls.json`.
- Fetches each product detail via `GET /naver?productUrl=<url>` with a batch concurrency of `BATCH_SIZE`.
- Writes each product response to `test/result/<productId>.json` and logs success/failure and average response time.

Port alignment:

- App default port is `3000` (`src/main.ts:5-7`). The test script targets `3001`.
- Either set `.env` `PORT=3001` for the app, or update `SEARCH_API_URL` and `PRODUCT_API_URL` in `test/test.ts` to `http://localhost:3000/...`.
