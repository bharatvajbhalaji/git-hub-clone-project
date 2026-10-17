const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const img = v => v.demo ? "" : `<img src="https://i.ytimg.com/vi/${v.id}/mqdefault.jpg" alt="" loading="lazy" onerror="this.remove()">`;
const ago = iso => { if (!iso) return "never"; const m = Math.round((Date.now() - new Date(iso)) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };

async function api(url, opts = {}) {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}
const showErr = (el, msg) => { $(el).textContent = msg || ""; $(el).hidden = !msg; };
function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2600); }

let me = null;

async function boot() {
  me = await api("/api/me");
  ["login", "admin", "user"].forEach(s => $(s).hidden = true);
  $("who").hidden = !me;
  if (!me) { $("login").hidden = false; return; }
  $("whoName").textContent = me.username;
  $("whoRole").textContent = me.role === "admin" ? "Administrator" : "User";
  if (me.role === "admin") { $("admin").hidden = false; adminRefresh(); }
  else { $("user").hidden = false; loadUser(); }
  const p = new URLSearchParams(location.search).get("connect");
  if (p) { toast(p === "ok" ? "YouTube account connected. First sync started." : "Could not connect the YouTube account. Try again."); history.replaceState(null, "", "/"); }
}

$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  try { await api("/api/login", { method: "POST", body: { username: $("lu").value, password: $("lp").value } }); showErr("loginErr"); boot(); }
  catch (err) { showErr("loginErr", err.message); }
});
$("logout").onclick = async () => { await api("/api/logout", { method: "POST" }); boot(); };

// ================= ADMIN =================
let tab = "pending", list = [], sel = new Set(), limit = 60, status = null, pollT = null, wasBusy = false;

async function adminRefresh() {
  status = await api("/api/admin/status");
  renderConn();
  $("nPending").textContent = status.counts.pending;
  $("nApproved").textContent = status.counts.approved;
  $("nRejected").textContent = status.counts.rejected;
  $("nChannels").textContent = status.channelCount;
  document.querySelector('#tabs [data-tab="search"]').hidden = !status.account;
  fillSelect("fsource", "All sources", status.sources);
  fillSelect("fcat", "All categories", status.categories);
  if (["pending", "approved", "rejected"].includes(tab)) await loadList();
  clearTimeout(pollT);
  if (status.syncing || status.checking) pollT = setTimeout(adminRefresh, 4000);
  else if (wasBusy && tab === "channels") loadChannels();
  wasBusy = status.syncing || status.checking;
}
function fillSelect(id, label, items) {
  const cur = $(id).value;
  $(id).innerHTML = `<option value="">${label}</option>` + items.map(s => `<option ${s === cur ? "selected" : ""}>${esc(s)}</option>`).join("");
}
function renderConn() {
  const s = status;
  const feeds = s.channelCount
    ? `${s.channelCount} channel${s.channelCount === 1 ? "" : "s"} · ${s.checking ? "checking for new videos…" : "last checked " + ago(s.lastFeedCheck)}`
    : "No channels yet";
  let html = `<div><span class="note">Videos come from</span><div class="acct">${esc(feeds)}</div>
      ${s.account ? `<span class="note">Also connected: ${esc(s.account)} · ${s.syncing ? "syncing…" : "synced " + ago(s.lastSync)}</span>` : ""}</div>
    <div class="actions">
      ${s.channelCount ? `<button class="btn" id="cCheck" ${s.checking ? "disabled" : ""}>Check for new videos</button>` : `<button class="btn" id="cGoCh">Add YouTube channels</button>`}
      <button class="btn ghost" id="cGoCh2">Manage channels</button>
      ${s.account ? `<button class="btn ghost" id="cSync" ${s.syncing ? "disabled" : ""}>Sync Google account</button><button class="btn ghost" id="cDisc">Disconnect</button>`
        : s.googleConfigured ? `<a class="btn ghost" href="/auth/google">Connect Google account</a>` : ""}
      ${!s.channelCount && !s.counts.pending && !s.counts.approved ? `<button class="btn ghost" id="cDemo">Load demo videos</button>` : ""}
    </div>`;
  const details = [s.lastFeedResult, ...(s.lastSyncResult || [])].filter(Boolean);
  if (details.length) html += `<details><summary>Last check details</summary>${details.map(esc).join("<br>")}</details>`;
  $("conn").innerHTML = html;
  const goCh = () => document.querySelector('#tabs [data-tab="channels"]').click();
  $("cGoCh") && ($("cGoCh").onclick = goCh);
  $("cGoCh2").onclick = goCh;
  $("cCheck") && ($("cCheck").onclick = startCheck);
  $("cSync") && ($("cSync").onclick = async () => { try { await api("/api/admin/sync", { method: "POST" }); toast("Sync started"); adminRefresh(); } catch (e) { toast(e.message); } });
  $("cDisc") && ($("cDisc").onclick = async () => { await api("/api/admin/disconnect", { method: "POST" }); toast("Disconnected"); adminRefresh(); });
  $("cDemo") && ($("cDemo").onclick = async () => { await api("/api/admin/demo", { method: "POST" }); toast("Demo videos loaded into the review list"); adminRefresh(); });
}
async function startCheck() {
  try { await api("/api/admin/channels/check", { method: "POST" }); toast("Checking channels for new videos…"); adminRefresh(); }
  catch (e) { toast(e.message); }
}

$("tabs").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  tab = b.dataset.tab; sel.clear(); limit = 60;
  document.querySelectorAll("#tabs button").forEach(x => x.setAttribute("aria-pressed", x === b));
  $("pane-list").hidden = !["pending", "approved", "rejected"].includes(tab);
  $("pane-search").hidden = tab !== "search";
  $("pane-rules").hidden = tab !== "rules";
  $("pane-channels").hidden = tab !== "channels";
  $("pane-bridge").hidden = tab !== "bridge";
  if (tab === "channels") loadChannels();
  $("pane-users").hidden = tab !== "users";
  if (tab === "rules") loadRules();
  if (tab === "users") loadUsers();
  adminRefresh();
};

async function loadList() {
  const p = new URLSearchParams({ status: tab });
  if ($("fsource").value) p.set("source", $("fsource").value);
  if ($("fcat").value) p.set("category", $("fcat").value);
  if ($("fq").value.trim()) p.set("q", $("fq").value.trim());
  list = await api("/api/admin/videos?" + p);
  renderList();
}
function vcard(v, pick = true) {
  const acts = v.status === "pending"
    ? `<button class="btn ok" data-a="approved" data-id="${v.id}">Approve</button><button class="btn bad" data-a="rejected" data-id="${v.id}">Reject</button>`
    : v.status === "approved" ? `<button class="btn bad" data-a="rejected" data-id="${v.id}">Remove from users</button><button class="btn ghost" data-a="pending" data-id="${v.id}">Back to review</button>`
    : `<button class="btn ok" data-a="approved" data-id="${v.id}">Approve</button><button class="btn ghost" data-a="pending" data-id="${v.id}">Back to review</button>`;
  const rule = v.channelId ? `<select data-rule="${esc(v.channelId)}" data-title="${esc(v.channel)}" aria-label="Channel rule"><option value="">Channel rule…</option><option value="approve">Always approve ${esc(v.channel)}</option><option value="reject">Always reject ${esc(v.channel)}</option></select>` : "";
  return `<div class="vcard ${sel.has(v.id) ? "sel" : ""}">
    <div class="th">${img(v)}${pick ? `<input type="checkbox" class="pick" data-pick="${v.id}" ${sel.has(v.id) ? "checked" : ""} aria-label="Select">` : ""}${v.duration ? `<span class="dur">${esc(v.duration)}</span>` : ""}</div>
    <div class="vbody"><a class="t" href="https://www.youtube.com/watch?v=${v.id}" target="_blank" rel="noopener">${esc(v.title)}</a>
      <div class="note">${esc(v.channel)} · ${esc(v.category)}${v.views ? " · " + Number(v.views).toLocaleString() + " views" : ""}</div>
      <div class="tags">${v.sources.map(s => `<span class="tag">${esc(s)}</span>`).join("")}${v.decidedBy === "channel rule" ? `<span class="tag">by channel rule</span>` : ""}</div></div>
    <div class="vact">${acts}${rule}</div></div>`;
}
function renderList() {
  const shown = list.slice(0, limit);
  $("agrid").innerHTML = shown.length ? shown.map(v => vcard(v)).join("")
    : `<div class="empty">${tab === "pending" ? "Nothing waiting for review. New videos arrive with the next sync." : "No videos here."}</div>`;
  $("more").hidden = list.length <= limit;
  $("more").textContent = `Show more (${list.length - limit} left)`;
  $("selCount").textContent = `${sel.size} selected`;
  $("selAll").checked = shown.length > 0 && shown.every(v => sel.has(v.id));
  $("bApprove").hidden = tab === "approved";
  $("bReject").hidden = tab === "rejected";
  $("bPending").hidden = tab === "pending";
}
$("more").onclick = () => { limit += 60; renderList(); };
["fsource", "fcat"].forEach(id => $(id).onchange = () => { sel.clear(); loadList(); });
let fqT; $("fq").oninput = () => { clearTimeout(fqT); fqT = setTimeout(loadList, 250); };
$("selAll").onchange = e => { list.slice(0, limit).forEach(v => e.target.checked ? sel.add(v.id) : sel.delete(v.id)); renderList(); };

async function decide(ids, st) {
  if (!ids.length) return toast("Select videos first");
  await api("/api/admin/decide", { method: "POST", body: { ids, status: st } });
  sel.clear();
  toast(`${ids.length} video${ids.length > 1 ? "s" : ""} ${st === "approved" ? "approved — users can watch now" : st === "rejected" ? "rejected" : "moved back to review"}`);
  adminRefresh();
  if (tab === "search") runSearch(true);
}
$("bApprove").onclick = () => decide([...sel], "approved");
$("bReject").onclick = () => decide([...sel], "rejected");
$("bPending").onclick = () => decide([...sel], "pending");

$("admin").addEventListener("click", e => {
  const a = e.target.closest("[data-a]"); if (a) decide([a.dataset.id], a.dataset.a);
  const u = e.target.closest("[data-unrule]"); if (u) api("/api/admin/rules/" + encodeURIComponent(u.dataset.unrule), { method: "DELETE" }).then(() => { toast("Rule removed"); loadRules(); });
});
$("admin").addEventListener("change", async e => {
  const t = e.target;
  if (t.dataset.pick) { t.checked ? sel.add(t.dataset.pick) : sel.delete(t.dataset.pick); renderList(); }
  if (t.dataset.rule && t.value) {
    const r = await api("/api/admin/rules", { method: "POST", body: { channelId: t.dataset.rule, title: t.dataset.title, rule: t.value } });
    toast(`Rule saved · ${r.applied} video${r.applied === 1 ? "" : "s"} from ${t.dataset.title} ${t.value === "approve" ? "approved" : "rejected"}`);
    adminRefresh();
  }
});

// search YouTube
let lastSearch = [];
async function runSearch(refreshOnly) {
  showErr("sErr");
  try {
    if (!refreshOnly) lastSearch = await api("/api/admin/search?q=" + encodeURIComponent($("sq").value));
    else { const all = await Promise.all(["pending", "approved", "rejected"].map(s => api("/api/admin/videos?status=" + s)));
      const byId = Object.fromEntries(all.flat().map(v => [v.id, v])); lastSearch = lastSearch.map(v => byId[v.id] || v); }
    $("sgrid").innerHTML = lastSearch.length ? lastSearch.map(v => vcard(v, false)).join("") : `<div class="empty">No results.</div>`;
  } catch (err) { showErr("sErr", err.message); }
}
$("sForm").addEventListener("submit", e => { e.preventDefault(); runSearch(); });

// rules
async function loadRules() {
  const rules = await api("/api/admin/rules");
  $("rlist").innerHTML = rules.length ? rules.map(r => `<li><b>${esc(r.title || r.channelId)}</b>
    <span class="pill">${r.rule === "approve" ? "Always approve" : "Always reject"}</span>
    <button class="btn ghost" data-unrule="${esc(r.channelId)}">Remove rule</button></li>`).join("") : `<li class="note">No rules yet.</li>`;
}

// bridge: desktop bookmark + phone install
(function () {
  const code = `(()=>{const o=${JSON.stringify(location.origin)};const ids=[...new Set([...document.querySelectorAll('a[href*="watch?v="],a[href*="/shorts/"]')].map(a=>(a.href.match(/(?:[?&]v=|\\/shorts\\/)([\\w-]{11})/)||[])[1]).filter(Boolean))].slice(0,100);const one=(location.href.match(/(?:[?&]v=|\\/shorts\\/)([\\w-]{11})/)||[])[1];if(one&&!ids.includes(one))ids.unshift(one);if(!ids.length){alert('No YouTube videos found on this page');return}window.open(o+'/share?ids='+ids.join(','),'_blank')})()`;
  $("bmk").href = "javascript:" + encodeURIComponent(code);
  $("bmk").onclick = e => { e.preventDefault(); toast("Drag this button to your bookmarks bar, then click it on youtube.com"); };
  let deferred = null;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferred = e; $("installBtn").hidden = false; $("installHint").hidden = true; });
  $("installBtn").onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $("installBtn").hidden = true; };
  if (matchMedia("(display-mode: standalone)").matches) $("instStep").innerHTML = "VidGate is installed on this phone. ✓";
})();

// channels
async function loadChannels() {
  const chs = await api("/api/admin/channels");
  $("chInfo").textContent = status?.lastFeedResult ? status.lastFeedResult + " · " + ago(status.lastFeedCheck) : "";
  $("chList").innerHTML = chs.length ? chs.map(c => `<li class="chrow">
      <div class="chmain"><a href="https://www.youtube.com/channel/${esc(c.id)}" target="_blank" rel="noopener"><b>${esc(c.title)}</b></a>
        <div class="note">${c.pending} waiting · ${c.approved} approved${c.rule ? " · always " + c.rule : ""}${c.error ? ` · <span class="errtxt">${esc(c.error)}</span>` : c.lastChecked ? "" : " · not checked yet"}</div></div>
      <input class="chcat" data-cat="${esc(c.id)}" value="${esc(c.category || "General")}" aria-label="Category for ${esc(c.title)}">
      <button class="btn ghost" data-unch="${esc(c.id)}" data-t="${esc(c.title)}">Remove</button></li>`).join("")
    : `<li class="note">No channels yet. Add one above, or bring in a whole subscriptions list.</li>`;
}
$("chForm").addEventListener("submit", async e => {
  e.preventDefault();
  showErr("chErr");
  $("chAdd").disabled = true; $("chAdd").textContent = "Adding…";
  try {
    const r = await api("/api/admin/channels", { method: "POST", body: { input: $("chIn").value, category: $("chCat").value || "General" } });
    $("chIn").value = "";
    toast(`${r.title} added · ${r.added} video${r.added === 1 ? "" : "s"} waiting for review`);
    adminRefresh(); loadChannels();
  } catch (err) { showErr("chErr", err.message); }
  $("chAdd").disabled = false; $("chAdd").textContent = "Add channel";
});
// Count watched videos per channel from Takeout watch history (HTML or JSON).
function rankWatchHistory(text) {
  const counts = new Map();
  const bump = (id, title) => { const c = counts.get(id) || { id, title, count: 0 }; c.count++; if (title && c.title === id) c.title = title; counts.set(id, c); };
  const t = text.trim();
  if (t.startsWith("[")) {
    for (const e of JSON.parse(t)) {
      if (e.details?.some(d => /Ads/i.test(d.name || ""))) continue;
      const sub = (e.subtitles || [])[0];
      const id = (String(sub?.url || "").match(/(UC[\w-]{22})/) || [])[1];
      if (id) bump(id, sub.name || id);
    }
  } else {
    // each watched item: <a href="...watch?v=...">Title</a><br><a href="https://www.youtube.com/channel/UC...">Channel</a>
    const div = document.createElement("textarea");
    const dec = s => { div.innerHTML = s; return div.value; };
    for (const block of t.split(/class="outer-cell/)) {
      if (/From Google Ads/i.test(block)) continue;
      const m = block.match(/youtube\.com\/channel\/(UC[\w-]{22})"[^>]*>([^<]*)</);
      if (m) bump(m[1], dec(m[2]).trim() || m[1]);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

let ranked = [], rankCategory = null;
const PACKS = {
  "Tamil News": ["Thanthi TV", "Polimer News", "Puthiya Thalaimurai TV", "Sun News Tamil", "News18 Tamil Nadu", "News7 Tamil", "Kalaignar Seithigal", "BBC News Tamil", "Sathiyam TV", "Jaya Plus"],
  "Tamil Comedy": ["Adithya TV", "Sirippoli TV", "Parithabangal", "Nakkalites", "Black Sheep Tamil", "Temple Monkeys", "Jump Cuts Hari Baskar", "Madras Central"],
  "TV Shows & Serials": ["Sun TV", "Vijay Television", "Zee Tamil", "Colors Tamil", "Kalaignar TV", "Raj Television", "Jaya TV", "Polimer TV"],
  "Sports": ["Star Sports Tamil", "Chennai Super Kings", "BCCI", "ICC", "Pro Kabaddi League", "Indian Super League", "Sony Sports Network", "Olympics"],
};
$("packs").onclick = async e => {
  const b = e.target.closest("[data-pack]"); if (!b) return;
  const cat = b.dataset.pack;
  document.querySelectorAll("#packs button").forEach(x => x.setAttribute("aria-pressed", x === b));
  showErr("impErr");
  rankCategory = cat; ranked = [];
  $("rank").hidden = false; $("rankList").innerHTML = ""; $("rankHead").textContent = `Finding ${cat} channels on YouTube…`;
  try {
    const found = await api("/api/admin/channels/find", { method: "POST", body: { names: PACKS[cat] } });
    const seen = new Set();
    ranked = found.filter(c => c.notFound || (!seen.has(c.id) && seen.add(c.id)))
      .map(c => c.notFound ? { notFound: true, title: c.name } : { id: c.id, title: c.title, sub: c.subscribers, searched: c.name, count: 0, already: c.already, pick: !c.already });
    renderRank();
    $("rankHead").textContent = `${cat}: ${ranked.filter(c => !c.notFound).length} channels found`;
  } catch (err) { $("rank").hidden = true; showErr("impErr", err.message); }
};
function renderRank() {
  const box = $("rank");
  box.hidden = !ranked.length;
  if (!ranked.length) return;
  $("rankHead").textContent = `${ranked.length} channels found`;
  $("rankList").innerHTML = ranked.slice(0, 200).map((c, i) => c.notFound ? `<li class="note">Not found on YouTube: ${esc(c.title)} — add it by link above</li>` : `<li><label class="chk" style="flex:1;min-width:0">
      <input type="checkbox" data-rk="${i}" ${c.pick ? "checked" : ""}>
      <span style="min-width:0;overflow-wrap:anywhere"><b>${esc(c.title)}</b>
      <span class="note">${c.sub ? " · " + esc(c.sub) : ""}${c.searched && c.searched.toLowerCase() !== c.title.toLowerCase() ? ` · searched "${esc(c.searched)}"` : ""}${c.count ? ` · ${c.count} video${c.count === 1 ? "" : "s"} watched` : ""}${c.subscribed ? " · subscribed" : ""}${c.already ? " · already added" : ""}</span></span></label></li>`).join("");
  const n = ranked.filter(c => c.pick && !c.notFound).length;
  $("rankCount").textContent = `${n} selected`;
  $("rankAll").checked = n && ranked.slice(0, 200).every(c => c.pick || c.already || c.notFound);
}
$("rankList").addEventListener("change", e => { const i = e.target.dataset.rk; if (i === undefined) return; ranked[i].pick = e.target.checked; renderRank(); });
$("rankAll").onchange = e => { ranked.slice(0, 200).forEach(c => { if (!c.already && !c.notFound) c.pick = e.target.checked; }); renderRank(); };
$("rankAdd").onclick = async () => {
  const pick = ranked.filter(c => c.pick && !c.already && !c.notFound);
  if (!pick.length) return toast("Select at least one channel");
  $("rankAdd").disabled = true;
  try {
    const r = await api("/api/admin/channels/import", { method: "POST", body: { channels: pick.map(c => ({ id: c.id, title: c.title })), category: rankCategory || $("chCat").value || "General" } });
    toast(`${r.added} channel${r.added === 1 ? "" : "s"} added · fetching their latest videos…`);
    pick.forEach(c => { c.pick = false; c.already = true; });
    renderRank(); adminRefresh(); loadChannels();
  } catch (err) { showErr("impErr", err.message); }
  $("rankAdd").disabled = false;
};

$("chFile").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  showErr("impErr");
  rankCategory = null; document.querySelectorAll("#packs button").forEach(x => x.setAttribute("aria-pressed", "false"));
  $("rankHead").textContent = "Reading file…"; $("rank").hidden = false; $("rankList").innerHTML = "";
  try {
    let historyText = null, csv = null;
    if (/\.zip$/i.test(f.name) || f.type.includes("zip")) {
      if (!window.JSZip) throw new Error("Could not open zip files here. Unzip it and choose the watch-history or subscriptions file instead.");
      const zip = await JSZip.loadAsync(f);
      const files = Object.values(zip.files).filter(z => !z.dir);
      const h = files.find(z => /watch-history\.(json|html)$/i.test(z.name));
      const s = files.find(z => /subscriptions[^/]*\.csv$/i.test(z.name));
      if (!h && !s) throw new Error("No watch history or subscriptions in that zip. In Takeout, make sure 'history' and 'subscriptions' are ticked under YouTube.");
      if (h) historyText = await h.async("string");
      if (s) csv = await s.async("string");
    } else if (/\.csv$/i.test(f.name)) csv = await f.text();
    else historyText = await f.text();

    const existing = new Set((await api("/api/admin/channels")).map(c => c.id));
    const map = new Map();
    if (historyText) for (const c of rankWatchHistory(historyText)) map.set(c.id, { ...c, subscribed: false });
    if (csv) for (const line of csv.split(/\r?\n/)) {
      const id = (line.match(/(UC[A-Za-z0-9_-]{22})/) || [])[1]; if (!id) continue;
      const title = line.split(",").slice(2).join(",").replace(/^"|"$/g, "").trim() || id;
      const c = map.get(id) || { id, title, count: 0 }; c.subscribed = true; map.set(id, c);
    }
    ranked = [...map.values()].sort((a, b) => b.count - a.count || (b.subscribed - a.subscribed) || a.title.localeCompare(b.title));
    if (!ranked.length) throw new Error("No channels found in that file.");
    // pre-select: channels watched 3+ times, plus subscriptions
    ranked.forEach(c => { c.already = existing.has(c.id); c.pick = !c.already && (c.count >= 3 || c.subscribed); });
    renderRank();
    e.target.value = "";
  } catch (err) { $("rank").hidden = true; showErr("impErr", err.message); }
});
$("chCheck").onclick = startCheck;
$("chList").addEventListener("change", async e => {
  const id = e.target.dataset.cat; if (!id) return;
  await api("/api/admin/channels/" + encodeURIComponent(id), { method: "PATCH", body: { category: e.target.value || "General" } });
  toast("Category saved");
});
$("chList").addEventListener("click", async e => {
  const b = e.target.closest("[data-unch]"); if (!b) return;
  if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Tap again to remove"; setTimeout(() => { b.dataset.sure = ""; b.textContent = "Remove"; }, 3000); return; }
  await api("/api/admin/channels/" + encodeURIComponent(b.dataset.unch), { method: "DELETE" });
  toast(`${b.dataset.t} removed. Its approved videos stay; waiting ones were cleared.`);
  adminRefresh(); loadChannels();
});

// users
async function loadUsers() {
  const users = await api("/api/admin/users");
  $("ulist").innerHTML = users.map(u => `<li><b>${esc(u.username)}</b><span class="pill">${u.role === "admin" ? "Administrator" : "User"}</span></li>`).join("");
}
$("userForm").addEventListener("submit", async e => {
  e.preventDefault();
  try { await api("/api/admin/users", { method: "POST", body: { username: $("nu").value, password: $("np").value, role: $("nr").value } });
    $("nu").value = ""; $("np").value = ""; showErr("userErr"); toast("Account created"); loadUsers(); }
  catch (err) { showErr("userErr", err.message); }
});

// ================= USER =================
let videos = [], cat = "All", q = "", playing = null;
async function loadUser() { videos = await api("/api/videos"); renderUser(); }
function renderUser() {
  const cats = ["All", ...new Set(videos.map(v => v.category))];
  if (!cats.includes(cat)) cat = "All";
  $("chips").innerHTML = cats.map(c => `<button data-c="${esc(c)}" aria-pressed="${c === cat}">${esc(c)}</button>`).join("");
  const l = videos.filter(v => (cat === "All" || v.category === cat) && (v.title + " " + v.channel).toLowerCase().includes(q.toLowerCase()));
  $("grid").innerHTML = l.length ? l.map(v => `<button class="card" data-p="${v.id}"><div class="th">${img(v)}${v.duration ? `<span class="dur">${esc(v.duration)}</span>` : ""}</div>
      <div class="t">${esc(v.title)}</div><div class="c">${esc(v.channel)}</div></button>`).join("")
    : `<div class="empty">No videos yet. Your administrator decides which videos appear here.</div>`;
  const pv = videos.find(v => v.id === playing);
  if (!pv) { playing = null; $("playerArea").innerHTML = ""; return; }
  $("playerArea").innerHTML = `<button class="link" id="back">← Back to all videos</button>
    <div class="player"><div>
      <iframe src="https://www.youtube-nocookie.com/embed/${pv.id}?rel=0&modestbranding=1" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>
      <h2 style="margin-top:12px">${esc(pv.title)}</h2><div class="note">${esc(pv.channel)} · ${esc(pv.category)}</div></div>
      <div class="side"><div class="note" style="margin-bottom:8px">Up next</div>${videos.filter(v => v.id !== pv.id).slice(0, 6).map(v => `<button class="row" data-p="${v.id}"><div class="th">${img(v)}</div>
        <div><div style="font-weight:600;font-size:.88rem">${esc(v.title)}</div><div class="note">${esc(v.channel)}</div></div></button>`).join("")}</div></div>`;
  $("back").onclick = () => { playing = null; renderUser(); };
}
$("user").addEventListener("click", e => {
  const p = e.target.closest("[data-p]"); if (p) { playing = p.dataset.p; renderUser(); scrollTo({ top: 0, behavior: "smooth" }); }
  const c = e.target.closest("[data-c]"); if (c) { cat = c.dataset.c; renderUser(); }
});
$("q").addEventListener("input", e => { q = e.target.value; renderUser(); });
// a video the admin rejects disappears from users within 30 seconds
setInterval(() => { if (me?.role === "user") loadUser(); }, 30000);

boot();
