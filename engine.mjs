// HomePros Content Studio — render engine
// Job in → HeyGen avatar clips → branded hook frame + captions + end card → finished MP4s in the bucket.
// Safe to restart: HeyGen video IDs are saved the moment they're submitted, so a restart never pays twice.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync, spawn } from 'child_process';
import { chromium } from 'playwright-core';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const env = process.env;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const W = 1080, H = 1920, FPS = 30;

// ---------- storage (Railway bucket, or local folder when testing) ----------
const s3 = env.BUCKET ? new S3Client({
  endpoint: env.BUCKET_ENDPOINT, region: env.BUCKET_REGION || 'auto', forcePathStyle: false,
  credentials: { accessKeyId: env.BUCKET_ACCESS_KEY_ID, secretAccessKey: env.BUCKET_SECRET_ACCESS_KEY },
}) : null;
async function getJSON(key) {
  if (!s3) { const f = path.join(ROOT, 'local-store', key); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; }
  try { const r = await s3.send(new GetObjectCommand({ Bucket: env.BUCKET, Key: key })); return JSON.parse(await r.Body.transformToString()); }
  catch (e) { if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null; throw e; }
}
async function putFile(key, body, type) {
  if (!s3) { const f = path.join(ROOT, 'local-store', key); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return 'file://' + f; }
  await s3.send(new PutObjectCommand({ Bucket: env.BUCKET, Key: key, Body: body, ContentType: type }));
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: env.BUCKET, Key: key }), { expiresIn: 7 * 24 * 3600 });
}
const putJSON = (key, obj) => putFile(key, JSON.stringify(obj, null, 2), 'application/json');

// ---------- script parsing (accepts JSON, or the Content Studio text format) ----------
export function parseScript(text) {
  const t = text.trim();
  if (t.startsWith('{')) return JSON.parse(t);
  const get = re => (t.match(re) || [])[1]?.trim();
  const job = {
    number: get(/SCRIPT\s*#\s*(\d+)/i),
    style: get(/Hook style:\s*([^\n|]+)/i),
    topic: get(/Topic:\s*([^\n]+)/i),
    chip: get(/Chip:\s*([^\n]+)/i),
    kicker: get(/Kicker:\s*([^\n]+)/i),
    keyword: get(/Keyword:\s*([^\n]+)/i),
    audience: get(/Audience:\s*([A-Z]+)/i),
    variants: [],
  };
  // Single-hook format ("Hook — spoken: / screen:"). Older A/B/C scripts still parse; only the first hook is used.
  for (const k of ['', 'A', 'B', 'C']) {
    const spoken = get(new RegExp(`Hook ${k}\\s*[—-]+\\s*spoken:\\s*([^\\n]+)`, 'i'));
    const screen = get(new RegExp(`Hook ${k}\\s*[—-]+\\s*spoken:[^\\n]*\\n\\s*screen:\\s*([^\\n]+)`, 'i'));
    if (spoken && screen) { job.variants.push({ key: k || 'A', spoken, screen }); break; }
  }
  job.body = get(/Body:\s*\n([\s\S]*?)\n\s*CTA:/i)?.replace(/\s*\n\s*/g, ' ');
  job.cta = get(/CTA:\s*([^\n]+)/i);
  job.caption = get(/Caption:\s*([^\n]+)/i);
  job.hashtags = get(/Hashtags:\s*([^\n]+)/i);
  // Optional effect fields (body section only): Headline, Callouts (comma list), Checklist (comma list), Snap (a line of the body)
  job.headline = get(/Headline:\s*([^\n]+)/i);
  job.callouts = get(/Callouts:\s*([^\n]+)/i)?.split(',').map(x => x.trim()).filter(Boolean);
  job.checklist = get(/Checklist:\s*([^\n]+)/i)?.split(',').map(x => x.trim()).filter(Boolean);
  job.snap = get(/Snap:\s*([^\n]+)/i);
  return job;
}
function validate(job) {
  const errs = [];
  if (!job.variants?.length) errs.push('no hooks found');
  for (const v of job.variants || []) {
    const lines = v.screen.split('/').map(s => s.trim()).filter(Boolean);
    if (lines.length < 2 || lines.length > 5) errs.push(`hook ${v.key}: screen needs 2-5 lines`);
    for (const l of lines) if (l.replace(/\*/g, '').length > 14) errs.push(`hook ${v.key}: screen line too long "${l}"`);
    if (lines.filter(l => /^\*.+\*$/.test(l)).length !== 1) errs.push(`hook ${v.key}: needs exactly one *PUNCH* line`);
  }
  if (!job.body) errs.push('body missing');
  if (!job.cta) errs.push('CTA missing');
  const kw = (job.keyword || 'CASA').toUpperCase();
  const spoken = [job.variants?.[0]?.spoken, job.body, job.cta].filter(Boolean).join(' ');
  const ac = acronyms(spoken, kw);
  if (ac.length) errs.push(`acronym(s) in spoken text, the voice would spell them out: ${ac.join(', ')} (write them out in words, or add to PRONOUNCE)`);
  // Brokerage name is on screen (logo + license line on every frame), so it is not required in the spoken script.
  return errs;
}
const plain = s => s.replace(/\*/g, '');
// Words the Spanish voice would spell letter by letter. Spoken text only; captions and screen keep the original.
export const PRONOUNCE = { BINSR: 'binser' };
const speakable = s => plain(s).replace(/\b[A-ZÁÉÍÓÚÑ]{2,}\b/g, w => PRONOUNCE[w] ?? w);
// Acronyms the voice would spell out: any ALL-CAPS word of 2+ letters that is not the CTA keyword and not in PRONOUNCE.
const acronyms = (s, keyword) => [...new Set((plain(s).match(/\b[A-ZÁÉÍÓÚÑ]{2,}\b/g) || []).filter(w => w !== keyword && !(w in PRONOUNCE)))];
const words = s => plain(s).split(/\s+/).filter(Boolean).length;

// ---------- HeyGen ----------
const HG = 'https://api.heygen.com';
async function hg(method, p, body) {
  if (env.MOCK_HEYGEN) return mockHeygen(method, p, body);
  const r = await fetch(HG + p, { method, headers: { 'X-Api-Key': env.HEYGEN_API_KEY, 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 400) }; }
  if (!r.ok || j.error) throw new Error(`HeyGen ${p} ${r.status}: ${JSON.stringify(j.error || j).slice(0, 400)}`);
  return j;
}
async function submitClip(text, job) {
  const character = job.avatarType === 'avatar'
    ? { type: 'avatar', avatar_id: job.avatarId, avatar_style: 'normal' }
    : { type: 'talking_photo', talking_photo_id: job.avatarId, use_avatar_iv_model: job.engine !== 'iii' };
  // Background swap: HeyGen cuts the avatar out of its own background (matting) and puts our image behind it.
  if (job.bgUrl) character.matting = true;
  const scene = { character, voice: { type: 'text', input_text: speakable(text), voice_id: job.voiceId } };
  if (job.bgUrl) scene.background = { type: 'image', url: job.bgUrl, fit: 'cover' };
  const j = await hg('POST', '/v2/video/generate', {
    video_inputs: [scene],
    dimension: { width: W, height: H },
  });
  return j.data.video_id;
}
async function waitClip(id) {
  for (let i = 0; i < 120; i++) {
    const j = await hg('GET', `/v1/video_status.get?video_id=${id}`);
    const d = j.data || {};
    if (d.status === 'completed') return d.video_url;
    if (d.status === 'failed') throw new Error(`HeyGen render ${id} failed: ${JSON.stringify(d.error).slice(0, 300)}`);
    await sleep(15000);
  }
  throw new Error(`HeyGen render ${id} timed out`);
}
function mockHeygen(method, p, body) { // local testing only: fake clip whose length follows the word count
  if (method === 'POST') return { data: { video_id: 'mock:' + Math.max(2, words(body.video_inputs[0].voice.input_text) / 2.6).toFixed(2) } };
  return { data: { status: 'completed', video_url: p.split('video_id=')[1] } };
}
async function download(url, out) {
  if (url.startsWith('mock:')) {
    const d = url.slice(5);
    run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=s=720x1280:r=25:d=${d}`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${d}`, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out]);
    return;
  }
  const r = await fetch(url); if (!r.ok) throw new Error(`download ${r.status}`);
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
}

// HeyGen API wallet balance in USD (null if unavailable). Used to log the real cost of each batch.
async function wallet() {
  if (env.MOCK_HEYGEN) return null;
  try { const j = await hg('GET', '/v3/users/me'); const b = Number(j.data?.wallet?.remaining_balance); return isNaN(b) ? null : b; }
  catch (e) { log('wallet check failed:', e.message); return null; }
}

// ---------- media helpers ----------
function run(cmd, args) { execFileSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] }); }
const size = f => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', f]).toString().trim();
const dur = f => parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
function fontsCSS() {
  const f = (fam, w, file) => `@font-face{font-family:"${fam}";font-weight:${w};font-display:block;src:url(data:font/woff2;base64,${fs.readFileSync(path.join(ROOT, 'fonts', file)).toString('base64')}) format("woff2")}`;
  return [600, 700, 800, 900].map(w => f('Montserrat', w, `montserrat-latin-${w}-normal.woff2`)).join('') + f('JetBrains Mono', 500, 'jetbrains-mono-latin-500-normal.woff2');
}
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
function fill(name, vars) {
  let h = fs.readFileSync(path.join(ROOT, 'templates', name), 'utf8').replace('/*FONTS*/', fontsCSS()).replace('/*BASE*/', fs.readFileSync(path.join(ROOT, 'templates', 'base.css'), 'utf8'));
  for (const [k, v] of Object.entries(vars)) h = h.replaceAll(`{{${k}}}`, v);
  return h;
}
let browser;
async function page(html, work, name) {
  browser ||= await chromium.launch({ executablePath: env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  const f = path.join(work, name); fs.writeFileSync(f, html);
  const p = await browser.newPage({ viewport: { width: W, height: H } });
  await p.goto('file://' + f); await p.waitForFunction('window.__ready === true', null, { timeout: 30000 });
  return p;
}
async function renderAnim(html, seconds, out, work) {
  const p = await page(html, work, path.basename(out) + '.html');
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'veryfast', out]);
  const n = Math.round(seconds * FPS);
  for (let i = 0; i < n; i++) {
    await p.evaluate(ms => window.seek(ms), (i / FPS) * 1000);
    const png = await p.screenshot({ type: 'png' });
    if (!ff.stdin.write(png)) await new Promise(r => ff.stdin.once('drain', r));
  }
  ff.stdin.end(); await new Promise((res, rej) => ff.on('close', c => c ? rej(new Error('ffmpeg ' + c)) : res())); await p.close();
}
async function renderPNG(html, out, work) {
  const p = await page(html, work, path.basename(out) + '.html');
  fs.writeFileSync(out, await p.screenshot({ type: 'png', omitBackground: true })); await p.close();
}
function hookLines(screen) {
  return screen.split('/').map(s => s.trim()).filter(Boolean).map(l => {
    const m = l.match(/^\*(.+)\*$/);
    return `<span class="ln"><span>${m ? `<span class="hl">${esc(m[1])}</span>` : esc(l)}</span></span>`;
  }).join('');
}
// Captions: 2-3 word chunks, timed by character length across the spoken duration. *words* in the body turn gold.
function captionsASS(body, seconds) {
  const toks = body.split(/\s+/).filter(Boolean).map(w => ({ w: plain(w).toUpperCase(), gold: /\*/.test(w) }));
  const chunks = []; let cur = [];
  for (const t of toks) { cur.push(t); const len = cur.map(x => x.w).join(' ').length; if (cur.length === 3 || len > 16 || /[.,;:?!]$/.test(t.w)) { chunks.push(cur); cur = []; } }
  if (cur.length) chunks.push(cur);
  const start = 0.15, end = Math.max(start + 1, seconds - 0.25);
  const total = chunks.reduce((s, c) => s + c.map(x => x.w).join(' ').length + 2, 0);
  const ts = s => { const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = (s % 60).toFixed(2).padStart(5, '0'); return `${h}:${String(m).padStart(2, '0')}:${x}`; };
  let t = start; const ev = [];
  for (const c of chunks) {
    const d = (end - start) * (c.map(x => x.w).join(' ').length + 2) / total;
    const txt = c.map(x => x.gold ? `{\\c&H00BFFD&}${x.w}{\\c&HFFFFFF&}` : x.w).join(' ');
    ev.push(`Dialogue: 0,${ts(t)},${ts(t + d)},Cap,,0,0,0,,{\\fad(60,0)}${txt}`); t += d;
  }
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Cap,${env.CAPTION_FONT || 'Montserrat Thin Black'},92,&H00FFFFFF,&H00FFFFFF,&H000B0B0B,&H64000000,0,0,0,0,100,100,-1,0,1,7,3,5,80,80,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
    ev.map(e => e.replace('{\\fad', '{\\pos(540,1060)\\fad')).join('\n') + '\n';
}

// ---------- main ----------
// A job can hold one script or a whole batch (several "SCRIPT #" blocks). Each script runs on its own;
// one bad script is skipped and logged, the rest still render.
async function main() {
  const raw = env.JOB_B64 ? Buffer.from(env.JOB_B64, 'base64').toString('utf8') : (env.JOB_FILE ? fs.readFileSync(env.JOB_FILE, 'utf8') : null);
  if (!raw) { log('No job set. Idle.'); return; }
  const scripts = raw.trim().startsWith('{') ? [raw] : raw.split(/(?=SCRIPT\s*#\s*\d+)/i).map(s => s.trim()).filter(s => /SCRIPT\s*#/i.test(s));
  log(`Batch: ${scripts.length} script(s)`);
  const before = await wallet();
  let rendered = 0;
  for (const s of scripts) {
    try { if (await runOne(s)) rendered++; } catch (e) { log('SCRIPT FAILED:', (s.match(/SCRIPT\s*#\s*\d+/i) || ['?'])[0], e.message); }
  }
  const after = await wallet();
  if (before != null && after != null) {
    const spent = before - after;
    log(`COST batch: wallet $${before.toFixed(2)} -> $${after.toFixed(2)}, spent $${spent.toFixed(2)} on ${rendered} new video(s)` +
      (rendered ? `, ~$${(spent / rendered).toFixed(2)} per video` : ''));
  }
  log('BATCH DONE');
}
async function runOne(raw) {
  const parsed = parseScript(raw);
  const isAgent = /agent/i.test(parsed.audience || '');
  // AGENT scripts use their own look when AGENT_AVATAR_ID is set (suit); CONSUMER scripts use AVATAR_ID (striped shirt).
  const job = { avatarId: (isAgent && env.AGENT_AVATAR_ID) || env.AVATAR_ID, avatarType: (isAgent && env.AGENT_AVATAR_ID ? env.AGENT_AVATAR_TYPE : env.AVATAR_TYPE) || 'talking_photo',
    voiceId: env.VOICE_ID, engine: env.ENGINE || 'iv', count: '', ...parsed };
  // Optional background image from assets/backgrounds/ (already 1080x1920, so it fills the portrait frame).
  // AGENT_BACKGROUND / BACKGROUND = file name, e.g. "studio.jpg". Unset = avatar keeps its own background.
  job.background = (isAgent && env.AGENT_BACKGROUND) || env.BACKGROUND || '';
  if (job.only) job.variants = job.variants.filter(v => job.only.includes(v.key));
  const errs = validate(job);
  if (errs.length) { log('JOB REJECTED:', errs.join(' | ')); return; }
  job.count ||= job.number ? `${String(job.number).padStart(2, '0')} / 30` : '';
  job.chip ||= job.number ? `Mito #${String(job.number).padStart(2, '0')}` : 'HomePros';
  job.kicker ||= 'Nadie te lo dice';
  const id = crypto.createHash('sha1').update(JSON.stringify([job.variants, job.body, job.cta, job.avatarId, job.voiceId, job.engine, job.avatarType, ...(job.background ? [job.background] : [])])).digest('hex').slice(0, 12);
  if (job.background) {
    const f = path.join(ROOT, 'assets', 'backgrounds', path.basename(job.background));
    if (!fs.existsSync(f)) { log('JOB REJECTED: background not found', job.background); return; }
    job.bgUrl = await putFile(`assets/backgrounds/${path.basename(f)}`, fs.readFileSync(f), 'image/jpeg');
  }
  const pre = `jobs/${job.number ? 'script' + String(job.number).padStart(2, '0') + '-' : ''}${id}`;
  const state = (await getJSON(`${pre}/state.json`)) || { clips: {} };
  // RECOMPOSE=1 rebuilds a finished job from the clips HeyGen already rendered (no new HeyGen cost).
  if (state.done && env.RECOMPOSE === '1') { log('Recomposing from existing clips'); delete state.done; }
  if (state.done) { log('Already finished:'); for (const u of Object.values(state.outputs)) log('RESULT', `SCRIPT ${job.number ?? id}`, 'done', u); return; }

  // cost guard: estimate seconds before spending anything
  const texts = { body: job.body, cta: job.cta, ...Object.fromEntries(job.variants.map(v => ['hook' + v.key, v.spoken])) };
  const estSec = Object.values(texts).reduce((s, t) => s + words(t) / 2.6 + 0.6, 0);
  const rate = { talking_photo: { iv: 0.0385, iii: 0.0165 }, avatar: { iv: 0.0805, iii: 0.01, v: 0.12 } }[job.avatarType]?.[job.engine] ?? 0.12;
  log(`Job ${pre}: ${job.variants.length} hook(s), ~${estSec.toFixed(0)}s of avatar video, est. $${(estSec * rate).toFixed(2)}`);
  if (estSec > Number(env.MAX_SECONDS || 150)) { log(`JOB REJECTED: ~${estSec.toFixed(0)}s exceeds MAX_SECONDS`); return; }

  // CLIPS='{"body":"<heygen video id>",...}' uses clips that already exist in HeyGen instead of rendering new ones
  if (env.CLIPS) Object.assign(state.clips, JSON.parse(env.CLIPS));
  // 1. submit every clip once (IDs saved immediately)
  for (const [k, t] of Object.entries(texts)) if (!state.clips[k]) {
    state.clips[k] = await submitClip(t, job); job.newClips = true; await putJSON(`${pre}/state.json`, state); log('submitted', k, state.clips[k]);
  }
  // 2. wait + download
  const work = fs.mkdtempSync('/tmp/job-');
  const clip = {};
  for (const [k, vid] of Object.entries(state.clips)) { const url = await waitClip(vid); clip[k] = path.join(work, 'clip-' + k + '.mp4'); await download(url, clip[k]); log('clip ready', k, dur(clip[k]).toFixed(1) + 's', size(clip[k])); }

  // 3. shared pieces: body segment with name card + captions, end card with CTA voice
  await renderPNG(fill('card.html', { CARD_MODE: env.CARD_MODE === 'cover' ? 'cover' : '' }), path.join(work, 'card.png'), work);
  const bodyLen = dur(clip.body);
  fs.writeFileSync(path.join(work, 'cap.ass'), captionsASS(job.body, bodyLen));
  const fontsdir = path.join(ROOT, 'fonts');
  const blurIn = makeBlurMask(work, bodyLen);
  const fx = env.FX === '1' ? await buildFx(job, bodyLen, work) : null;
  const extra = [], idx = 2 + (blurIn.length ? 1 : 0);
  let base = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1`;
  if (fx) {
    // GREEN mode: key the avatar off its green background, then stack studio photo -> back effects -> avatar
    const bg = path.join(ROOT, 'assets', 'backgrounds', path.basename(env.BACKGROUND || 'studio.jpg'));
    extra.push('-loop', '1', '-t', (bodyLen + 1).toFixed(2), '-i', bg, '-i', fx.back, '-i', fx.front || fx.back);
    const [ib, iback, ifront] = [idx, idx + 1, idx + 2];
    base = `[${ib}:v]scale=${W}:${H},fps=${FPS},setsar=1[bgi];[${iback}:v]setpts=PTS-STARTPTS[bk];[bgi][bk]overlay=0:0:eof_action=pass[bgx];` +
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1,chromakey=0x00FF00:0.16:0.06,despill=type=green[fg];` +
      `[bgx][fg]overlay=0:0:shortest=1`;
  }
  const front = fx?.front ? `[o0];[${idx + 2}:v]setpts=PTS-STARTPTS+${fx.frontStart.toFixed(3)}/TB[fr];[o0][fr]overlay=0:0:eof_action=pass` : '';
  run('ffmpeg', ['-y', '-loglevel', 'error', '-i', clip.body, '-i', path.join(work, 'card.png'), ...blurIn, ...extra, '-filter_complex',
    `${base}${blurFilter()}${fx ? snapFilter(fx.snap) : motionFilter(job.body, bodyLen)}[v];[v][1:v]overlay=0:0,ass=${path.join(work, 'cap.ass')}:fontsdir=${fontsdir}${front}[o];[0:a]aresample=48000,aformat=channel_layouts=stereo[a]`,
    '-map', '[o]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '19', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '160k', path.join(work, 'seg-body.mp4')]);
  const ctaLen = dur(clip.cta), endLen = Math.max(3.6, ctaLen + 1.0);
  const kw = (job.keyword || (/agent/i.test(job.audience || '') ? 'AGENTE' : 'CASA')).toUpperCase().replace(/[^A-ZÁÉÍÓÚÑ]/g, '');
  const agent = /agent/i.test(job.audience || '');
  const endVars = { Q: agent ? '¿Eres agente?' : '¿Tienes esta duda?', KW: esc(kw), N: String(kw.length), W: (kw.length * 1.1).toFixed(1),
    SUB: agent ? 'Te mando la información por mensaje.' : 'Te mando la respuesta por mensaje.<br>Sin pena, sin compromiso.' };
  await renderAnim(fill('end.html', endVars), endLen, path.join(work, 'end.mp4'), work);
  voiceOver(path.join(work, 'end.mp4'), clip.cta, endLen, path.join(work, 'seg-end.mp4'), 0.35);

  // progress bar strip (gradient), slid across the whole video
  run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `gradients=s=${W}x10:c0=0x147EFB:c1=0xFDBF00:x0=0:y0=0:x1=${W}:y1=0:d=1`, '-frames:v', '1', path.join(work, 'bar.png')]);

  // 4. one finished video per hook variant
  const outputs = {};
  for (const v of job.variants) {
    const hk = clip['hook' + v.key], hookLen = Math.max(2.8, dur(hk) + 0.35);
    await renderAnim(fill('hook.html', { CHIP: esc(job.chip), KICKER: esc(job.kicker), COUNT: esc(job.count), LINES: hookLines(v.screen) }), hookLen, path.join(work, `hook${v.key}.mp4`), work);
    voiceOver(path.join(work, `hook${v.key}.mp4`), hk, hookLen, path.join(work, `seg-hook${v.key}.mp4`), 0.0);
    const out = path.join(work, `final-${v.key}.mp4`);
    const total = hookLen + dur(path.join(work, 'seg-body.mp4')) + endLen;
    run('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(work, `seg-hook${v.key}.mp4`), '-i', path.join(work, 'seg-body.mp4'), '-i', path.join(work, 'seg-end.mp4'), '-loop', '1', '-i', path.join(work, 'bar.png'), '-filter_complex',
      `[0:v][0:a][1:v][1:a][2:v][2:a]concat=n=3:v=1:a=1[cv][ca];[cv][3:v]overlay=x='-${W}+${W}*t/${total.toFixed(3)}':y=0:shortest=1[v];[ca]loudnorm=I=-14:TP=-1.5:LRA=11[a]`,
      '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '19', '-preset', 'medium', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', out]);
    const name = `HomePros-${job.number ? 'Script' + String(job.number).padStart(2, '0') : id}${job.variants.length > 1 ? '-Hook' + v.key : ''}.mp4`;
    outputs[v.key] = await putFile(`${pre}/${name}`, fs.readFileSync(out), 'video/mp4');
    log('RESULT', `SCRIPT ${job.number ?? id}`, `${dur(out).toFixed(1)}s`, outputs[v.key]);
  }
  await putJSON(`${pre}/state.json`, { ...state, done: true, outputs, caption: job.caption, hashtags: job.hashtags });
  log('JOB DONE', pre);
  return !!job.newClips;
}
// BLUR_BOX="x,y,w,h" (1080x1920 coordinates): blurs a band of the avatar video, e.g. captions burned into the
// avatar's training footage. Applied before the name card and our captions, so those stay sharp on top.
const blurBox = () => { const b = (env.BLUR_BOX || '').split(',').map(Number); return b.length === 4 && !b.some(isNaN) ? b : null; };
// soft-edged mask so the blurred band fades out instead of showing a hard rectangle
function makeBlurMask(work, seconds) {
  const b = blurBox(); if (!b) return [];
  const [, , w, h] = b, f = path.join(work, 'blurmask.png'), e = 26;
  run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${w}x${h}`, '-vf',
    `drawbox=x=${e}:y=${e}:w=${w - 2 * e}:h=${h - 2 * e}:color=white:t=fill,gblur=sigma=${e / 2},format=gray`, '-frames:v', '1', f]);
  return ['-loop', '1', '-t', (seconds + 1).toFixed(2), '-i', f]; // bounded so the encode always ends
}
function blurFilter() {
  const b = blurBox(); if (!b) return '';
  const [x, y, w, h] = b;
  return `,split[bg][bb];[2:v]format=gray[mk];[bb]crop=${w}:${h}:${x}:${y},gblur=sigma=30,format=yuva420p[b0];[b0][mk]alphamerge=shortest=1[bl];[bg][bl]overlay=${x}:${y}:shortest=1`;
}
// MOTION=1: punch-in "camera cuts". Shots follow the script's sentences (same timing model as the captions),
// alternating wide and tight (+15%, anchored low so the covered captions stay behind the bar), plus a quick
// white flash where the hook hands off to the body. Name bar and captions are drawn later, so they never move.
function motionShots(body, seconds) {
  const sents = plain(body).split(/(?<=[.?!])\s+/).map(x => x.trim()).filter(Boolean);
  const total = sents.reduce((a, x) => a + x.length + 2, 0), start = 0.15, end = Math.max(1, seconds - 0.25);
  let t = start; const shots = [];
  for (const x of sents) { const d = (end - start) * (x.length + 2) / total; shots.push([t, t + d]); t += d; }
  const merged = []; // no shot shorter than 1.6s; split anything longer than 5.5s
  for (const sh of shots) { const last = merged[merged.length - 1]; if (last && last[1] - last[0] < 1.6) last[1] = sh[1]; else merged.push([...sh]); }
  const out = [];
  for (const [a, b] of merged) { if (b - a > 5.5) { const m = (a + b) / 2; out.push([a, m], [m, b]); } else out.push([a, b]); }
  if (out.length) { out[0][0] = 0; out[out.length - 1][1] = seconds + 1; }
  return out;
}
function motionFilter(body, seconds) {
  if (env.MOTION !== '1') return '';
  const z = Number(env.MOTION_ZOOM || 1.15), zw = Math.round(W * z / 2) * 2, zh = Math.round(H * z / 2) * 2;
  const ay = Number(env.MOTION_ANCHOR_Y || 1100); // point that stays put when punching in
  const cx = Math.round((zw - W) / 2), cy = Math.max(0, Math.min(zh - H, Math.round(ay * z - ay)));
  const tight = motionShots(body, seconds).filter((_, i) => i % 2 === 1).map(([a, b]) => `between(t,${a.toFixed(2)},${b.toFixed(2)})`).join('+') || '0';
  return `,split[mw][mt];[mt]scale=${zw}:${zh},crop=${W}:${H}:${cx}:${cy}[mz];[mw][mz]overlay=0:0:enable='${tight}',fade=t=in:st=0:d=0.18:color=white`;
}
// ---------- body effects (FX=1) ----------
// When a phrase is spoken, estimated from its position in the body text (same timing model as the captions).
function phraseTime(body, phrase, seconds) {
  const norm = x => plain(x).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const b = norm(body), i = b.indexOf(norm(phrase).trim());
  if (i < 0) return null;
  const start = 0.15, end = Math.max(1, seconds - 0.25);
  return start + (end - start) * i / b.length;
}
// One sharp punch-in (+12%) for the length of the Snap line. Used once per video.
function snapFilter(snap) {
  if (!snap) return '';
  const z = 1.12, zw = Math.round(W * z / 2) * 2, zh = Math.round(H * z / 2) * 2, ay = 1100;
  const cx = Math.round((zw - W) / 2), cy = Math.round(ay * z - ay);
  return `,split[sw][st];[st]scale=${zw}:${zh},crop=${W}:${H}:${cx}:${cy}[sz];[sw][sz]overlay=0:0:enable='between(t,${snap[0].toFixed(2)},${snap[1].toFixed(2)})'`;
}
// transparent animation (alpha) for overlays
async function renderAlpha(html, seconds, out, work) {
  const p = await page(html, work, path.basename(out) + '.html');
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-', '-c:v', 'qtrle', '-pix_fmt', 'argb', out]);
  const n = Math.max(1, Math.round(seconds * FPS));
  for (let i = 0; i < n; i++) {
    await p.evaluate(ms => window.seek(ms), (i / FPS) * 1000);
    const png = await p.screenshot({ type: 'png', omitBackground: true });
    if (!ff.stdin.write(png)) await new Promise(r => ff.stdin.once('drain', r));
  }
  ff.stdin.end(); await new Promise((res, rej) => ff.on('close', c => c ? rej(new Error('ffmpeg ' + c)) : res())); await p.close();
}
async function buildFx(job, bodyLen, work) {
  const T = ph => phraseTime(job.body, ph, bodyLen);
  // back layer: magazine headline behind the head, first ~2.8s
  const back = path.join(work, 'fx-back.mov');
  await renderAlpha(fill('fx-back.html', { HEADLINE: esc((job.headline || job.topic || '').toUpperCase()) }), job.headline ? 3.0 : 0.1, back, work);
  // front layer: callouts (left) + checklist (right), timed to when each word is spoken
  const items = [];
  for (const c of job.callouts || []) { const t = T(c); if (t != null) items.push({ kind: 'call', text: c, t }); }
  for (const c of job.checklist || []) { const t = T(c); if (t != null) items.push({ kind: 'check', text: c, t }); }
  const snapT = job.snap ? T(job.snap) : null;
  const snap = snapT != null ? [snapT, Math.min(bodyLen - 0.3, snapT + Math.max(1.4, plain(job.snap).length / 15))] : null;
  if (!items.length) return { back, front: null, frontStart: 0, snap };
  const s0 = Math.max(0, Math.min(...items.map(x => x.t)) - 0.3);
  const groupEnd = kind => { const ts = items.filter(x => x.kind === kind).map(x => x.t); return ts.length ? Math.max(...ts) + 2.6 : 0; };
  const endCall = groupEnd('call'), endCheck = groupEnd('check');
  const seconds = Math.min(bodyLen, Math.max(endCall, endCheck) + 0.6) - s0;
  const html = (kind, end) => items.filter(x => x.kind === kind).map((x, i) =>
    `<div class="${kind}" style="--in:${((x.t - s0) * 1000).toFixed(0)}ms;--out:${((end - s0) * 1000).toFixed(0)}ms;--i:${i}"><span>${esc(x.text)}</span></div>`).join('');
  const front = path.join(work, 'fx-front.mov');
  await renderAlpha(fill('fx-front.html', { CALLS: html('call', endCall), CHECKS: html('check', endCheck) }), seconds, front, work);
  log('fx', `${items.length} item(s) from ${s0.toFixed(1)}s`, snap ? `snap ${snap.map(x => x.toFixed(1)).join('-')}` : '');
  return { back, front, frontStart: s0, snap };
}
// silent animation + voice clip → one segment of exact length
function voiceOver(videoIn, voiceClip, seconds, out, delay) {
  run('ffmpeg', ['-y', '-loglevel', 'error', '-i', videoIn, '-i', voiceClip, '-filter_complex',
    `[0:v]fps=${FPS},setsar=1[v];[1:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(delay * 1000)}:all=1,apad[a]`,
    '-map', '[v]', '-map', '[a]', '-t', seconds.toFixed(3), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '19', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '160k', out]);
}

main().catch(e => { log('JOB FAILED:', e.message); }).finally(async () => {
  if (browser) await browser.close();
  if (env.STAY_ALIVE !== '0') { log('Idle (set a new JOB_B64 to run another).'); setInterval(() => {}, 1 << 30); }
});
