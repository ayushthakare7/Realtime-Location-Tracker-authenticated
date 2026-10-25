# Reva push notifications (FCM)

This branch adds the server-side Firebase Cloud Messaging (FCM) HTTP v1 delivery foundation and authenticated device-token registration. It intentionally does not include Firebase credentials.

## Configure Firebase

1. In Firebase Console, create/select a project and add an Android app using the exact applicationId/package name of the Reva APK.
2. Download the Android `google-services.json` into the native Android app module and configure the Google Services Gradle plugin and Firebase Messaging SDK in the native Android project.
3. Create a Firebase service account with permission to send Firebase Cloud Messaging messages. Keep its JSON private.
4. Configure this environment variable on the main Reva Node service:
   - `FIREBASE_SERVICE_ACCOUNT_JSON`: the full service-account JSON on one line (including the private key).
5. Never commit service-account JSON or the Android app's signing keys to GitHub.

## Native Android bridge still required

The current repository contains the Node/EJS web app. The browser page calls `window.RevaPush.getToken()` only when a native Android wrapper exposes that bridge. The APK's native code must implement this bridge using Firebase Messaging's current registration token and resolve it to JavaScript. Token refresh must also re-register the new token. A normal website or WebView does not automatically expose an Android FCM token.

For a web-only install, use a separate Web Push setup (service worker, browser permission, VAPID key and web push token); an Android FCM token is not a web push token.

## API

- `POST /api/push/register` with authenticated Bearer token and JSON `{ "token": "...", "platform": "android" }`
- `DELETE /api/push/register` with authenticated Bearer token and JSON `{ "token": "..." }`

When the mobility service sends a trusted journey event to the main backend, Reva stores its in-app notification and also attempts FCM delivery to registered recipient devices. Journey start/delay/arrival/end notifications follow the existing accepted-friend and location-sharing checks.

## Test plan

1. Deploy the Node service with `FIREBASE_SERVICE_ACCOUNT_JSON` configured.
2. Install a debug APK built with Firebase Messaging and the `RevaPush.getToken()` bridge.
3. Sign in and confirm a device record is created in MongoDB.
4. Start a shared journey with another test account; background or close Reva and verify a push notification appears.
5. Confirm that arrival/ending updates do not generate repeated notifications. Test with battery optimization and notification permission settings noted, since Android can delay or suppress delivery.
