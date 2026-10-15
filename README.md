# HomePros Video Engine

Script in → HeyGen avatar clips (one per hook A/B/C + body + CTA) → branded hook frame, gold captions, name card and end card → finished 1080×1920 MP4s in the Railway bucket.

- Runs on Railway (`homepros-content-studio` / `video-worker`).
- A job is set with the `JOB_B64` variable (base64 of a Content Studio script). The service runs it once and logs the download links (`RESULT A/B/C`).
- Restart-safe: HeyGen video IDs are saved in the bucket the moment they are submitted, so a redeploy never pays for the same clip twice.
- Cost guard: `MAX_SECONDS` caps the estimated avatar seconds per job.
