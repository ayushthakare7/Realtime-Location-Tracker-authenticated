import { Capacitor, CapacitorHttp, registerPlugin } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import type { BackgroundGeolocationPlugin } from "@capacitor-community/background-geolocation";

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>("BackgroundGeolocation");
let watcherId: string | null = null;
let starting: Promise<boolean> | null = null;
let activeToken: string | null = null;

type StartOptions = { token: string; endpoint?: string };
const isNativeAndroid = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";

async function sendLocation(token: string, endpoint: string, location: any) {
  if (!location || !Number.isFinite(Number(location.latitude)) || !Number.isFinite(Number(location.longitude))) return;
  try {
    await CapacitorHttp.post({
      url: endpoint,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      data: {
        latitude: Number(location.latitude),
        longitude: Number(location.longitude),
        accuracyMeters: Number(location.accuracy),
        time: Number(location.time) || Date.now()
      },
      connectTimeout: 15000,
      readTimeout: 15000
    });
  } catch (error) {
    // The next GPS callback retries. The backend still keeps the last known location.
    console.warn("[Reva background location] Upload failed; waiting for next GPS fix.", error);
  }
}

async function start(options: StartOptions): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  if (!options?.token) throw new Error("Sign in to Reva before starting background journey tracking.");
  if (watcherId && activeToken === options.token) return true;
  if (starting) return starting;

  starting = (async () => {
    if (watcherId) await stop();
    activeToken = options.token;
    try {
      const permission = await LocalNotifications.checkPermissions();
      if (permission.display !== "granted") await LocalNotifications.requestPermissions();
    } catch (error) {
      console.warn("[Reva background location] Notification permission request unavailable.", error);
    }

    const id = await BackgroundGeolocation.addWatcher({
      backgroundMessage: "Your active Reva journey is sharing location with the friends you selected. Open Reva to end tracking.",
      backgroundTitle: "Reva journey tracking is active",
      requestPermissions: true,
      stale: false,
      distanceFilter: 20
    }, (location, error) => {
      if (error) {
        console.warn("[Reva background location]", error);
        return;
      }
      if (location && activeToken === options.token) {
        void sendLocation(options.token, options.endpoint || (window.location.origin + "/api/tracker/location-native"), location);
      }
    });
    watcherId = id;
    return true;
  })();

  try { return await starting; }
  finally { starting = null; }
}

async function stop(): Promise<void> {
  activeToken = null;
  const id = watcherId;
  watcherId = null;
  if (id) await BackgroundGeolocation.removeWatcher({ id });
}

(window as any).RevaNativeBackground = {
  supported: isNativeAndroid(),
  start,
  stop
};
