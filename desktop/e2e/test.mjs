// Drives the Linkotter interface in a headless browser. Started by run.sh.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

// require() rather than import so a globally installed Playwright (NODE_PATH) is found.
const { chromium } = createRequire(import.meta.url)("playwright");

const { UI, CONTROL, USER_KEY, WORK, SHOTS, PHONE_SEND, PHONE_GET } = process.env;
const step = (m) => console.log("ok  " + m);
const sh = (cmd) => execSync(cmd, { cwd: WORK, stdio: "pipe", encoding: "utf8" });

const browser = await chromium.launch();
const errors = [];
async function open(opts) {
  const ctx = await browser.newContext(opts);
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(UI);
  return page;
}
const page = await open({ viewport: { width: 460, height: 860 } });
const shot = (name, p = page) => p.screenshot({ path: path.join(SHOTS, name + ".png") });
const otter = page.locator("#stage .otter");
const mood = (m, timeout = 8000) => page.locator(`#stage .otter[data-mood="${m}"]`).waitFor({ state: "attached", timeout });
const said = (text, timeout = 8000) => page.waitForFunction((t) => [...document.querySelectorAll("#stage .bubble text")].some((e) => e.textContent === t), text, { timeout });
// Web nodes are clicked with a real pointer at their centre, as a person would.
async function tap(name) {
  const b = await node(name).locator(".body").boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}
const node = (name) => page.locator(".web-svg .node").filter({ has: page.locator(`text.name`, { hasText: new RegExp(`^${name}$`) }) });

// ---- Sign in ----------------------------------------------------------------------------
await page.getByRole("heading", { name: "Reach every device, from anywhere." }).waitFor();
assert.equal(await page.getByLabel("Server address").inputValue(), CONTROL);
assert.equal(await page.locator(".backdrop .otter").count(), 1, "the otter greets on the sign-in screen");
await page.waitForTimeout(1200);
await shot("1-sign-in");
await page.getByLabel("Server address").fill("not a url");
await page.getByRole("button", { name: "Connect" }).click();
await page.getByRole("alert").waitFor();
await page.locator('.backdrop .otter[data-mood="sad"]').waitFor({ state: "attached" });
step("bad server address is rejected with a message, and the otter looks sad: " + (await page.getByRole("alert").textContent()));
errors.length = 0; // the rejected request above is logged by the browser; that one is expected
await page.getByLabel("Server address").fill(CONTROL);
await page.getByRole("button", { name: "I have an access key" }).click();
await page.getByLabel("Access key").fill(USER_KEY);
await page.getByRole("button", { name: "Connect" }).click();

// ---- Network web ------------------------------------------------------------------------
await page.getByText("Connected", { exact: true }).waitFor({ timeout: 20000 });
await said("Welcome aboard!");
step("signed in; the otter welcomes you");
await node("phone").waitFor();
await node("nas-india").waitFor();
await page.waitForFunction(() => document.querySelectorAll(".web-svg .edge").length >= 2);
step("devices appear as nodes on the web, joined to this device by threads");

await page.getByText("All devices").click();
assert.equal(await page.getByText("My devices").count(), 1);
assert.equal(await page.getByText("Shared", { exact: true }).count(), 1);
step("the device list groups own devices and the shared NAS");

// Device sheet and connection test, with the otter listening then answering.
await tap("phone");
const sheet = page.getByRole("dialog");
await sheet.getByRole("heading", { name: "phone" }).waitFor();
await sheet.getByRole("button", { name: "Test Connection" }).click();
await page.locator("#toast.show").waitFor();
const pingMsg = await page.locator("#toast").textContent();
assert.match(pingMsg, /ms$/);
await mood("happy");
step("tapping a device opens its details; connection test: " + pingMsg + " (otter tilts its head, then cheers)");
await page.waitForTimeout(500);
await shot("2-device-sheet");
await page.keyboard.press("Escape");
await page.locator(".dev", { hasText: "phone" }).locator(".chip--direct").waitFor();
await page.waitForTimeout(1600);
await shot("3-network");

// Copy makes the otter wink.
await tap("phone");
await sheet.getByRole("button", { name: "Copy address" }).click();
await mood("wink", 3000);
await page.keyboard.press("Escape");
step("copying an address makes the otter wink");

// ---- Drop: send from the picker --------------------------------------------------------
await tap("phone");
await sheet.getByRole("button", { name: "Send Files" }).click();
await page.getByRole("heading", { name: "Send files across your web" }).waitFor();
assert.equal(await page.getByRole("button", { name: "nas-india", exact: true }).count(), 0, "tagged devices cannot receive Drop yet");
const big = path.join(WORK, "render.bin");
fs.writeFileSync(big, Buffer.alloc(8 * 1024 * 1024, 7));
fs.writeFileSync(path.join(WORK, "notes.txt"), "hello from laptop\n");
await page.locator("#files").setInputFiles([big, path.join(WORK, "notes.txt")]);
// exact text: the live rows say "Sent to phone"; history rows add size and time
await page.getByText("Sent to phone", { exact: true }).nth(1).waitFor({ timeout: 60000 });
await said("Delivered!");
step("Drop send from the picker: two files streamed along the thread; the otter cheers \"Delivered!\"");

// ---- Drop: drag a file onto a node in the web -----------------------------------------
const dt = await page.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File(["dragged onto the web\n"], "dragged.txt", { type: "text/plain" })); return d; });
const box = await node("phone").locator(".body").boundingBox();
const at = { dataTransfer: dt, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, bubbles: true };
await page.locator(".web-svg").dispatchEvent("dragover", at);
await mood("excited", 3000);
assert.ok(await node("phone").evaluate((n) => n.classList.contains("drop-hover")), "the node under the pointer lights up");
await page.locator(".web-svg").dispatchEvent("drop", at);
await page.getByText("Sent to phone", { exact: true }).nth(2).waitFor({ timeout: 60000 });
fs.mkdirSync(path.join(WORK, "phone-inbox"), { recursive: true });
sh(`${PHONE_GET} ${path.join(WORK, "phone-inbox")}`);
assert.equal(fs.readFileSync(path.join(WORK, "phone-inbox", "notes.txt"), "utf8"), "hello from laptop\n");
assert.equal(fs.statSync(path.join(WORK, "phone-inbox", "render.bin")).size, 8 * 1024 * 1024);
assert.equal(fs.readFileSync(path.join(WORK, "phone-inbox", "dragged.txt"), "utf8"), "dragged onto the web\n");
step("Drop by dragging a file onto the phone's node; all three files arrived intact");

// Frozen frame of a transfer in flight, for the design review.
const phoneId = await node("phone").getAttribute("data-node");
await page.waitForTimeout(2500); // let the delivery celebration finish first
await page.evaluate((id) => window.__lkweb.setTransfers({ out: [{ id: "shot", peer: id, name: "render.bin", size: 100, done: 55 }], in: [] }), phoneId);
await page.waitForTimeout(450);
await shot("4-sending");
await page.evaluate((id) => window.__lkweb.setTransfers({ out: [{ id: "shot", peer: id, name: "render.bin", size: 100, done: 100, end: "ok" }], in: [] }), phoneId);

// ---- Drop: receive -------------------------------------------------------------------------
const me = (await page.evaluate(() => fetch("/api/state", { headers: { "X-Linkotter-Token": "e2e" } }).then((r) => r.json()))).self.name;
fs.writeFileSync(path.join(WORK, "photo.jpg"), "first");
sh(`${PHONE_SEND} ${path.join(WORK, "photo.jpg")} ${me}:`);
const inbox = path.join(WORK, "home", "Downloads", "Linkotter");
await page.getByText("photo.jpg", { exact: true }).waitFor({ timeout: 20000 });
fs.writeFileSync(path.join(WORK, "photo.jpg"), "second");
sh(`${PHONE_SEND} ${path.join(WORK, "photo.jpg")} ${me}:`);
await page.getByText("photo (2).jpg", { exact: true }).waitFor({ timeout: 20000 });
assert.equal(fs.readFileSync(path.join(inbox, "photo.jpg"), "utf8"), "first");
assert.equal(fs.readFileSync(path.join(inbox, "photo (2).jpg"), "utf8"), "second");
step("Drop receive: files saved automatically; a second file with the same name did not overwrite the first");
await page.waitForTimeout(800);
await shot("5-drop");

// ---- Settings ------------------------------------------------------------------------------
await page.getByRole("button", { name: "Settings" }).click();
const routes = page.locator('[data-key="acceptRoutes"]'), dns = page.locator('[data-key="useDns"]');
assert.equal(await routes.isChecked(), false, "office networks off by default");
assert.equal(await dns.isChecked(), true);
assert.equal(await page.getByLabel("Send all internet traffic through").inputValue(), "", "no traffic rerouted by default");
await routes.check();
await page.waitForFunction(() => document.querySelector('[data-key="acceptRoutes"]').checked);
await page.reload();
await page.getByRole("button", { name: "Settings" }).click();
assert.equal(await page.locator('[data-key="acceptRoutes"]').isChecked(), true, "setting survives reload");
step("settings: safe defaults (no rerouted traffic), and a changed setting persists");
await shot("6-settings");

// ---- Pause / resume: the otter naps and wakes ------------------------------------------------
await page.getByRole("button", { name: "Network" }).click();
await page.getByRole("switch", { name: "Connection" }).uncheck();
await page.locator("#lead").getByText("Paused", { exact: true }).waitFor();
await mood("sleep");
await page.waitForTimeout(900);
await shot("7-paused");
await page.getByRole("switch", { name: "Connection" }).check();
await page.getByText("Connected", { exact: true }).waitFor({ timeout: 20000 });
await said("All linked!");
step("pause puts the otter to sleep; resuming wakes it with \"All linked!\"");

// ---- A device joins: the otter says hello ---------------------------------------------------
sh(`${PHONE_SEND.replace(" file cp", "")} down`);
await said("Bye, phone", 30000);
sh(`${PHONE_SEND.replace(" file cp", "")} up`);
await said("Hi, phone!", 30000);
step("the otter notices devices leaving and joining");

// Dark theme and a wide window
const dark = await open({ viewport: { width: 1100, height: 820 }, colorScheme: "dark" });
await dark.getByText("Connected", { exact: true }).waitFor();
await dark.waitForTimeout(1500);
await shot("8-dark-wide", dark);

// API is closed without the token
const origin = new URL(UI).origin;
assert.equal((await fetch(origin + "/api/state")).status, 403);
assert.equal((await fetch(origin + "/api/state", { headers: { "X-Linkotter-Token": "wrong" } })).status, 403);
step("API refuses requests without the token");

// Sign out
await page.getByRole("button", { name: "Settings" }).click();
await page.getByRole("button", { name: "Sign Out" }).click();
await page.getByRole("heading", { name: "Reach every device, from anywhere." }).waitFor({ timeout: 15000 });
step("sign out returns to the sign-in screen");

await browser.close();
assert.deepEqual(errors, [], "no browser errors");
console.log("ALL PASSED");
