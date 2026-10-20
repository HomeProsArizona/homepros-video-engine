# HomePros Video Engine

Script in → HeyGen avatar clips (one per hook A/B/C + body + CTA) → branded hook frame, gold captions, name card and end card → finished 1080×1920 MP4s in the Railway bucket.

- Runs on Railway (`homepros-content-studio` / `video-worker`).
- A job is set with the `JOB_B64` variable (base64 of a Content Studio script). The service runs it once and logs the download links (`RESULT A/B/C`).
- Restart-safe: HeyGen video IDs are saved in the bucket the moment they are submitted, so a redeploy never pays for the same clip twice.
- Cost guard: `MAX_SECONDS` caps the estimated avatar seconds per job.

## Production look (since 2026-10-19)
Both consumer and agent videos use the video avatar `cef054a6ada9427aa26231f2d0ed833b` (AVATAR_TYPE / AGENT_AVATAR_TYPE = `avatar`)
over `assets/backgrounds/studio.jpg` (BACKGROUND), with the solid name bar raised over captions burned into the avatar's
training footage (CARD_MODE=cover) and a soft blur behind it (BLUR_BOX=30,1195,1020,290).
Previous photo avatars: consumer `e986bbfb56804ed39c91727cbff730e9`, agent `1af2643c50c5479192cc364b1539415e` (AVATAR_TYPE=talking_photo, clear BACKGROUND/CARD_MODE/BLUR_BOX).
RECOMPOSE=1 rebuilds a finished job from its existing HeyGen clips (no new HeyGen cost).
