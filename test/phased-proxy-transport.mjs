import assert from "node:assert/strict";
import http from "node:http";
import { CookieJar, ProtocolClient, exchangeOAuthCode } from "../src/protocol-login.mjs";
import { TlsFingerprintTransport } from "../src/tls-transport.mjs";

const seen = [];
const origin = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/login") res.setHeader("set-cookie", "verified=fixture-session; Path=/");
  res.end(JSON.stringify(req.url === "/oauth/token" ? { access_token: "fixture-access", refresh_token: "fixture-refresh", id_token: "fixture-id" } : { cookie: req.headers.cookie || "" }));
});
await listen(origin);
const target = `http://127.0.0.1:${origin.address().port}`;
function proxy(label) {
  return http.createServer((req, res) => {
    const url = new URL(req.url);
    seen.push({ label, path: url.pathname, auth: req.headers["proxy-authorization"], cookie: req.headers.cookie || "" });
    const upstream = http.request(`${target}${url.pathname}`, { method: req.method, headers: { ...req.headers, host: new URL(target).host } }, (response) => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on("error", (error) => { res.writeHead(502); res.end(error.message); });
    req.pipe(upstream);
  });
}
const dynamic = proxy("dynamic");
const fixed = proxy("fixed");
await Promise.all([listen(dynamic), listen(fixed)]);
const dynamicUrl = `http://login-sid-original:fixture@127.0.0.1:${dynamic.address().port}`;
const fixedUrl = `http://bound-sid-original:fixture@127.0.0.1:${fixed.address().port}`;
const transport = new TlsFingerprintTransport({ enabled: true, profile: "chrome142" });
const base = "http://phase.fixture.invalid";
try {
  await transport.prepareProxy(dynamicUrl, `${base}/`);
  const client = new ProtocolClient({ jar: new CookieJar(), transport });
  await client.getJson("GET", `${base}/login`);
  transport.rotateProxySessions = false;
  await transport.prepareProxy(fixedUrl, `${base}/`);
  const { data } = await client.getJson("GET", `${base}/oauth/authorize`);
  assert.match(data.cookie, /verified=fixture-session/, "verified browser cookie crosses the proxy/session boundary");
  const tokens = await exchangeOAuthCode({ authBase: base, code: "fixture-code", codeVerifier: "fixture-verifier", clientId: "fixture-client", redirectUri: "http://127.0.0.1:1455/auth/callback", transport });
  assert.equal(tokens.access_token, "fixture-access");
  assert.equal(seen.find((item) => item.path === "/login").label, "dynamic");
  assert.equal(seen.find((item) => item.path === "/oauth/authorize").label, "fixed");
  assert.equal(seen.find((item) => item.path === "/oauth/token").label, "fixed");
  assert.equal(seen.find((item) => item.path === "/oauth/token").cookie, "", "token exchange stays isolated from browser cookies");
  const user = (item) => Buffer.from(item.auth.split(" ")[1], "base64").toString().split(":")[0];
  assert.notEqual(user(seen.find((item) => item.path === "/login")), "login-sid-original", "web proxy session rotates");
  assert.equal(user(seen.find((item) => item.path === "/oauth/authorize")), "bound-sid-original", "OAuth proxy session remains fixed");
  console.log("PASS: real curl transport rotates web proxy, switches proxy with verified cookies intact, pins OAuth IP and exchanges tokens through the fixed proxy without cookies");
} finally {
  await transport.close();
  await Promise.all([origin, dynamic, fixed].map((server) => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); }));
}
function listen(server) { return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); }
