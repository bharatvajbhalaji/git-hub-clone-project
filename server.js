// VidGate — the administrator connects a YouTube (Google) account. Every video YouTube
// gives that account (subscriptions, liked, playlists, trending in every category, search)
// lands in the admin's review queue. Only videos the admin approves reach users.
//
// Run:  npm install   then   npm start   → http://localhost:3000
// Google setup: copy config.example.json to config.json and fill it in (see README).
const express = require("express");
const session = require("express-session");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "data.json");
const CFG_FILE = path.join(__dirname, "config.json");

const cfg = Object.assign({
  googleClientId: "",
  googleClientSecret: "",
  redirectUri: `http://localhost:${PORT}/auth/google/callback`,
  region: "IN",                 // trending region
  videosPerChannel: 10,         // latest uploads pulled from each subscribed channel
  trendingPerCategory: 25,      // trending videos pulled per YouTube category
  autoSyncHours: 6,             // 0 = off
}, fs.existsSync(CFG_FILE) ? JSON.parse(fs.readFileSync(CFG_FILE, "utf8")) : {},
  // on a hosting service, set these as environment variables instead of config.json
  Object.fromEntries(Object.entries({
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.REDIRECT_URI,
    region: process.env.REGION,
  }).filter(([, v]) => v)));
app.set("trust proxy", 1);
const googleConfigured = !!(cfg.googleClientId && cfg.googleClientSecret);

// ---------------- storage ----------------
function hash(pw, salt = crypto.randomBytes(16).toString("hex")) {
  return salt + ":" + crypto.scryptSync(pw, salt, 64).toString("hex");
}
function verify(pw, stored) {
  const [salt, h] = stored.split(":");
  const t = crypto.scryptSync(pw, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(t, "hex"));
}
// Data lives in memory and is saved to Postgres when DATABASE_URL is set (hosting),
// otherwise to data.json (your own computer).
let DB, pg;
const blank = () => ({
  users: [
    { id: 1, username: "admin", password: hash(process.env.ADMIN_PASSWORD || "admin123"), role: "admin" },
    { id: 2, username: "student", password: hash("student123"), role: "user" },
  ],
  nextUserId: 3,
  videos: {},          // youtubeId -> video
  channels: {},        // channelId -> { title, category, addedAt, lastChecked, error }
  channelRules: {},    // channelId -> { title, rule: "approve" | "reject" }
  categories: {},      // categoryId -> name
  google: null,        // { email, refreshToken, accessToken, expiry }
  lastSync: null, lastSyncResult: null,
  lastFeedCheck: null, lastFeedResult: null,
});
async function init() {
  let stored = null;
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    const url = process.env.DATABASE_URL;
    pg = new Pool({ connectionString: url, ssl: /render\.com/.test(url) ? { rejectUnauthorized: false } : undefined });
    await pg.query("create table if not exists vidgate_store (k text primary key, v jsonb not null)");
    stored = (await pg.query("select v from vidgate_store where k = 'db'")).rows[0]?.v || null;
  } else if (fs.existsSync(DB_FILE)) {
    stored = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  }
  DB = { ...blank(), ...(stored || {}) };
  save();
}
function db() { return DB; }
let saveT, saveChain = Promise.resolve();
function save() {
  if (!pg) { fs.writeFileSync(DB_FILE, JSON.stringify(DB)); return; }
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    const json = JSON.stringify(DB);
    saveChain = saveChain
      .then(() => pg.query("insert into vidgate_store (k, v) values ('db', $1) on conflict (k) do update set v = excluded.v", [json]))
      .catch(e => console.error("Saving to database failed:", e.message));
  }, 300);
}

// ---------------- helpers ----------------
function youtubeId(input) {
  const m = String(input).match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{11}$/.test(input) ? input : null;
}
function fmtDuration(iso) {
  const m = String(iso || "").match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return "";
  const h = (+m[1] || 0) * 24 + (+m[2] || 0), mi = +m[3] || 0, s = +m[4] || 0;
  const p = n => String(n).padStart(2, "0");
  return h ? `${h}:${p(mi)}:${p(s)}` : `${mi}:${p(s)}`;
}
const wait = ms => new Promise(r => setTimeout(r, ms));
// retry a YouTube request once after a pause; YouTube refuses bursts of requests
async function retry(fn) { try { return await fn(); } catch (e) { await wait(2500); return fn(); } }
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const publicVideo = v => ({ ...v, sources: [...new Set(v.sources)] });

// ---------------- Google OAuth + YouTube Data API ----------------
const SCOPES = "openid email https://www.googleapis.com/auth/youtube.readonly";

async function accessToken() {
  const g = db().google;
  if (!g) throw new Error("No YouTube account is connected.");
  if (g.accessToken && Date.now() < g.expiry - 60000) return g.accessToken;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret,
      refresh_token: g.refreshToken, grant_type: "refresh_token" }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Google sign-in expired. Connect the YouTube account again.");
  g.accessToken = j.access_token; g.expiry = Date.now() + j.expires_in * 1000; save();
  return g.accessToken;
}
async function yt(endpoint, params) {
  const url = `https://www.googleapis.com/youtube/v3/${endpoint}?${new URLSearchParams(params)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  const j = await r.json();
  if (!r.ok) {
    const reason = j.error?.errors?.[0]?.reason;
    if (reason === "quotaExceeded") throw new Error("YouTube daily quota used up. Sync again tomorrow.");
    throw new Error(j.error?.message || `YouTube API error on ${endpoint}`);
  }
  return j;
}
async function allPages(endpoint, params, maxPages = 20) {
  let items = [], pageToken;
  for (let i = 0; i < maxPages; i++) {
    const j = await yt(endpoint, { ...params, ...(pageToken ? { pageToken } : {}) });
    items = items.concat(j.items || []);
    if (!(pageToken = j.nextPageToken)) break;
  }
  return items;
}

// Fetch full details for video ids and add them to the store with their sources.
async function upsertVideos(found /* Map id -> Set(source) */) {
  const d = db(); let added = 0;
  for (const ids of chunk([...found.keys()], 50)) {
    const j = await yt("videos", { part: "snippet,contentDetails,statistics", id: ids.join(","), maxResults: 50 });
    for (const it of j.items || []) {
      const s = it.snippet, srcs = [...found.get(it.id)];
      const ex = d.videos[it.id];
      if (ex) { ex.sources = [...new Set([...ex.sources, ...srcs])]; ex.views = +it.statistics?.viewCount || ex.views; continue; }
      const rule = d.channelRules[s.channelId]?.rule;
      d.videos[it.id] = {
        id: it.id, title: s.title, channelId: s.channelId, channel: s.channelTitle,
        categoryId: s.categoryId, category: d.categories[s.categoryId] || "Other",
        duration: fmtDuration(it.contentDetails?.duration), publishedAt: s.publishedAt,
        views: +it.statistics?.viewCount || 0, sources: srcs,
        status: rule === "approve" ? "approved" : rule === "reject" ? "rejected" : "pending",
        decidedBy: rule ? "channel rule" : null, addedAt: new Date().toISOString(),
      };
      added++;
    }
  }
  save();
  return added;
}

let syncing = false;
async function sync() {
  if (syncing) return;
  syncing = true;
  const d = db(), found = new Map(), log = [];
  const add = (id, src) => { if (!id) return; if (!found.has(id)) found.set(id, new Set()); found.get(id).add(src); };
  const step = async (label, fn) => { try { const n = await fn(); log.push(`${label}: ${n}`); } catch (e) { log.push(`${label}: failed — ${e.message}`); } };
  try {
    // 1. every YouTube category for the region
    await step("Categories", async () => {
      const j = await yt("videoCategories", { part: "snippet", regionCode: cfg.region, hl: "en" });
      for (const c of j.items) d.categories[c.id] = c.snippet.title;
      return j.items.length;
    });
    // 2. latest uploads from every subscribed channel
    await step("Subscription videos", async () => {
      const subs = await allPages("subscriptions", { part: "snippet", mine: "true", maxResults: 50 }, 40);
      const chIds = subs.map(s => s.snippet.resourceId.channelId);
      let n = 0;
      for (const ids of chunk(chIds, 50)) {
        const ch = await yt("channels", { part: "contentDetails", id: ids.join(","), maxResults: 50 });
        for (const c of ch.items || []) {
          const up = c.contentDetails?.relatedPlaylists?.uploads; if (!up) continue;
          try {
            const pl = await yt("playlistItems", { part: "contentDetails", playlistId: up, maxResults: cfg.videosPerChannel });
            for (const it of pl.items || []) { add(it.contentDetails.videoId, "Subscriptions"); n++; }
          } catch { /* channel with no public uploads */ }
        }
      }
      return `${n} from ${chIds.length} channels`;
    });
    // 3. liked videos
    await step("Liked videos", async () => {
      const items = await allPages("videos", { part: "id", myRating: "like", maxResults: 50 }, 10);
      items.forEach(v => add(v.id, "Liked"));
      return items.length;
    });
    // 4. the account's own playlists
    await step("Playlist videos", async () => {
      const pls = await allPages("playlists", { part: "snippet", mine: "true", maxResults: 50 }, 5);
      let n = 0;
      for (const p of pls) {
        const items = await allPages("playlistItems", { part: "contentDetails", playlistId: p.id, maxResults: 50 }, 4);
        items.forEach(it => { add(it.contentDetails.videoId, `Playlist: ${p.snippet.title}`); n++; });
      }
      return n;
    });
    // 5. trending overall + trending in every category
    await step("Trending videos", async () => {
      let n = 0;
      const pull = async (catId, label) => {
        try {
          const j = await yt("videos", { part: "id", chart: "mostPopular", regionCode: cfg.region,
            maxResults: cfg.trendingPerCategory, ...(catId ? { videoCategoryId: catId } : {}) });
          j.items.forEach(v => { add(v.id, label); n++; });
        } catch { /* some categories have no chart */ }
      };
      await pull(null, "Trending");
      for (const [id, name] of Object.entries(d.categories)) await pull(id, `Trending: ${name}`);
      return n;
    });
    const added = await upsertVideos(found);
    log.push(`New videos waiting or auto-decided: ${added}`);
    d.lastSync = new Date().toISOString();
    d.lastSyncResult = log;
    save();
  } finally { syncing = false; }
}

// ---------------- channel feeds (no Google sign-in needed) ----------------
// Every YouTube channel publishes a public feed of its latest ~15 videos.
const UA = { "User-Agent": "Mozilla/5.0 (compatible; VidGate/1.0)", "Accept-Language": "en-US,en;q=0.8" };
const unxml = s => String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&");

// Accepts a channel link, @handle, channel id, or a video link; returns the channel id.
async function resolveChannel(input) {
  input = String(input || "").trim();
  let m = input.match(/(UC[A-Za-z0-9_-]{22})/);
  if (m) return m[1];
  let url;
  if (/youtu\.be\/|watch\?|\/shorts\//.test(input)) {
    const vid = youtubeId(input);
    if (!vid) return null;
    const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${vid}&format=json`, { headers: UA, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    url = (await r.json()).author_url;
  } else if (/^https?:\/\/(www\.|m\.)?youtube\.com\//.test(input)) url = input.replace("://m.", "://www.");
  else if (/^@[\w.-]{3,}$/.test(input)) url = "https://www.youtube.com/" + input;
  else if (input.length >= 2) return (await searchChannel(input))?.id || null;   // a channel name
  else return null;
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  const html = await r.text();
  m = html.match(/<meta itemprop="identifier" content="(UC[\w-]{22})"/) || html.match(/"externalId":"(UC[\w-]{22})"/)
    || html.match(/youtube\.com\/channel\/(UC[\w-]{22})/) || html.match(/"channelId":"(UC[\w-]{22})"/);
  return m ? m[1] : null;
}

// Title + channel of one video from YouTube oEmbed (no key needed)
async function fetchInfo(id) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`, { headers: UA, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const j = await r.json();
    return { title: j.title, channel: j.author_name, channelUrl: j.author_url };
  } catch { return null; }
}

// Find a channel by name using YouTube's public search page (channels filter).
async function searchChannel(name) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(name)}&sp=EgIQAg%253D%253D&hl=en&gl=IN`;
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return null;
  const html = await r.text();
  const m = html.match(/"channelRenderer":\{"channelId":"(UC[\w-]{22})","title":\{"simpleText":"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  let title = m[2];
  try { title = JSON.parse(`"${m[2]}"`); } catch {}
  const subs = (html.slice(m.index, m.index + 4000).match(/"videoCountText":\{"accessibility":\{"accessibilityData":\{"label":"([^"]+subscribers)"/) || [])[1]
    || (html.slice(m.index, m.index + 4000).match(/"subscriberCountText":\{[^}]*"simpleText":"([^"]+)"/) || [])[1] || "";
  return { id: m[1], title, subscribers: subs };
}

// "2 min ago", "3 hours ago", "1 day ago", "2 weeks ago" -> approximate ISO time
function agoToIso(t) {
  const m = String(t || "").match(/(\d+)\s*(second|minute|min|hour|day|week|month|year)/i);
  if (!m) return new Date().toISOString();
  const unit = { second: 1, minute: 60, min: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 }[m[2].toLowerCase()];
  return new Date(Date.now() - (+m[1]) * unit * 1000).toISOString();
}
const viewsNum = t => { const m = String(t || "").replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i); if (!m) return 0;
  return Math.round(+m[1] * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || "").toUpperCase()] || 1)); };

// Latest ~30 videos from the channel's public Videos page.
async function fetchChannelPage(channelId) {
  const r = await fetch(`https://www.youtube.com/channel/${channelId}/videos?hl=en&gl=IN`, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(r.status === 404 ? "Channel not found" : `YouTube answered ${r.status}`);
  const html = await r.text();
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) throw new Error("YouTube page had no video list");
  const data = JSON.parse(m[1]);
  const title = data?.metadata?.channelMetadataRenderer?.title || "";
  const entries = [];
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    if (o.lockupViewModel) {
      const l = o.lockupViewModel;
      if (l.contentType === "LOCKUP_CONTENT_TYPE_VIDEO" && l.contentId) {
        const md = l.metadata?.lockupMetadataViewModel;
        const parts = (md?.metadata?.contentMetadataViewModel?.metadataRows || []).flatMap(r => r.metadataParts || []).map(p => p.text?.content || "");
        const badge = JSON.stringify(l.contentImage?.thumbnailViewModel?.overlays || []).match(/"thumbnailBadgeViewModel":\{"text":"([^"]+)"/);
        entries.push({ id: l.contentId, title: md?.title?.content || "", views: viewsNum(parts.find(x => /^[\d.,]+[KMB]?$/i.test(x)) || parts[0]),
          publishedAt: agoToIso(parts.find(x => /ago/i.test(x))), duration: badge ? badge[1] : "", isShort: false });
      }
      return;
    }
    if (o.videoRenderer?.videoId) {
      const v = o.videoRenderer;
      entries.push({ id: v.videoId, title: v.title?.runs?.[0]?.text || "", views: viewsNum(v.viewCountText?.simpleText),
        publishedAt: agoToIso(v.publishedTimeText?.simpleText), duration: v.lengthText?.simpleText || "", isShort: false });
      return;
    }
    for (const k in o) walk(o[k]);
  })(data);
  return { title, entries };
}

// Try the Videos page first; fall back to the old RSS feed.
async function fetchChannelVideos(channelId) {
  try { const p = await fetchChannelPage(channelId); if (p.entries.length) return p; } catch (e) { var pageErr = e; }
  try { return await fetchFeed(channelId); } catch (e) { throw pageErr || e; }
}

async function fetchFeed(channelId) {
  const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(r.status === 404 ? "Channel not found" : `YouTube answered ${r.status}`);
  const xml = await r.text();
  const head = xml.split("<entry>")[0];
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: (e.match(/<yt:videoId>([^<]+)/) || [])[1],
    title: unxml((e.match(/<title>([^<]*)/) || [])[1]),
    publishedAt: (e.match(/<published>([^<]+)/) || [])[1],
    views: +((e.match(/<media:statistics views="(\d+)"/) || [])[1] || 0),
    isShort: /youtube\.com\/shorts\//.test(e),
  })).filter(x => x.id);
  return { title: unxml((head.match(/<title>([^<]*)/) || [])[1]), entries };
}

let checking = false;
async function checkChannels(ids) {
  if (checking) return 0;
  checking = true;
  const d = db(), list = (ids || Object.keys(d.channels)).filter(id => d.channels[id]);
  let added = 0, failed = 0;
  try {
    for (const group of chunk(list, 3)) {
      await Promise.all(group.map(async cid => {
        const ch = d.channels[cid];
        try {
          const f = await retry(() => fetchChannelVideos(cid));
          if (f.title) ch.title = f.title;
          ch.lastChecked = new Date().toISOString(); ch.error = null;
          const src = `Channel: ${ch.title}`;
          for (const e of f.entries) {
            const ex = d.videos[e.id];
            if (ex) { if (!ex.sources.includes(src)) ex.sources.push(src); if (e.views) ex.views = e.views; continue; }
            const rule = d.channelRules[cid]?.rule;
            d.videos[e.id] = {
              id: e.id, title: e.title, channelId: cid, channel: ch.title, categoryId: "", category: ch.category || "General",
              duration: e.isShort ? "Short" : (e.duration || ""), publishedAt: e.publishedAt, views: e.views, sources: [src],
              status: rule === "approve" ? "approved" : rule === "reject" ? "rejected" : "pending",
              decidedBy: rule ? "channel rule" : null, addedAt: new Date().toISOString(),
            };
            added++;
          }
        } catch (err) { ch.error = err.cause?.code ? "Could not reach YouTube, will retry" : err.message; failed++; }
      }));
      await wait(600);
    }
    // YouTube's feeds sometimes answer 404/500 for a while; try the failed channels again in 5 minutes
    const failedIds = list.filter(id => d.channels[id]?.error);
    if (failedIds.length) setTimeout(() => { if (!checking) checkChannels(failedIds).catch(() => {}); }, 5 * 60000);
    d.lastFeedCheck = new Date().toISOString();
    d.lastFeedResult = `${list.length} channel${list.length === 1 ? "" : "s"} checked · ${added} new video${added === 1 ? "" : "s"}${failed ? ` · ${failed} could not be read` : ""}`;
    save();
  } finally { checking = false; }
  return added;
}
const feedStale = () => Object.keys(db().channels).length && !checking &&
  (!db().lastFeedCheck || Date.now() - new Date(db().lastFeedCheck) > 60 * 60000);

const PACKS = {
  "Tamil News": ["Thanthi TV", "Polimer News", "Puthiya Thalaimurai TV", "Sun News Tamil", "News18 Tamil Nadu", "News7 Tamil", "Kalaignar Seithigal", "BBC News Tamil", "Sathiyam TV", "Jaya Plus"],
  "Tamil Comedy": ["Adithya TV", "Sirippoli TV", "Parithabangal", "Nakkalites", "Black Sheep Tamil", "Temple Monkeys", "Jump Cuts Hari Baskar", "Madras Central"],
  "TV Shows & Serials": ["Sun TV", "Vijay Television", "Zee Tamil", "Colors Tamil", "Kalaignar TV", "Raj Television", "Jaya TV", "Polimer TV"],
  "Sports": ["Star Sports Tamil", "Chennai Super Kings", "BCCI", "ICC", "Pro Kabaddi League", "Indian Super League", "Sony Sports Network", "Olympics"],
};
// Channel ids confirmed from YouTube search results (no search needed for these)
const KNOWN = {
  "Thanthi TV": "UC-JFyL0zDFOsPMpuWu39rPA", "Polimer News": "UC8Z-VjXBtDJTvq6aqkIskPg",
  "Puthiya Thalaimurai TV": "UCmyKnNRH0wH-r8I-ceP-dsg", "Sun News Tamil": "UCYlh4lH762HvHt6mmiecyWQ",
  "News18 Tamil Nadu": "UCat88i6_rELqI_prwvjspRA",
  "Jump Cuts Hari Baskar": "UCpPOf9BQPwa4K11Zjxu1ZPw", "Temple Monkeys": "UCx2SxlhDYl8Rhkw_PqwcdSA",
  "Madras Central": "UCGBnz-FR3qaowYsyIEh2-zw", "Black Sheep Tamil": "UCzh5hQc_O3r3xjh9sXrM7-A",
  "Sun TV": "UCBnxEdpoZwstJqC1yZpOjRA",
  "Star Sports Tamil": "UCDZ0EABqiGGIEsbZ4SXVj1g", "Chennai Super Kings": "UC2J_VKrAzOEJuQvFFtj3KUw",
  "BCCI": "UCsGPbuVbgBDSf0Efw1OAb0Q", "ICC": "UCt2JXOLNxqry7B_4rRZME3Q", "Pro Kabaddi League": "UCL7l6c635bbxWkH7Gofbb-A",
};
const SEED_VERSION = 2;
// Adds every suggested channel (used once when the app starts with no channels)
async function seedPacks() {
  const d = db(), added = [];
  for (const [cat, names] of Object.entries(PACKS)) for (const name of names) {
    const id = KNOWN[name];
    if (!id || d.channels[id]) continue;
    d.channels[id] = { title: name, category: cat, addedAt: new Date().toISOString(), lastChecked: null, error: null };
    added.push(`${cat}: ${name}`);
  }
  d.seeded = SEED_VERSION;
  save();
  console.log(`Suggested channels added: ${added.length}`); added.forEach(a => console.log("  " + a));
  await checkChannels();
  console.log("First check: " + d.lastFeedResult);
  const bad = Object.values(d.channels).filter(c => c.error);
  if (bad.length) console.log("Feeds not read: " + bad.map(c => `${c.title} (${c.error})`).join(", "));
}

// Google Takeout subscriptions.csv: "Channel Id,Channel Url,Channel Title"
function parseSubscriptions(csv) {
  const out = [];
  for (const line of String(csv || "").split(/\r?\n/)) {
    const id = (line.match(/(UC[A-Za-z0-9_-]{22})/) || [])[1];
    if (!id) continue;
    const parts = line.split(",");
    out.push({ id, title: parts.slice(2).join(",").replace(/^"|"$/g, "").trim() || id });
  }
  return out;
}

// ---------------- demo feed (no Google account needed) ----------------
function loadDemo() {
  const d = db();
  const cats = { 1: "Film & Animation", 10: "Music", 17: "Sports", 20: "Gaming", 22: "People & Blogs",
    23: "Comedy", 24: "Entertainment", 25: "News & Politics", 26: "Howto & Style", 27: "Education", 28: "Science & Technology" };
  Object.assign(d.categories, cats);
  const sample = [
    ["Consolidation of Soil — Terzaghi Theory", "Civil Classroom", 27, "Subscriptions"],
    ["Bearing Capacity of Shallow Foundations", "GeoTech Lectures", 27, "Subscriptions"],
    ["Self-Healing Concrete Explained", "Structures Today", 28, "Liked"],
    ["IS 456 Design of Beams — Worked Example", "Civil Classroom", 27, "Playlist: Exam prep"],
    ["Top 10 Pranks of the Year", "Fun Clips", 23, "Trending"],
    ["Cricket Highlights — Final Over", "Sports Desk", 17, "Trending: Sports"],
    ["Lo-fi Beats to Study To", "Calm Tunes", 10, "Trending: Music"],
    ["Evening News Bulletin", "Daily News", 25, "Trending: News & Politics"],
    ["Open-World Game Walkthrough Part 1", "GameZone", 20, "Trending: Gaming"],
    ["How Bridges Carry Load", "Science Corner", 28, "Trending: Science & Technology"],
    ["Daily Spoken English Phrases", "Talk Better", 27, "Subscriptions"],
    ["Movie Trailer Reaction", "React Hub", 24, "Trending: Entertainment"],
    ["Morning Vlog in Coimbatore", "Travel Diaries", 22, "Subscriptions"],
    ["Tie a Perfect Knot in 60 Seconds", "Style Lab", 26, "Trending: Howto & Style"],
    ["Short Animated Film — The Lighthouse", "Ink Studio", 1, "Trending: Film & Animation"],
    ["Integration by Parts in 15 Minutes", "Maths Made Easy", 27, "Liked"],
  ];
  let n = 0;
  sample.forEach(([title, channel, cat, src], i) => {
    const id = ("demo" + String(i).padStart(3, "0") + "xxxxxx").slice(0, 11);
    if (d.videos[id]) return;
    d.videos[id] = { id, title, channelId: "demo-" + channel.replace(/\W/g, ""), channel, categoryId: String(cat),
      category: cats[cat], duration: `${8 + i}:${String((i * 7) % 60).padStart(2, "0")}`,
      publishedAt: new Date(Date.now() - i * 86400000).toISOString(), views: 1000 * (i + 3) ** 3,
      sources: [src], status: "pending", decidedBy: null, addedAt: new Date().toISOString(), demo: true };
    n++;
  });
  d.lastSync = new Date().toISOString();
  d.lastSyncResult = [`Demo feed loaded: ${n} videos`];
  save();
}

// ---------------- middleware ----------------
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 3600000 },
}));
app.use(express.static(path.join(__dirname, "public")));
app.get("/share", (req, res) => res.sendFile(path.join(__dirname, "public", "share.html")));
app.get("/vendor/jszip.min.js", (req, res) => res.sendFile(require.resolve("jszip/dist/jszip.min.js")));
const needLogin = (q, s, n) => q.session.user ? n() : s.status(401).json({ error: "Please log in." });
const needAdmin = (q, s, n) => q.session.user?.role === "admin" ? n() : s.status(403).json({ error: "Only the administrator can do this." });
const wrap = fn => (q, s) => Promise.resolve(fn(q, s)).catch(e => s.status(500).json({ error: e.message }));

// ---------------- auth ----------------
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const u = db().users.find(x => x.username === username);
  if (!u || !verify(password || "", u.password)) return res.status(401).json({ error: "Wrong username or password." });
  req.session.user = { id: u.id, username: u.username, role: u.role };
  res.json(req.session.user);
});
app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get("/api/me", (req, res) => res.json(req.session.user || null));

// ---------------- connect the YouTube account (admin) ----------------
app.get("/auth/google", needLogin, needAdmin, (req, res) => {
  if (!googleConfigured) return res.status(400).send("Fill in config.json with your Google OAuth client first (see README).");
  req.session.oauthState = crypto.randomBytes(16).toString("hex");
  res.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: cfg.googleClientId, redirect_uri: cfg.redirectUri, response_type: "code",
    scope: SCOPES, access_type: "offline", prompt: "consent", state: req.session.oauthState,
  }));
});
app.get("/auth/google/callback", needLogin, needAdmin, wrap(async (req, res) => {
  if (!req.query.code || req.query.state !== req.session.oauthState) return res.redirect("/?connect=failed");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: req.query.code, client_id: cfg.googleClientId, client_secret: cfg.googleClientSecret,
      redirect_uri: cfg.redirectUri, grant_type: "authorization_code" }),
  });
  const t = await r.json();
  if (!r.ok) return res.redirect("/?connect=failed");
  const info = await (await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
  db().google = { email: info.email, refreshToken: t.refresh_token, accessToken: t.access_token, expiry: Date.now() + t.expires_in * 1000 };
  save();
  sync().catch(() => {});        // first sync starts right away
  res.redirect("/?connect=ok");
}));
app.post("/api/admin/disconnect", needLogin, needAdmin, (req, res) => { db().google = null; save(); res.json({ ok: true }); });

// ---------------- admin: status, sync, review ----------------
app.get("/api/admin/status", needLogin, needAdmin, (req, res) => {
  const d = db(), vs = Object.values(d.videos);
  const count = s => vs.filter(v => v.status === s).length;
  if (feedStale()) checkChannels().catch(() => {});   // hourly refresh when the admin opens the app
  res.json({
    channelCount: Object.keys(d.channels).length, checking,
    lastFeedCheck: d.lastFeedCheck, lastFeedResult: d.lastFeedResult,
    googleConfigured, account: d.google ? d.google.email : null, syncing,
    lastSync: d.lastSync, lastSyncResult: d.lastSyncResult,
    counts: { pending: count("pending"), approved: count("approved"), rejected: count("rejected") },
    sources: [...new Set(vs.flatMap(v => v.sources))].sort(),
    categories: [...new Set(vs.map(v => v.category))].sort(),
  });
});
app.post("/api/admin/sync", needLogin, needAdmin, (req, res) => {
  if (!db().google) return res.status(400).json({ error: "Connect a YouTube account first." });
  sync().catch(() => {});
  res.json({ started: true });
});
app.post("/api/admin/demo", needLogin, needAdmin, (req, res) => { loadDemo(); res.json({ ok: true }); });

app.get("/api/admin/videos", needLogin, needAdmin, (req, res) => {
  const { status = "pending", source, category, q } = req.query;
  let list = Object.values(db().videos).filter(v => v.status === status);
  if (source) list = list.filter(v => v.sources.includes(source));
  if (category) list = list.filter(v => v.category === category);
  if (q) { const s = q.toLowerCase(); list = list.filter(v => (v.title + " " + v.channel).toLowerCase().includes(s)); }
  list.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
  res.json(list.map(publicVideo));
});
app.post("/api/admin/decide", needLogin, needAdmin, (req, res) => {
  const { ids = [], status } = req.body || {};
  if (!["approved", "rejected", "pending"].includes(status)) return res.status(400).json({ error: "Status must be approved, rejected or pending." });
  const d = db(); let n = 0;
  for (const id of ids) if (d.videos[id]) { d.videos[id].status = status; d.videos[id].decidedBy = "admin"; n++; }
  save();
  res.json({ updated: n });
});
app.delete("/api/admin/videos/:id", needLogin, needAdmin, (req, res) => { delete db().videos[req.params.id]; save(); res.json({ ok: true }); });

// search all of YouTube and drop results into the review queue
app.get("/api/admin/search", needLogin, needAdmin, wrap(async (req, res) => {
  if (!db().google) return res.status(400).json({ error: "Connect a YouTube account to search YouTube." });
  const q = String(req.query.q || "").trim();
  if (!q) return res.json([]);
  const j = await yt("search", { part: "id", type: "video", q, maxResults: 25, regionCode: cfg.region });
  const found = new Map(j.items.map(i => [i.id.videoId, new Set([`Search: ${q}`])]));
  await upsertVideos(found);
  res.json([...found.keys()].map(id => db().videos[id]).filter(Boolean).map(publicVideo));
}));
// add one video by link
app.post("/api/admin/videos", needLogin, needAdmin, wrap(async (req, res) => {
  const id = youtubeId(req.body?.url || "");
  if (!id) return res.status(400).json({ error: "That is not a YouTube video link." });
  if (db().videos[id]) return res.status(409).json({ error: "This video is already in the list." });
  if (db().google) { await upsertVideos(new Map([[id, new Set(["Added by link"])]])); }
  else {
    const info = await fetchInfo(id);
    db().videos[id] = { id, title: req.body.title || info?.title || "Video " + id, channel: info?.channel || "", channelId: "", categoryId: "", category: req.body.category || "General",
      duration: "", publishedAt: new Date().toISOString(), views: 0, sources: ["Added by link"], status: "pending",
      decidedBy: null, addedAt: new Date().toISOString() };
    save();
  }
  res.json(db().videos[id] || { error: "YouTube did not return this video." });
}));

// ---------------- YouTube bridge ----------------
// Videos sent from the admin's own YouTube (phone Share menu or the desktop button).
app.post("/api/admin/bridge", needLogin, needAdmin, wrap(async (req, res) => {
  const ids = [...new Set((req.body?.ids || []).map(String).filter(x => /^[A-Za-z0-9_-]{11}$/.test(x)))].slice(0, 100);
  const status = ["approved", "pending"].includes(req.body?.status) ? req.body.status : "pending";
  const category = String(req.body?.category || "").slice(0, 40);
  const d = db(), result = [];
  for (const group of chunk(ids, 4)) {
    await Promise.all(group.map(async id => {
      const ex = d.videos[id];
      if (ex) {
        if (!ex.sources.includes("From your YouTube")) ex.sources.push("From your YouTube");
        if (status === "approved") { ex.status = "approved"; ex.decidedBy = "admin"; }
        if (category) ex.category = category;
        result.push({ id, title: ex.title, channel: ex.channel, status: ex.status, existed: true });
        return;
      }
      const info = await fetchInfo(id);
      d.videos[id] = {
        id, title: info?.title || "YouTube video " + id, channelId: "", channel: info?.channel || "", channelUrl: info?.channelUrl || "",
        categoryId: "", category: category || "From YouTube", duration: "", publishedAt: new Date().toISOString(), views: 0,
        sources: ["From your YouTube"], status, decidedBy: status === "approved" ? "admin" : null, addedAt: new Date().toISOString(),
      };
      result.push({ id, title: d.videos[id].title, channel: d.videos[id].channel, status, existed: false });
    }));
  }
  save();
  res.json(result);
}));

// channels the admin follows (works without Google sign-in)
app.get("/api/admin/channels", needLogin, needAdmin, (req, res) => {
  const d = db(), vs = Object.values(d.videos);
  res.json(Object.entries(d.channels).map(([id, c]) => ({
    id, ...c, rule: d.channelRules[id]?.rule || null,
    pending: vs.filter(v => v.channelId === id && v.status === "pending").length,
    approved: vs.filter(v => v.channelId === id && v.status === "approved").length,
  })).sort((a, b) => a.title.localeCompare(b.title)));
});
app.post("/api/admin/channels", needLogin, needAdmin, wrap(async (req, res) => {
  const id = await resolveChannel(req.body?.input);
  if (!id) return res.status(400).json({ error: "Could not find that channel. Paste the channel's link (youtube.com/@name) or one of its video links." });
  const d = db();
  if (d.channels[id]) return res.status(409).json({ error: `${d.channels[id].title} is already in your list.` });
  d.channels[id] = { title: id, category: req.body.category || "General", addedAt: new Date().toISOString(), lastChecked: null, error: null };
  try { await fetchChannelVideos(id); } catch (e) { delete d.channels[id]; return res.status(400).json({ error: "YouTube did not return videos for that channel: " + e.message }); }
  const wasChecking = checking;
  const added = wasChecking ? 0 : await checkChannels([id]);
  res.json({ id, title: d.channels[id].title, added });
}));
// look up several channel names at once so the admin can confirm before adding
app.post("/api/admin/channels/find", needLogin, needAdmin, wrap(async (req, res) => {
  const names = (req.body?.names || []).map(String).filter(Boolean).slice(0, 30);
  const out = [];
  for (const group of chunk(names, 2)) {
    out.push(...await Promise.all(group.map(async name => {
      if (KNOWN[name]) return { name, id: KNOWN[name], title: db().channels[KNOWN[name]]?.title || name, subscribers: "", already: !!db().channels[KNOWN[name]] };
      try { const c = await retry(() => searchChannel(name)); return c ? { name, ...c, already: !!db().channels[c.id] } : { name, notFound: true }; }
      catch { return { name, notFound: true }; }
    })));
    await wait(500);
  }
  res.json(out);
}));
app.post("/api/admin/channels/import", needLogin, needAdmin, (req, res) => {
  const subs = Array.isArray(req.body?.channels)
    ? req.body.channels.filter(c => /^UC[\w-]{22}$/.test(c?.id)).slice(0, 500).map(c => ({ id: c.id, title: String(c.title || c.id).slice(0, 120) }))
    : parseSubscriptions(req.body?.csv);
  if (!subs.length) return res.status(400).json({ error: "No channels found in that file. Choose the subscriptions.csv file (or the whole Takeout zip)." });
  const d = db(), fresh = [];
  for (const s of subs) if (!d.channels[s.id]) {
    d.channels[s.id] = { title: s.title, category: req.body.category || "General", addedAt: new Date().toISOString(), lastChecked: null, error: null };
    fresh.push(s.id);
  }
  save();
  checkChannels(fresh).catch(() => {});
  res.json({ found: subs.length, added: fresh.length });
});
app.patch("/api/admin/channels/:id", needLogin, needAdmin, (req, res) => {
  const d = db(), ch = d.channels[req.params.id];
  if (!ch) return res.status(404).json({ error: "Channel not found." });
  if (req.body?.category) {
    ch.category = String(req.body.category).slice(0, 40);
    for (const v of Object.values(d.videos)) if (v.channelId === req.params.id) v.category = ch.category;
  }
  save();
  res.json(ch);
});
app.delete("/api/admin/channels/:id", needLogin, needAdmin, (req, res) => {
  const d = db();
  delete d.channels[req.params.id];
  for (const [vid, v] of Object.entries(d.videos)) if (v.channelId === req.params.id && v.status === "pending") delete d.videos[vid];
  save();
  res.json({ ok: true });
});
app.post("/api/admin/channels/check", needLogin, needAdmin, (req, res) => {
  if (!Object.keys(db().channels).length) return res.status(400).json({ error: "Add a channel first." });
  checkChannels().catch(() => {});
  res.json({ started: true });
});

// channel rules: always approve / always reject a channel's videos
app.get("/api/admin/rules", needLogin, needAdmin, (req, res) =>
  res.json(Object.entries(db().channelRules).map(([channelId, r]) => ({ channelId, ...r }))));
app.post("/api/admin/rules", needLogin, needAdmin, (req, res) => {
  const { channelId, title, rule } = req.body || {};
  if (!channelId || !["approve", "reject"].includes(rule)) return res.status(400).json({ error: "Give a channel and a rule." });
  const d = db();
  d.channelRules[channelId] = { title, rule };
  let n = 0;   // apply to that channel's undecided videos now
  for (const v of Object.values(d.videos)) if (v.channelId === channelId && v.decidedBy !== "admin") {
    v.status = rule === "approve" ? "approved" : "rejected"; v.decidedBy = "channel rule"; n++;
  }
  save();
  res.json({ applied: n });
});
app.delete("/api/admin/rules/:channelId", needLogin, needAdmin, (req, res) => { delete db().channelRules[req.params.channelId]; save(); res.json({ ok: true }); });

// user accounts
app.get("/api/admin/users", needLogin, needAdmin, (req, res) => res.json(db().users.map(({ password, ...u }) => u)));
app.post("/api/admin/users", needLogin, needAdmin, (req, res) => {
  const { username, password, role = "user" } = req.body || {};
  if (!username || !password || password.length < 6) return res.status(400).json({ error: "Give a username and a password of at least 6 characters." });
  const d = db();
  if (d.users.some(u => u.username === username)) return res.status(409).json({ error: "That username is taken." });
  const u = { id: d.nextUserId++, username, password: hash(password), role: role === "admin" ? "admin" : "user" };
  d.users.push(u); save();
  res.json({ id: u.id, username, role: u.role });
});

// ---------------- users: approved videos only ----------------
app.get("/api/videos", needLogin, (req, res) => {
  const list = Object.values(db().videos).filter(v => v.status === "approved")
    .sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""))
    .map(({ id, title, channel, category, duration, publishedAt, views, demo }) => ({ id, title, channel, category, duration, publishedAt, views, demo }));
  res.json(list);
});

init().then(() => app.listen(PORT, () => {
  console.log(pg ? "Saving data to Postgres." : "Saving data to data.json.");
  setInterval(() => { if (feedStale()) checkChannels().catch(() => {}); }, 10 * 60000);
  if (process.env.SEED_PACKS === "1" && (db().seeded || 0) < SEED_VERSION)
    seedPacks().catch(e => console.error("Adding suggested channels failed:", e.message));
  console.log(`VidGate running → http://localhost:${PORT}`);
  console.log("Logins: admin (password from ADMIN_PASSWORD, default admin123) · student / student123");
  console.log(googleConfigured ? "Google sign-in configured." : "Google not configured yet — fill config.json to connect a YouTube account. Demo feed works without it.");
  if (cfg.autoSyncHours > 0) setInterval(() => { if (db().google) sync().catch(() => {}); }, cfg.autoSyncHours * 3600000);
})).catch(e => { console.error("Could not start:", e.message); process.exit(1); });
