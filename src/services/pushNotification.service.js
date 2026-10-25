const crypto = require("crypto");
const PushDevice = require("../models/PushDevice");

let serviceAccount = null;
let cachedAccessToken = null;
let accessTokenExpiresAt = 0;

function getServiceAccount() {
  if (serviceAccount) return serviceAccount;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return null;
  try {
    const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (!account.project_id || !account.client_email || !account.private_key) {
      throw new Error("Service account needs project_id, client_email and private_key.");
    }
    serviceAccount = account;
    return serviceAccount;
  } catch (error) {
    console.error("[Push] Firebase service account configuration is invalid:", error.message);
    return null;
  }
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

async function getAccessToken(account) {
  if (cachedAccessToken && Date.now() < accessTokenExpiresAt - 60000) return cachedAccessToken;
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: account.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const unsigned = header + "." + claim;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = unsigned + "." + signer.sign(account.private_key, "base64url");
  const response = await fetch(account.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    }),
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error("Google OAuth token request failed (" + response.status + ").");
  cachedAccessToken = data.access_token;
  accessTokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
  return cachedAccessToken;
}

async function registerPushDevice({ userId, token, platform = "android" }) {
  const cleanToken = String(token || "").trim();
  if (!userId || cleanToken.length < 20 || cleanToken.length > 4096) {
    const error = new Error("A valid push token is required.");
    error.status = 400;
    throw error;
  }
  const safePlatform = ["android", "web"].includes(platform) ? platform : "android";
  await PushDevice.updateMany({ token: cleanToken, userId: { $ne: userId } }, { $set: { enabled: false } });
  return PushDevice.findOneAndUpdate(
    { token: cleanToken },
    { $set: { userId, platform: safePlatform, enabled: true, lastRegisteredAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).select("_id platform enabled lastRegisteredAt").lean();
}

async function unregisterPushDevice({ userId, token }) {
  if (!userId || !token) return;
  await PushDevice.updateOne({ userId, token: String(token).trim() }, { $set: { enabled: false } });
}

async function sendPushToUser({ userId, title, body, data = {} }) {
  const account = getServiceAccount();
  if (!account || !userId) return { configured: Boolean(account), sent: 0 };
  const devices = await PushDevice.find({ userId, enabled: true }).select("_id token").lean();
  if (!devices.length) return { configured: true, sent: 0 };
  let accessToken;
  try {
    accessToken = await getAccessToken(account);
  } catch (error) {
    console.warn("[Push] Could not obtain Firebase access token:", error.message);
    return { configured: true, sent: 0 };
  }
  const stringData = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value !== undefined && value !== null) stringData[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  let sent = 0;
  for (const device of devices) {
    try {
      const response = await fetch("https://fcm.googleapis.com/v1/projects/" + encodeURIComponent(account.project_id) + "/messages:send", {
        method: "POST",
        headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token: device.token,
            notification: { title: String(title || "Reva"), body: String(body || "") },
            data: stringData,
            android: { priority: "HIGH", notification: { channel_id: "reva_journeys", sound: "default" } }
          }
        }),
        signal: AbortSignal.timeout(10000)
      });
      if (response.ok) { sent += 1; continue; }
      const failure = await response.json().catch(() => ({}));
      const detail = JSON.stringify(failure);
      if (detail.includes("UNREGISTERED") || detail.includes("registration-token-not-registered")) {
        await PushDevice.updateOne({ _id: device._id }, { $set: { enabled: false } });
      } else {
        console.warn("[Push] FCM delivery failed:", response.status);
      }
    } catch (error) {
      console.warn("[Push] FCM delivery failed:", error.message);
    }
  }
  return { configured: true, sent };
}

module.exports = { registerPushDevice, unregisterPushDevice, sendPushToUser };
