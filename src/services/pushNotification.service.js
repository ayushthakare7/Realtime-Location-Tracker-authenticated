const PushDevice = require("../models/PushDevice");

let firebaseAdmin = null;
let firebaseInitAttempted = false;

function getMessaging() {
  if (firebaseInitAttempted) return firebaseAdmin?.messaging?.() || null;
  firebaseInitAttempted = true;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const admin = require("firebase-admin");
    const serviceAccount = JSON.parse(raw);
    firebaseAdmin = admin.apps.length ? admin : admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    return firebaseAdmin.messaging();
  } catch (error) {
    console.error("[Push] Firebase Admin is not configured:", error.message);
    return null;
  }
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
  const messaging = getMessaging();
  if (!messaging || !userId) return { configured: Boolean(messaging), sent: 0 };
  const devices = await PushDevice.find({ userId, enabled: true }).select("_id token").lean();
  if (!devices.length) return { configured: true, sent: 0 };
  const stringData = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value !== undefined && value !== null) stringData[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  let sent = 0;
  for (const device of devices) {
    try {
      await messaging.send({
        token: device.token,
        notification: { title: String(title || "Reva"), body: String(body || "") },
        data: stringData,
        android: { priority: "high", notification: { channelId: "reva_journeys", sound: "default" } }
      });
      sent += 1;
    } catch (error) {
      const code = error?.code || "";
      if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) {
        await PushDevice.updateOne({ _id: device._id }, { $set: { enabled: false } });
      } else {
        console.warn("[Push] Delivery failed:", code || error.message);
      }
    }
  }
  return { configured: true, sent };
}

module.exports = { registerPushDevice, unregisterPushDevice, sendPushToUser };
