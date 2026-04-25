/**
 * Automatic Kite token refresh using stored credentials + TOTP.
 * No browser needed — pure HTTP + built-in crypto.
 *
 * Requires in .env:
 *   KITE_USER_ID       — your Zerodha client ID (e.g. WSH764)
 *   KITE_PASSWORD      — your Zerodha password
 *   KITE_TOTP_SECRET   — base32 secret from Google Authenticator setup
 */

import crypto from "crypto";
import { execSync } from "child_process";
import { KiteClient, saveToken } from "./kite.js";

// ─── TOTP (RFC 6238) ─────────────────────────────────────────────────────────

function generateTOTP(base32Secret) {
  const clean = base32Secret.toUpperCase().replace(/\s|=/g, "");
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  // Decode base32 → bytes
  let bits = "";
  for (const ch of clean) {
    const i = alpha.indexOf(ch);
    if (i >= 0) bits += i.toString(2).padStart(5, "0");
  }
  const key = Buffer.from(
    Array.from({ length: Math.floor(bits.length / 8) }, (_, i) =>
      parseInt(bits.slice(i * 8, i * 8 + 8), 2)
    )
  );

  // HMAC-SHA1 with 30-second counter
  const counter = Math.floor(Date.now() / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", key).update(msg).digest();

  // Dynamic truncation
  const off  = h[h.length - 1] & 0x0f;
  const code = (
    ((h[off]     & 0x7f) << 24) |
    ((h[off + 1] & 0xff) << 16) |
    ((h[off + 2] & 0xff) << 8)  |
     (h[off + 3] & 0xff)
  ) % 1_000_000;

  return code.toString().padStart(6, "0");
}

// ─── Cookie jar ───────────────────────────────────────────────────────────────

function makeCookieJar() {
  const jar = {};
  return {
    absorb(res) {
      const raw = res.headers.getSetCookie?.() ?? [];
      for (const c of raw) {
        const [kv] = c.split(";");
        const eq   = kv.indexOf("=");
        if (eq > 0) jar[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
      }
    },
    header() {
      return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    },
  };
}

// ─── Auto-auth flow ───────────────────────────────────────────────────────────

export async function autoAuth() {
  const {
    KITE_API_KEY, KITE_API_SECRET,
    KITE_USER_ID, KITE_PASSWORD, KITE_TOTP_SECRET,
  } = process.env;

  if (!KITE_USER_ID || !KITE_PASSWORD || !KITE_TOTP_SECRET) {
    throw new Error(
      "KITE_USER_ID, KITE_PASSWORD, and KITE_TOTP_SECRET must be set in .env for auto-auth"
    );
  }

  const jar = makeCookieJar();
  const BASE = "https://kite.zerodha.com";
  const UA   = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

  // ── Step 1: password login ────────────────────────────────────────────────

  console.log("  [auto-auth] Step 1/3 — password login...");
  const loginRes = await fetch(`${BASE}/api/login`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body:    new URLSearchParams({ user_id: KITE_USER_ID, password: KITE_PASSWORD }),
  });
  jar.absorb(loginRes);
  const loginJson = await loginRes.json();
  if (loginJson.status !== "success") throw new Error(`Login failed: ${loginJson.message}`);
  const requestId = loginJson.data.request_id;

  // ── Step 2: TOTP 2FA ──────────────────────────────────────────────────────

  console.log("  [auto-auth] Step 2/3 — TOTP verification...");
  const totpCode = generateTOTP(KITE_TOTP_SECRET);

  const tfaRes = await fetch(`${BASE}/api/twofa`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent":   UA,
      "Cookie":       jar.header(),
    },
    body: new URLSearchParams({
      user_id:     KITE_USER_ID,
      request_id:  requestId,
      twofa_value: totpCode,
      twofa_type:  "totp",
    }),
  });
  jar.absorb(tfaRes);
  const tfaJson = await tfaRes.json();
  if (tfaJson.status !== "success") throw new Error(`TOTP failed: ${tfaJson.message}`);

  // ── Step 3: OAuth redirect → connect/finish → capture request_token ─────

  console.log("  [auto-auth] Step 3/3 — capturing request token...");

  const oauthRes = await fetch(
    `${BASE}/connect/login?api_key=${KITE_API_KEY}&v=3`,
    { redirect: "manual", headers: { "User-Agent": UA, "Cookie": jar.header() } }
  );
  jar.absorb(oauthRes);

  let location = oauthRes.headers.get("location") || "";

  // Kite may redirect to /connect/finish first — follow it
  if (location.includes("/connect/finish")) {
    const finishRes = await fetch(location, {
      redirect: "manual",
      headers:  { "User-Agent": UA, "Cookie": jar.header() },
    });
    jar.absorb(finishRes);
    location = finishRes.headers.get("location") || location;
  }

  let requestToken;
  try {
    requestToken = new URL(location).searchParams.get("request_token");
  } catch {
    requestToken = null;
  }

  if (!requestToken)
    throw new Error(
      `Could not capture request_token. Redirect was: ${location || "(none)"}\n` +
      "Check that KITE_USER_ID, KITE_PASSWORD, and KITE_TOTP_SECRET are correct."
    );

  // ── Exchange for access token ─────────────────────────────────────────────

  const accessToken = await KiteClient.generateAccessToken({
    apiKey:       KITE_API_KEY,
    apiSecret:    KITE_API_SECRET,
    requestToken,
  });

  saveToken(accessToken);
  console.log(`  [auto-auth] ✅ New access token saved`);

  // ── Push to Railway if CLI is available ───────────────────────────────────

  try {
    execSync(`railway variable set KITE_ACCESS_TOKEN=${accessToken}`, { stdio: "pipe" });
    console.log("  [auto-auth] ✅ Railway KITE_ACCESS_TOKEN updated");
  } catch {
    // Not on Railway CLI — fine, token is saved to .kite-access-token
  }

  return accessToken;
}
