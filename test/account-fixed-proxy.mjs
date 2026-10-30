import assert from "node:assert/strict";
import { TlsFingerprintTransport } from "../src/tls-transport.mjs";

const url = "http://account-sid-original:password@proxy.invalid:8080";
const fixed = new TlsFingerprintTransport({ rotateProxySessions: false });
const fixedConfigured = [];
fixed.configure = async (proxy) => { fixedConfigured.push(proxy); };
fixed.request = async () => ({ status: 200, headers: new Headers() });
assert.equal(await fixed.prepareProxy(url, "https://chatgpt.com/"), url);
assert.deepEqual(fixedConfigured, [url], "account proxy must keep its session ID");

const global = new TlsFingerprintTransport();
const rotated = [];
global.configure = async (proxy) => { rotated.push(proxy); };
global.request = fixed.request;
await global.prepareProxy(url, "https://chatgpt.com/");
assert.notEqual(rotated[0], url, "global proxy mode must retain automatic session rotation");
console.log("account fixed proxy tests passed: exact session preserved; global rotation preserved");
