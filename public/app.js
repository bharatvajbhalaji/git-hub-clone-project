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
let tab = "pending", list = [], sel = new Set(), limit = 60, status = null, pollT = null;

async function adminRefresh() {
  status = await api("/api/admin/status");
  renderConn();
  $("nPending").textContent = status.counts.pending;
  $("nApproved").textContent = status.counts.approved;
  $("nRejected").textContent = status.counts.rejected;
  fillSelect("fsource", "All sources", status.sources);
  fillSelect("fcat", "All categories", status.categories);
  if (["pending", "approved", "rejected"].includes(tab)) await loadList();
  clearTimeout(pollT);
  if (status.syncing) pollT = setTimeout(adminRefresh, 4000);
}
function fillSelect(id, label, items) {
  const cur = $(id).value;
  $(id).innerHTML = `<option value="">${label}</option>` + items.map(s => `<option ${s === cur ? "selected" : ""}>${esc(s)}</option>`).join("");
}
function renderConn() {
  const s = status;
  let html;
  if (s.account) {
    html = `<div><span class="note">Connected YouTube account</span><div class="acct">${esc(s.account)}</div>
      <span class="note">${s.syncing ? "Syncing now…" : "Last sync " + ago(s.lastSync)}</span></div>
      <div class="actions"><button class="btn" id="cSync" ${s.syncing ? "disabled" : ""}>Sync now</button><button class="btn ghost" id="cDisc">Disconnect</button></div>`;
  } else if (s.googleConfigured) {
    html = `<div><span class="note">No YouTube account connected</span><div class="acct">Connect the Gmail account whose YouTube videos you want to review</div></div>
      <div class="actions"><a class="btn" href="/auth/google">Connect YouTube account</a><button class="btn ghost" id="cDemo">Load demo videos</button></div>`;
  } else {
    html = `<div><span class="note">Google sign-in is not set up yet</span><div class="acct">Fill in config.json (see README) to connect a YouTube account</div></div>
      <div class="actions"><button class="btn ghost" id="cDemo">Load demo videos</button></div>`;
  }
  if (s.lastSyncResult) html += `<details><summary>Last sync details</summary>${s.lastSyncResult.map(esc).join("<br>")}</details>`;
  $("conn").innerHTML = html;
  $("cSync") && ($("cSync").onclick = async () => { try { await api("/api/admin/sync", { method: "POST" }); toast("Sync started"); adminRefresh(); } catch (e) { toast(e.message); } });
  $("cDisc") && ($("cDisc").onclick = async () => { await api("/api/admin/disconnect", { method: "POST" }); toast("Disconnected"); adminRefresh(); });
  $("cDemo") && ($("cDemo").onclick = async () => { await api("/api/admin/demo", { method: "POST" }); toast("Demo videos loaded into the review list"); adminRefresh(); });
}

$("tabs").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  tab = b.dataset.tab; sel.clear(); limit = 60;
  document.querySelectorAll("#tabs button").forEach(x => x.setAttribute("aria-pressed", x === b));
  $("pane-list").hidden = !["pending", "approved", "rejected"].includes(tab);
  $("pane-search").hidden = tab !== "search";
  $("pane-rules").hidden = tab !== "rules";
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
