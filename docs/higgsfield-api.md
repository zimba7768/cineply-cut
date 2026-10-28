# Higgsfield API notes (checked 2026-10-28)

Sources: https://docs.higgsfield.ai/docs/llms-full.txt, https://docs.higgsfield.ai/docs/openapi.json, and the model pages linked below.

## Base URL and auth
- Base URL: `https://api.higgsfield.ai`
- Header: `Authorization: Key <KEY_ID>:<KEY_SECRET>`. A bad credential returns 401 `{"detail":"Invalid credentials"}`.
- Users create credentials at https://console.higgsfield.ai (now redirects to open.higgsfield.ai).
- Higgsfield says not to call the API from browser code. Cineply Cut makes all calls from the Electron main process.

## Jobs
- Submit: `POST /{endpoint-id}` with a JSON body. Send `Idempotency-Key: <uuid>` and `Content-Type: application/json`.
  - The response is `{status:"queued", request_id, status_url, cancel_url}`.
- Poll: `GET status_url`. Back off from 2 s up to 10 s, with jitter.
  - Status values: `queued`, `in_progress`, `completed`, `failed`, `nsfw`, `canceled`.
- Results on `completed`:
  - Images: `images:[{url}]`
  - Video: `video:{url}`
  - Audio: `audio:{url}` / `audios:[{url}]`
  - Files are deleted after 7 days (`expires_at`), so the app downloads them right away.
- Cancel: `POST cancel_url`. Returns 202 while queued, 400 once processing has started.
- Cost estimate: `POST /estimate/{endpoint-id}` with the same body returns `{"usd":"0.094"}`. Failed, nsfw, and canceled jobs are refunded.

## Errors
- Responses use the shape `{"detail": string | list}`.
- Status codes:
  - 400 bad input
  - 401 invalid credentials
  - 403 insufficient balance
  - 404 not found
  - 409 still running
  - 422 validation error
  - 423 model blocked
  - 429 queue full (respect `Retry-After`)
  - 500, 503 server errors
- Log the `X-Correlation-ID` response header.

## Uploading local files (image-to-video input)
1. `POST /files/generate-upload-url` with `{"content_type":"image/jpeg"}`. The response is `{public_url, upload_url, content_type, upload_headers}`.
2. `PUT` the file bytes to `upload_url` with every header from `upload_headers`. Do **not** send API credentials to that URL. The URL expires after 1 h.
3. Use `public_url` as `image_url`.

Allowed types: jpeg, png, webp, gif, audio/wav, video/mp4.

## Example endpoints
- **Text-to-video:** `kling-video/v3.0/std/text-to-video`
  - `prompt` (≤2500 chars)
  - `duration` 3–15 (default 5)
  - `aspect_ratio` `16:9 | 9:16 | 1:1`
  - `sound` `on|off`
  - `cfg_scale` 0–1
  - Other models: `minimax/hailuo-2.3/standard/text-to-video`, Seedance, Wan, LTX, PixVerse, Kling 2.x.
- **Image-to-video:** `kling-video/v3.0/std/image-to-video`
  - Same fields as text-to-video, plus `image_url` (required) and optional `last_image_url`.
- **Text-to-image:** `higgsfield-ai/soul/v2/standard`
  - `prompt`
  - `aspect_ratio` `9:16|16:9|4:3|3:4|1:1|2:3|3:2`
  - `resolution` `720p|1080p`
  - `enhance_prompt`
  - `seed` 1–1000000
  - `batch_size` 1|4
- **Text-to-speech:** the public API has none. Audio is only available as a native soundtrack from some video models (`sound:"on"`).

Model availability varies by account, so the model list in the app is editable.
