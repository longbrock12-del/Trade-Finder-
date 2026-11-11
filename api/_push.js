// Trade Finder - sends Web Push notifications (phone alerts), with Node's built-in crypto only.
// Not a Vercel function (file name starts with _).
//   - VAPID (RFC 8292): the site's own key pair identifies it to the push service. Made once, kept in the database.
//   - Message encryption (RFC 8291, "aes128gcm"): every message is encrypted for the subscribed phone.
const crypto = require("crypto");

const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

// A new site key pair: public key as 65-byte uncompressed point (base64url), private key as JWK.
function newVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const pub = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
  return { publicKey: b64u(pub), privateJwk: privateKey.export({ format: "jwk" }) };
}

// "Authorization: vapid t=<signed token>, k=<public key>" for one push service.
function vapidHeader(endpoint, keys, subject) {
  const aud = new URL(endpoint).origin, exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" })), body = b64u(JSON.stringify({ aud, exp, sub: subject }));
  const key = crypto.createPrivateKey({ key: keys.privateJwk, format: "jwk" });
  const sig = crypto.sign("sha256", Buffer.from(head + "." + body), { key, dsaEncoding: "ieee-p1363" });
  return "vapid t=" + head + "." + body + "." + b64u(sig) + ", k=" + keys.publicKey;
}

// Encrypt a message for a subscription (keys.p256dh, keys.auth from the browser).
function encrypt(text, p256dh, auth) {
  const uaPublic = unb64u(p256dh), authSecret = unb64u(auth);
  const ecdh = crypto.createECDH("prime256v1");
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(text), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

// Send one notification. Returns "sent", "gone" (the phone unsubscribed: delete it) or "failed".
async function send(sub, msg, keys, subject) {
  try {
    const r = await fetch(sub.endpoint, {
      method: "POST", signal: AbortSignal.timeout(8000),
      headers: { Authorization: vapidHeader(sub.endpoint, keys, subject), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "3600", Urgency: "high" },
      body: encrypt(JSON.stringify(msg), sub.keys.p256dh, sub.keys.auth),
    });
    if (r.status === 404 || r.status === 410) return "gone";
    return r.ok ? "sent" : "failed";
  } catch (e) { return "failed"; }
}

module.exports = { newVapidKeys, vapidHeader, encrypt, send, b64u, unb64u };
