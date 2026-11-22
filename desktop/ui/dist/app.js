"use strict";
// Linkotter desktop interface. Plain DOM, no framework: one state object, one render().

const token = new URLSearchParams(location.hash.slice(1)).get("t") || sessionStorage.getItem("t") || "";
try { sessionStorage.setItem("t", token); } catch (_) {}

const ui = {
  state: null, tab: "devices", query: "", busy: false, error: "",
  showKey: false, form: { server: "", authKey: "" },
  history: [], sending: [], target: "", unseen: 0,
};

const $app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Linkotter-Token": token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

const icons = {
  devices: '<rect x="3" y="4" width="13" height="10" rx="2"/><path d="M2 18h15"/><rect x="17" y="8" width="5" height="12" rx="1.5"/>',
  drop: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  send: '<path d="M21 3 10 14"/><path d="m21 3-7 18-4-7-7-4z"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  up: '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
  down: '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
};
const icon = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${icons[n]}</svg>`;
const osIcon = (d) => d.shared ? "server" : /android|ios/i.test(d.os) ? "phone" : /linux/i.test(d.os) && !d.mine ? "server" : "laptop";

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
}
function size(n) {
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB", "TB"]; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + " " + u[i];
}
function pathChip(d) {
  if (!d.online) return `<span class="chip chip--idle">Offline</span>`;
  const p = d.path, ms = p.latencyMs != null ? " · " + (p.latencyMs < 10 ? p.latencyMs.toFixed(1) : Math.round(p.latencyMs)) + " ms" : "";
  if (p.kind === "direct") return `<span class="chip chip--direct" title="Traffic goes straight between the two devices">Direct${ms}</span>`;
  if (p.kind === "peer-relay") return `<span class="chip chip--direct" title="Traffic goes through one of your own office relays">Office relay${ms}</span>`;
  if (p.kind === "relay") return `<span class="chip chip--relay" title="No direct route yet; traffic goes through the ${esc(p.via)} relay">Relay${p.via ? " · " + esc(p.via) : ""}${ms}</span>`;
  return `<span class="chip chip--idle" title="Online. A route is set up the moment you use it">Ready</span>`;
}

// ---- views ----------------------------------------------------------------------------

function viewSignIn(s) {
  const waiting = !!s.authUrl;
  if (waiting) return `
    <div class="center">
      <div><span class="eyebrow">Almost there</span><h1>Finish signing in</h1>
      <p>Open the sign-in page to add this device to your network.</p></div>
      <div class="stack">
        <button class="btn btn--primary btn--block" data-act="open-auth">Open Sign-In Page</button>
        <button class="btn btn--secondary btn--block" data-act="copy" data-text="${esc(s.authUrl)}">Copy Link</button>
        <button class="btn btn--sm" data-act="logout">Start over</button>
      </div>
    </div>`;
  return `
    <div class="center">
      <div><span class="eyebrow">Private network</span><h1>Reach every device, from anywhere.</h1>
      <p>Sign in once and this computer joins your Linkotter network.</p></div>
      <form class="card stack" id="login">
        <label class="field">Server address
          <input type="text" name="server" value="${esc(ui.form.server || s.server)}" placeholder="link.example.com" autocomplete="off" spellcheck="false" required>
        </label>
        ${ui.showKey ? `<label class="field">Access key
          <input type="password" name="authKey" value="${esc(ui.form.authKey)}" autocomplete="off" spellcheck="false">
          <span class="hint">Your admin can create one. Leave blank to sign in through the browser.</span></label>` : ""}
        ${ui.error ? `<div class="error" role="alert">${esc(ui.error)}</div>` : ""}
        <button class="btn btn--primary btn--block" ${ui.busy ? "disabled" : ""}>${ui.busy ? "Connecting…" : "Connect"}</button>
        ${ui.showKey ? "" : `<button type="button" class="btn btn--sm" data-act="show-key">I have an access key</button>`}
      </form>
    </div>`;
}

function viewDevices(s) {
  const on = s.state === "Running" || s.state === "Starting";
  const q = ui.query.trim().toLowerCase();
  const match = (d) => !q || d.name.toLowerCase().includes(q) || d.ip.includes(q);
  const groups = [["My devices", s.devices.filter((d) => d.mine && match(d))], ["Shared", s.devices.filter((d) => d.shared && match(d))], ["Team", s.devices.filter((d) => !d.mine && !d.shared && match(d))]];
  const online = s.devices.filter((d) => d.online).length;
  const row = (d) => `
    <div class="dev ${d.online ? "on" : "off"}">
      <div class="os">${icon(osIcon(d))}<span class="dot"></span></div>
      <div class="grow"><div class="nm">${esc(d.name)}</div>
        <div class="meta"><span>${esc(d.ip)}</span>${pathChip(d)}${!d.online && d.lastSeen ? `<span>seen ${ago(d.lastSeen)}</span>` : ""}</div></div>
      ${d.online ? `<button class="icon-btn" title="Test connection" aria-label="Test connection to ${esc(d.name)}" data-act="ping" data-id="${esc(d.id)}" data-ip="${esc(d.ip)}">${icon("pulse")}</button>` : ""}
      ${d.canDrop && d.online ? `<button class="icon-btn" title="Send files" aria-label="Send files to ${esc(d.name)}" data-act="send-to" data-id="${esc(d.id)}">${icon("send")}</button>` : ""}
      <button class="icon-btn" title="Copy address" aria-label="Copy address of ${esc(d.name)}" data-act="copy" data-text="${esc(d.ip)}">${icon("copy")}</button>
    </div>`;
  return `
    <div class="tile ${on ? "" : "off"}">
      <div class="row"><div class="grow"><div class="tag">${s.state === "Starting" ? "Connecting" : on ? "Connected" : "Paused"}</div>
        <div class="big">${esc(s.self ? s.self.name : "This device")}</div></div>
        <input type="checkbox" class="switch" role="switch" aria-label="Connection" data-act="toggle" ${on ? "checked" : ""}></div>
      <div class="sub">${on && s.self ? `<span>${esc(s.self.ip)}</span><button class="icon-btn" title="Copy address" aria-label="Copy this device's address" data-act="copy" data-text="${esc(s.self.ip)}">${icon("copy")}</button><span>·</span><span>${online} of ${s.devices.length} devices online</span>` : "Turn on to reach your devices. Your other internet traffic is not affected."}</div>
    </div>
    ${(s.health || []).map((h) => `<div class="card error" role="alert">${esc(h.replace(/Tailscale/g, "Linkotter"))}</div>`).join("")}
    ${on ? `
      ${s.devices.length > 5 || q ? `<input type="search" id="q" placeholder="Search devices" value="${esc(ui.query)}" aria-label="Search devices">` : ""}
      ${s.devices.length === 0 ? `<div class="card empty"><h2>No other devices yet</h2><p>Install Linkotter on your phone or another computer and sign in to the same server.</p></div>` : ""}
      ${groups.map(([t, ds]) => ds.length ? `<div class="section-title">${t}</div><div class="list">${ds.map(row).join("")}</div>` : "").join("")}
      ${q && !groups.some(([, ds]) => ds.length) ? `<div class="card empty"><p>No device matches “${esc(ui.query)}”.</p></div>` : ""}` : ""}`;
}

function viewDrop(s) {
  const targets = s.devices.filter((d) => d.canDrop);
  const running = s.state === "Running";
  return `
    <div><span class="eyebrow">Drop</span><h1>Send files to your devices</h1></div>
    ${!running ? `<div class="card empty"><p>Connect first to send and receive files.</p></div>` : targets.length === 0 ? `<div class="card empty"><h2>No device to send to yet</h2><p>Sign in on another of your devices and it appears here.</p></div>` : `
    <div class="card stack">
      <div class="hint">Send to</div>
      <div class="targets">${targets.map((d) => `<button class="target" data-act="target" data-id="${esc(d.id)}" aria-pressed="${ui.target === d.id}" ${d.online ? "" : "disabled title=\"Offline\""}>${esc(d.name)}</button>`).join("")}</div>
      <div class="dropzone" id="zone">
        <p><b>Drag files here</b></p><p class="hint" style="margin:4px 0 12px">or</p>
        <button class="btn btn--secondary" data-act="choose" ${ui.target ? "" : "disabled"}>Choose Files</button>
        <input type="file" id="files" multiple hidden>
        ${ui.target ? "" : `<p class="hint" style="margin-top:10px">Pick a device first.</p>`}
      </div>
    </div>`}
    ${ui.sending.length ? `<div class="list">${ui.sending.map((x) => `
      <div class="xfer ${x.error ? "fail" : ""}"><div class="dir">${icon("up")}</div><div class="grow"><div class="nm">${esc(x.name)}</div>
      <div class="hint">${x.error ? esc(x.error) : x.done ? "Sent to " + esc(x.peer) : `Sending to ${esc(x.peer)} · ${Math.round(x.pct)}%`}</div>
      ${x.done || x.error ? "" : `<div class="bar"><i style="width:${x.pct}%"></i></div>`}</div></div>`).join("")}</div>` : ""}
    <div class="row"><div class="section-title grow">History</div>
      <button class="btn btn--sm btn--secondary" data-act="reveal" data-path="${esc(s.downloadDir)}">${icon("folder")} Open Folder</button></div>
    ${ui.history.length === 0 ? `<div class="card empty"><p>Files you send and receive are listed here. Received files are saved to ${esc(s.downloadDir)}.</p></div>` : `
    <div class="list">${ui.history.map((t) => `
      <div class="xfer ${t.failed ? "fail" : ""}"><div class="dir">${icon(t.dir === "in" ? "down" : "up")}</div>
        <div class="grow"><div class="nm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</div>
        <div class="hint">${t.failed ? esc(t.failed) : `${t.dir === "in" ? "Received" : "Sent" + (t.peer ? " to " + esc(t.peer) : "")} · ${size(t.size)} · ${ago(t.time)}`}</div></div>
        ${t.path ? `<button class="icon-btn" title="Show in folder" aria-label="Show ${esc(t.name)} in folder" data-act="reveal" data-path="${esc(t.path)}">${icon("folder")}</button>` : ""}
      </div>`).join("")}</div>`}`;
}

function viewSettings(s) {
  const toggle = (key, on, title, sub) => `<label class="setting"><span class="grow"><b>${title}</b><small>${sub}</small></span>
    <input type="checkbox" class="switch" role="switch" data-act="pref" data-key="${key}" ${on ? "checked" : ""}></label>`;
  const exits = s.devices.filter((d) => d.exitOption);
  return `
    <div><span class="eyebrow">Settings</span><h1>This device</h1></div>
    <div class="list settings">
      ${s.autostart != null ? toggle("autostart", s.autostart, "Start when I sign in to this computer", "Linkotter opens quietly in the tray.") : ""}
      ${toggle("background", s.background, "Stay connected in the background", "Keeps this device reachable when the window is closed.")}
      ${toggle("useDns", s.useDns, "Use device names", "Reach devices by name. Other websites and apps keep using your normal DNS.")}
      ${toggle("acceptRoutes", s.acceptRoutes, "Reach office networks", "Use office LANs shared by a Linkotter device. Off by default.")}
      <label class="setting"><span class="grow"><b>Send all internet traffic through</b><small>Off by default, so your normal connection is untouched.</small></span>
        <select data-act="exit" style="max-width:170px" aria-label="Send all internet traffic through">
          <option value="">Nothing (normal)</option>
          ${exits.map((d) => `<option value="${esc(d.id)}" ${s.exitNode === d.id ? "selected" : ""}>${esc(d.name)}</option>`).join("")}
        </select></label>
    </div>
    <div class="section-title">Account</div>
    <div class="list">
      <div class="setting"><span class="grow"><b>${esc(s.user || "Signed in")}</b><small>${esc(s.server)}</small></span>
        <button class="btn btn--sm btn--danger" data-act="logout">Sign Out</button></div>
    </div>
    <p class="hint" style="text-align:center">Linkotter ${esc(s.version)}${s.engineVersion ? " · engine " + esc(s.engineVersion.split("-")[0]) : ""}</p>`;
}

function render() {
  const s = ui.state;
  // Keep focus and caret where the person is typing across re-renders.
  const act = document.activeElement, keep = act && (act.id || act.name) ? { sel: act.id ? "#" + act.id : `[name=${act.name}]`, pos: act.selectionStart } : null;
  let body, tabs = false;
  if (!s) body = `<div class="center"><p>Starting…</p></div>`;
  else if (!s.engineOk) body = `<div class="center"><div><span class="eyebrow">Not running</span><h1>Linkotter service is stopped</h1><p>${esc(s.engineError)} Restart the computer, or reinstall Linkotter if this keeps happening.</p></div><button class="btn btn--primary" data-act="refresh">Try Again</button></div>`;
  else if (s.state === "NeedsMachineAuth") body = `<div class="center"><div><span class="eyebrow">One more step</span><h1>Waiting for approval</h1><p>An admin needs to approve this device. This page updates by itself.</p></div><button class="btn btn--secondary" data-act="logout">Sign Out</button></div>`;
  else if (s.state === "NeedsLogin" || s.state === "NoState" || (s.authUrl && s.state !== "Running")) body = viewSignIn(s);
  else { tabs = true; body = ui.tab === "drop" ? viewDrop(s) : ui.tab === "settings" ? viewSettings(s) : viewDevices(s); }
  const tab = (id, label) => `<button data-act="tab" data-tab="${id}" ${ui.tab === id ? 'aria-current="page"' : ""}>${icon(id)}<span>${label}${id === "drop" && ui.unseen ? `<span class="badge">${ui.unseen}</span>` : ""}</span></button>`;
  $app.innerHTML = `<div class="shell">
    <header class="top"><img src="mark.svg" alt=""><span class="name">Linkotter</span>${s && s.network && tabs ? `<span class="net" title="${esc(s.network)}">${esc(s.network)}</span>` : ""}</header>
    <main>${body}</main></div>
    ${tabs ? `<nav class="tabs" aria-label="Sections"><div>${tab("devices", "Devices")}${tab("drop", "Drop")}${tab("settings", "Settings")}</div></nav>` : ""}`;
  if (keep) { const el = $app.querySelector(keep.sel); if (el) { el.focus(); try { el.setSelectionRange(keep.pos, keep.pos); } catch (_) {} } }
}

// ---- data -------------------------------------------------------------------------------

let refreshing = false, again = false;
async function refresh() {
  if (refreshing) { again = true; return; }
  refreshing = true;
  try { ui.state = await api("/api/state"); }
  catch (e) { ui.state = { engineOk: false, engineError: e.message, devices: [], state: "NoState", version: "" }; }
  if (ui.target && !ui.state.devices.some((d) => d.id === ui.target && d.canDrop)) ui.target = "";
  refreshing = false; render();
  if (again) { again = false; refresh(); }
}
async function loadHistory() { try { ui.history = await api("/api/drop/history"); render(); } catch (_) {} }

function listen() {
  const es = new EventSource("/api/events?t=" + encodeURIComponent(token));
  es.onmessage = (e) => {
    if (e.data === "drop") { if (ui.tab !== "drop") ui.unseen++; loadHistory(); }
    refresh();
  };
}

function sendFiles(files) {
  const s = ui.state, peer = s.devices.find((d) => d.id === ui.target);
  if (!peer) { toast("Pick a device first"); return; }
  for (const f of files) {
    const x = { name: f.name, peer: peer.name, pct: 0 };
    ui.sending.unshift(x);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/drop/send?to=${encodeURIComponent(peer.id)}&name=${encodeURIComponent(f.name)}&peer=${encodeURIComponent(peer.name)}`);
    xhr.setRequestHeader("X-Linkotter-Token", token);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { x.pct = (e.loaded / e.total) * 100; render(); } };
    xhr.onload = () => {
      if (xhr.status === 200) x.done = true;
      else { try { x.error = JSON.parse(xhr.responseText).error; } catch (_) { x.error = "Could not send."; } }
      render();
    };
    xhr.onerror = () => { x.error = "Could not send."; render(); };
    xhr.send(f);
  }
  render();
}

async function act(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); } catch (e) { toast(e.message); }
  refresh();
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]"); if (!el || el.tagName === "SELECT" || el.type === "checkbox") return;
  const a = el.dataset.act;
  if (a === "tab") { ui.tab = el.dataset.tab; if (ui.tab === "drop") { ui.unseen = 0; loadHistory(); } render(); }
  else if (a === "copy") navigator.clipboard.writeText(el.dataset.text).then(() => toast("Copied"), () => toast(el.dataset.text));
  else if (a === "show-key") { ui.showKey = true; render(); }
  else if (a === "refresh") refresh();
  else if (a === "logout") act(() => api("/api/logout", {}));
  else if (a === "open-auth") act(() => api("/api/open-auth", {}));
  else if (a === "target") { ui.target = el.dataset.id; render(); }
  else if (a === "send-to") { ui.target = el.dataset.id; ui.tab = "drop"; loadHistory(); render(); }
  else if (a === "choose") document.getElementById("files").click();
  else if (a === "reveal") act(() => api("/api/drop/reveal", { path: el.dataset.path }));
  else if (a === "ping") { el.disabled = true; act(async () => { const p = await api("/api/ping", { id: el.dataset.id, ip: el.dataset.ip }); toast(`${p.kind === "direct" ? "Direct" : p.kind === "peer-relay" ? "Office relay" : "Relay " + (p.via || "")} · ${p.latencyMs < 10 ? p.latencyMs.toFixed(1) : Math.round(p.latencyMs)} ms`); }); }
});
document.addEventListener("change", (e) => {
  const el = e.target, a = el.dataset.act;
  if (a === "toggle") act(() => api(el.checked ? "/api/connect" : "/api/disconnect", {}));
  else if (a === "pref") act(() => api("/api/prefs", { [el.dataset.key]: el.checked }));
  else if (a === "exit") act(() => api("/api/prefs", { exitNode: el.value }), el.value ? "All traffic now goes through that device" : "Back to your normal connection");
  else if (el.id === "files") { sendFiles([...el.files]); el.value = ""; }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "q") { ui.query = e.target.value; render(); }
  else if (e.target.name === "server") ui.form.server = e.target.value;
  else if (e.target.name === "authKey") ui.form.authKey = e.target.value;
});
document.addEventListener("submit", async (e) => {
  if (e.target.id !== "login") return;
  e.preventDefault();
  const f = new FormData(e.target);
  ui.busy = true; ui.error = ""; render();
  try { await api("/api/login", { server: f.get("server"), authKey: f.get("authKey") || "" }); ui.form.authKey = ""; }
  catch (err) { ui.error = err.message; }
  ui.busy = false; refresh();
});
for (const ev of ["dragover", "dragleave", "drop"]) document.addEventListener(ev, (e) => {
  const zone = e.target.closest && e.target.closest("#zone");
  if (ev !== "dragleave") e.preventDefault(); // never let a dropped file navigate the window away
  if (!zone) return;
  zone.classList.toggle("over", ev === "dragover");
  if (ev === "drop" && e.dataTransfer.files.length) sendFiles([...e.dataTransfer.files]);
});

refresh(); loadHistory(); listen();
setInterval(refresh, 5000);
