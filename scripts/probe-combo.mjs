import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "file:///D:/projects/dsh_desktop/DSH%20Desktop/resources/dsh-runtime/node_modules/yaml/dist/index.js";
const home = process.env.USERPROFILE;
const port = "3080";
const authority = `127.0.0.1:${port}`;
const doc = parse(readFileSync(join(home, ".dsh", ".credentials.yaml"), "utf8"));
function findRecord(obj) {
  if (obj && typeof obj === "object") {
    if (obj.kind === "grant" && obj.payload && obj.payload.secret) return obj.payload.secret;
    for (const v of Object.values(obj)) { const r = findRecord(v); if (r) return r; }
  }
  return undefined;
}
const secret = Buffer.from(findRecord(doc), "base64url");
const b64u = (b) => Buffer.from(b).toString("base64url");
const cookieName = "dsh-auth-" + b64u(createHash("sha256").update(authority).digest());
const payload = { version: 1, authority, issuedAt: Date.now(), expiresAt: Date.now() + 3600_000 };
const body = b64u(Buffer.from(JSON.stringify(payload), "utf8"));
const cookie = `${cookieName}=v1.${body}.${b64u(createHmac("sha256", secret).update(body).digest())}`;
const base = `http://${authority}`;
const r = await fetch(base + "/plugins/??whalebuddy/client.js&rev=54d568be3b63", { headers: { cookie } });
const t = await r.text();
console.log("status", r.status, "len", t.length);
console.log("has configForms:", t.includes("configForms"));
console.log("has whileServed:", t.includes("whileServed"));
console.log("has settingsScope:", t.includes("settingsScope"));
console.log("has plugins.item:", t.includes("plugins.item"));
console.log("has plugins.tab:", t.includes("settings.plugins.tab"));
