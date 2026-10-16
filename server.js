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
let DB;
function db() {
  if (DB) return DB;
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      users: [
        { id: 1, username: "admin", password: hash(process.env.ADMIN_PASSWORD || "admin123"), role: "admin" },
        { id: 2, username: "student", password: hash("student123"), role: "user" },
      ],
      nextUserId: 3,
      videos: {},          // youtubeId -> video
      channelRules: {},    // channelId -> { title, rule: "approve" | "reject" }
      categories: {},      // categoryId -> name
      google: null,        // { email, refreshToken, accessToken, expiry }
      lastSync: null,
      lastSyncResult: null,
    }, null, 2));
  }
  DB = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  return DB;
}
function save() { fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2)); }

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
  resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: "lax" },
}));
app.use(express.static(path.join(__dirname, "public")));
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
  res.json({
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
    db().videos[id] = { id, title: req.body.title || "Video " + id, channel: "", channelId: "", categoryId: "", category: "Other",
      duration: "", publishedAt: new Date().toISOString(), views: 0, sources: ["Added by link"], status: "pending",
      decidedBy: null, addedAt: new Date().toISOString() };
    save();
  }
  res.json(db().videos[id] || { error: "YouTube did not return this video." });
}));

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

app.listen(PORT, () => {
  db();
  console.log(`VidGate running → http://localhost:${PORT}`);
  console.log("Admin: admin / admin123    User: student / student123");
  console.log(googleConfigured ? "Google sign-in configured." : "Google not configured yet — fill config.json to connect a YouTube account. Demo feed works without it.");
  if (cfg.autoSyncHours > 0) setInterval(() => { if (db().google) sync().catch(() => {}); }, cfg.autoSyncHours * 3600000);
});
