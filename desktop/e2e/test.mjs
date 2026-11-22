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

const browser = await chromium.launch();
const errors = [];
async function open(opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(UI);
  return page;
}
const page = await open({ viewport: { width: 460, height: 780 } });
const shot = (name, p = page) => p.screenshot({ path: path.join(SHOTS, name + ".png") });

// Sign in
await page.getByRole("heading", { name: "Reach every device, from anywhere." }).waitFor();
assert.equal(await page.getByLabel("Server address").inputValue(), CONTROL);
await shot("1-sign-in");
await page.getByLabel("Server address").fill("not a url");
await page.getByRole("button", { name: "Connect" }).click();
await page.getByRole("alert").waitFor();
step("bad server address is rejected with a message: " + (await page.getByRole("alert").textContent()));
errors.length = 0; // the rejected request above is logged by the browser; that one is expected
await page.getByLabel("Server address").fill(CONTROL);
await page.getByRole("button", { name: "I have an access key" }).click();
await page.getByLabel("Access key").fill(USER_KEY);
await page.getByRole("button", { name: "Connect" }).click();

// Devices
await page.getByText("Connected", { exact: true }).waitFor({ timeout: 20000 });
await page.getByText("phone", { exact: true }).waitFor();
await page.getByText("nas-india", { exact: true }).waitFor();
assert.equal(await page.getByText("My devices").count(), 1);
assert.equal(await page.getByText("Shared", { exact: true }).count(), 1);
step("signed in with an access key; own device and shared NAS are listed in separate groups");

await page.getByRole("button", { name: "Test connection to phone" }).click();
await page.locator("#toast.show").waitFor();
const pingMsg = await page.locator("#toast").textContent();
assert.match(pingMsg, /ms$/);
step("connection test: " + pingMsg);
await page.locator(".dev", { hasText: "phone" }).locator(".chip--direct").waitFor();
await shot("2-devices");

// Drop: send laptop -> phone
await page.getByRole("button", { name: "Send files to phone" }).click();
await page.getByRole("heading", { name: "Send files to your devices" }).waitFor();
assert.equal(await page.getByRole("button", { name: "nas-india" }).count(), 0, "tagged devices cannot receive Drop yet");
const big = path.join(WORK, "render.bin");
fs.writeFileSync(big, Buffer.alloc(8 * 1024 * 1024, 7));
fs.writeFileSync(path.join(WORK, "notes.txt"), "hello from laptop\n");
await page.locator("#files").setInputFiles([big, path.join(WORK, "notes.txt")]);
// exact text: the live rows say "Sent to phone"; history rows add size and time
await page.getByText("Sent to phone", { exact: true }).nth(1).waitFor({ timeout: 60000 }).catch(async (e) => {
  console.log("send rows:", await page.locator(".xfer").allTextContents());
  throw e;
});
fs.mkdirSync(path.join(WORK, "phone-inbox"), { recursive: true });
execSync(`${PHONE_GET} ${path.join(WORK, "phone-inbox")}`, { cwd: WORK, stdio: "pipe", encoding: "utf8" });
assert.equal(fs.readFileSync(path.join(WORK, "phone-inbox", "notes.txt"), "utf8"), "hello from laptop\n");
assert.equal(fs.statSync(path.join(WORK, "phone-inbox", "render.bin")).size, 8 * 1024 * 1024);
step("Drop send: two files (one 8 MB) arrived intact on the phone");

// Drop: receive phone -> laptop, twice with the same name (must not overwrite)
const me = (await page.evaluate(() => fetch("/api/state", { headers: { "X-Linkotter-Token": "e2e" } }).then((r) => r.json()))).self.name;
fs.writeFileSync(path.join(WORK, "photo.jpg"), "first");
execSync(`${PHONE_SEND} ${path.join(WORK, "photo.jpg")} ${me}:`, { cwd: WORK, stdio: "pipe", encoding: "utf8" });
const inbox = path.join(WORK, "home", "Downloads", "Linkotter");
await page.getByText("photo.jpg", { exact: true }).waitFor({ timeout: 20000 });
fs.writeFileSync(path.join(WORK, "photo.jpg"), "second");
execSync(`${PHONE_SEND} ${path.join(WORK, "photo.jpg")} ${me}:`, { cwd: WORK, stdio: "pipe", encoding: "utf8" });
await page.getByText("photo (2).jpg", { exact: true }).waitFor({ timeout: 20000 });
assert.equal(fs.readFileSync(path.join(inbox, "photo.jpg"), "utf8"), "first");
assert.equal(fs.readFileSync(path.join(inbox, "photo (2).jpg"), "utf8"), "second");
step("Drop receive: files saved automatically; a second file with the same name did not overwrite the first");
await shot("3-drop");

// Settings
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
await shot("4-settings");

// Pause / resume
await page.getByRole("button", { name: "Devices" }).click();
await page.getByRole("switch", { name: "Connection" }).uncheck();
await page.getByText("Paused", { exact: true }).waitFor();
await shot("5-paused");
await page.getByRole("switch", { name: "Connection" }).check();
await page.getByText("Connected", { exact: true }).waitFor({ timeout: 20000 });
step("pause and resume");

// Dark theme and a wide window
const dark = await open({ viewport: { width: 1100, height: 760 }, colorScheme: "dark" });
await dark.getByText("Connected", { exact: true }).waitFor();
await shot("6-dark-wide", dark);

// API is closed without the token and to other hostnames
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
