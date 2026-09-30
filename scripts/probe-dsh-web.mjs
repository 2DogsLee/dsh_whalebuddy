// 诊断用：用本机 .credentials.yaml 里的 browser-session 签名密钥铸造合法 cookie，
// 探测 DSH web 的模块索引与 whalebuddy client 是否被服务。只读，不写任何设置。
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "file:///D:/projects/dsh_desktop/DSH%20Desktop/resources/dsh-runtime/node_modules/yaml/dist/index.js";

const home = process.env.USERPROFILE;
const port = process.argv[2] || "3080";
const authority = `127.0.0.1:${port}`;

const doc = parse(readFileSync(join(home, ".dsh", ".credentials.yaml"), "utf8"));
// 记录键 = credentialKey("client-connection","browser-session")，形如 "client-connection/browser-session" 或类似；
// 直接在 records 里找含 payload.secret 的 browser-session 记录
const records = doc.records ?? doc;
function findRecord(obj) {
  if (obj && typeof obj === "object") {
    if (obj.kind === "grant" && obj.payload && obj.payload.secret) return obj.payload.secret;
    for (const v of Object.values(obj)) {
      const r = findRecord(v);
      if (r) return r;
    }
  }
  return undefined;
}
const secretB64 = findRecord(records);
if (!secretB64) { console.log("NO_SECRET"); process.exit(1) }
const secret = Buffer.from(secretB64, "base64url");
if (secret.length !== 32) { console.log("SECRET_LEN", secret.length); process.exit(1) }

const b64u = (b) => Buffer.from(b).toString("base64url");
const cookieName = "dsh-auth-" + b64u(createHash("sha256").update(authority).digest());
const payload = { version: 1, authority, issuedAt: Date.now(), expiresAt: Date.now() + 3600_000 };
const body = b64u(Buffer.from(JSON.stringify(payload), "utf8"));
const sig = createHmac("sha256", secret).update(body).digest();
const cookie = `${cookieName}=v1.${body}.${b64u(sig)}`;

const base = `http://${authority}`;
async function probe(path) {
  const r = await fetch(base + path, { headers: { cookie }, redirect: "manual" });
  const text = await r.text();
  return { status: r.status, len: text.length, text };
}

const index = await probe("/");
console.log("index:", index.status, "len", index.len);
const hits = index.text.match(/[^"']*whalebuddy[^"']*/g);
console.log("whalebuddy mentions in index:", hits ? hits.slice(0, 5) : "NONE");
const scripts = [...index.text.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
console.log("script rows:", scripts.length);
console.log(scripts.slice(0, 40).join("\n"));

const client = await probe("/plugins/whalebuddy/client.js");
console.log("plugins/whalebuddy/client.js:", client.status, "len", client.len, JSON.stringify(client.text.slice(0, 120)));

