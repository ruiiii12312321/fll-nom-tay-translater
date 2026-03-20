# Tày Nôm → Vietnamese Translator

Web application that:
- opens the device camera in the browser
- captures or uploads an image containing Tay Nom / Han characters
- runs OCR directly in the web page
- sends detected text to OpenAI for Tay Nom analysis and translation to target language

## Tech stack
- Frontend: HTML, CSS, JavaScript
- Backend: Node.js + Express
- OCR: Tesseract.js in browser
- AI translation: OpenAI Responses API

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Create `.env` from `.env.example` and set your OpenAI API key.
3. Start app:
   ```bash
   npm start
   ```
4. Open:
   `http://localhost:3000`

## Runtime flow
1. Camera opens in browser.
2. User captures image.
3. OCR runs in web page via Tesseract.js.
4. Extracted text is sent to `/api/translate`.
5. OpenAI analyzes Tay Nom / Han text and translates to selected target language.
6. Result is shown in the UI.

## AI training module
- The backend now includes an end-of-pipeline training module at `src/training/module.js`.
- It collects interaction data from `/api/translate` and from explicit user feedback endpoint `/api/training/feedback`.
- Training data is validated and preprocessed before being queued for batch jobs.
- Scheduler runs periodic training batches and calls ChatGPT API to optimize prompt templates.
- Candidate model deployment is accepted only when evaluated accuracy is at least `85%`.
- If accuracy is below threshold, rollback is applied automatically and active deployment stays unchanged.
- Audit trail is stored in `data/training/audit.log.jsonl`.

## Training endpoints
- `POST /api/training/feedback` collect labeled user interactions.
- `POST /api/training/run` trigger a manual training batch.
- `GET /api/training/metrics` return queue, deployment, and latest job metrics.
- `GET /api/training/jobs` return recent training jobs.
- `GET /training/dashboard` open monitoring dashboard.

## Translation failure resolution
- Failure source: frontend message `Translation error: Translation failed.` was triggered by `/api/translate` backend errors.
- Exact root cause observed: missing OpenAI API key (`AUTH_MISSING_API_KEY`), which is an authentication issue.
- Stack traces and structured error logs are now emitted by the server with `errorCode`, `stack`, endpoint, locale metadata.
- Fallback behavior: when translation service fails, API responds with `fallbackUsed: true` and returns original text with a user-visible warning.
- Locale fallback: unsupported or unavailable locale resources automatically fall back to default `vi`.

## Testing
- Run:
  ```bash
  npm test
  ```
- Coverage includes:
  - locale loading for all supported locales (`vi`, `en`)
  - locale fallback when resources are missing or locale is unsupported
  - integration success path for each supported locale
  - graceful degradation on timeout and missing API key

## Environment verification
- Development check:
  - `NODE_ENV=development` and call `/api/health`
- Production check:
  - `NODE_ENV=production` and call `/api/health`
- Response includes current environment to confirm both modes are healthy.
