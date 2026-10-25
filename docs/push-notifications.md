# Reva push notifications (Firebase Cloud Messaging)

The Android build uses the Firebase Android app for project `reva-location-tracker` and package `com.reva.locationtracker`. The Android configuration file at `firebase/google-services.json` is public app configuration, not a server private key.

## Backend setup

1. In Firebase Console, open Project settings → Service accounts.
2. Generate a service-account key with permission to send Firebase Cloud Messaging messages.
3. On the main Reva Node service (Render), add environment variable `FIREBASE_SERVICE_ACCOUNT_JSON` with the entire service-account JSON value.
4. Never commit or share that service-account private key.

## Android build

The GitHub Actions workflow installs Capacitor Push Notifications, bundles `src/public/js/reva-push-notifications.entry.ts`, copies the Firebase Android config into the generated Android app, applies the Google Services Gradle plugin, and builds a debug APK. The client requests Android notification permission, creates the `reva_journeys` notification channel, registers the current FCM token with the authenticated backend, and opens the shared journey when the user taps a notification.

## Delivery and privacy

The Node backend stores device tokens through authenticated `POST /api/push/register` and `DELETE /api/push/register` endpoints. Trusted mobility lifecycle events are checked against the existing sharing-enabled and accepted-friend rules before the server sends journey push notifications. No service-account key belongs in the repository.

## Test plan

1. Deploy the Node service with `FIREBASE_SERVICE_ACCOUNT_JSON` set.
2. Run **Build Reva Android APK** from the `feature/reva-fcm-native-integration` branch with the deployed Reva HTTPS URL.
3. Install the artifact on an Android device, sign in, and accept notification permission.
4. Confirm the device registers, then test a shared journey start, delay, arrival, and end while Reva is foregrounded, backgrounded, and closed.
