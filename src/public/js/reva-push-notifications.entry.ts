import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";

type PushRegistration = { value: string };
let listenersReady = false;
let registering = false;

async function registerToken(pushToken: string) {
  const authToken = window.localStorage.getItem("token");
  if (!authToken || !pushToken) return;
  try {
    const response = await fetch("/api/push/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + authToken
      },
      body: JSON.stringify({ token: pushToken, platform: "android" })
    });
    if (!response.ok) console.warn("[Reva Push] Device token registration failed:", response.status);
  } catch (error) {
    console.warn("[Reva Push] Could not register device token:", error);
  }
}

async function startPushRegistration() {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android" || registering) return;
  registering = true;
  try {
    if (!listenersReady) {
      listenersReady = true;
      await PushNotifications.addListener("registration", (token: PushRegistration) => {
        void registerToken(token.value);
      });
      await PushNotifications.addListener("registrationError", error => {
        console.warn("[Reva Push] Native registration failed:", error);
      });
      await PushNotifications.addListener("pushNotificationActionPerformed", action => {
        const path = action.notification.data?.viewPath;
        if (typeof path === "string" && path.startsWith("/")) window.location.assign(path);
      });
      await PushNotifications.addListener("pushNotificationReceived", notification => {
        // Android displays FCM notification payloads while backgrounded. In the
        // foreground, keep a small console trace; the app's in-app UI remains authoritative.
        console.info("[Reva Push] Notification received:", notification.title || "Reva");
      });
    }

    const permission = await PushNotifications.checkPermissions();
    let receive = permission.receive;
    if (receive !== "granted") {
      const requested = await PushNotifications.requestPermissions();
      receive = requested.receive;
    }
    if (receive !== "granted") {
      console.info("[Reva Push] Notification permission was not granted.");
      return;
    }

    try {
      await PushNotifications.createChannel({
        id: "reva_journeys",
        name: "Reva journey updates",
        description: "Journey start, delay and arrival notifications",
        importance: 5,
        sound: "default",
        vibration: true
      });
    } catch (_) {
      // Channel creation is Android-specific and can fail on older plugin versions.
    }
    await PushNotifications.register();
  } catch (error) {
    console.warn("[Reva Push] Push setup unavailable:", error);
  } finally {
    registering = false;
  }
}

void startPushRegistration();
