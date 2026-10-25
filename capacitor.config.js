const path = require("path");

const serverUrl = process.env.REVA_WEB_URL;
if (serverUrl && !/^https:\/\//i.test(serverUrl)) {
  throw new Error("REVA_WEB_URL must be an HTTPS URL for your deployed Reva app.");
}

module.exports = {
  appId: "com.reva.locationtracker",
  appName: "Reva",
  webDir: "mobile-shell",
  android: {
    useLegacyBridge: true
  },
  server: serverUrl ? {
    url: serverUrl.replace(/\/$/, ""),
    cleartext: false,
    allowNavigation: [new URL(serverUrl).hostname]
  } : undefined,
  plugins: {
    CapacitorHttp: { enabled: true }
  }
};
