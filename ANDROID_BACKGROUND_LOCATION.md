# Reva Android background location (prototype)

This adds an Android Capacitor wrapper for the existing Reva web app and a native GPS watcher used only while a journey is ACTIVE or DELAYED.

## How it is designed
- The existing web app, Node backend, mobility service, MongoDB, and Python RAG remain in place.
- Android uses `@capacitor-community/background-geolocation` to request GPS fixes and show a persistent foreground notification while tracking.
- The native Capacitor HTTP bridge posts each fix to authenticated `POST /api/tracker/location-native`, so WebView background fetch throttling is avoided.
- The endpoint requires the user's JWT and existing sharing preference, saves the latest location, honors location-history preference, and broadcasts to accepted friends who have sharing enabled.
- Tracking is started from the journey page only while a journey is ACTIVE/DELAYED and stopped when the journey is no longer active. Users must explicitly grant permissions and can end the journey in Reva.

## Build an APK locally
1. Install Node.js LTS and Android Studio with the Android SDK on a computer.
2. Run `npm install`.
3. Set `REVA_WEB_URL` to your actual deployed Reva HTTPS URL (the same app that serves `/mobility` and `/api/tracker`). Do not use the example hostname.
4. Run `npm run mobile:build`.
5. Run `npx cap add android` once, if the `android/` folder does not exist.
6. Run `REVA_WEB_URL=https://YOUR-ACTUAL-REVA-HOST npm run mobile:sync` (PowerShell: `$env:REVA_WEB_URL="https://YOUR-ACTUAL-REVA-HOST"; npm run mobile:sync`).
7. Run `npm run mobile:android`, allow Android Studio to finish Gradle sync, then build an APK from **Build → Build Bundle(s) / APK(s) → Build APK(s)**.

Capacitor sync must be repeated after changing plugin dependencies. Keep `REVA_WEB_URL` set consistently when syncing so the APK points at the correct deployment.

## Important
- This is Android-first. The APK has not been built or tested on a physical device by this code change.
- Test: sign in, enable location sharing, start a journey, grant precise location and notification permissions, lock the screen for 10–15 minutes, and verify a friend's map receives fresh timestamps. Then end the journey and verify the persistent tracking notification disappears.
- Android/OEM battery restrictions, force-stop, revoked permissions, GPS/network loss, or the phone being off can interrupt tracking. Users may need to set battery usage to unrestricted. Do not promise guaranteed tracking after force-stop.
- If publishing on Google Play later, disclose background location clearly and follow Google Play's background-location policy. A directly installed test APK does not need Play Store publication.
- The browser-only version continues to work, but does not promise reliable screen-locked tracking.
