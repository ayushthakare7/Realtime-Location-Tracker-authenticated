(() => {
  // The native Android wrapper should expose window.RevaPush.getToken(), resolving
  // to the FCM registration token. Ordinary browsers safely skip this bridge.
  const token = localStorage.getItem("token");
  if (!token || !window.RevaPush || typeof window.RevaPush.getToken !== "function") return;

  Promise.resolve()
    .then(() => window.RevaPush.getToken())
    .then(pushToken => {
      if (!pushToken || typeof pushToken !== "string") return;
      return fetch("/api/push/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ token: pushToken, platform: "android" })
      });
    })
    .then(response => {
      if (response && !response.ok) console.warn("[Reva Push] Device registration was rejected.");
    })
    .catch(error => console.warn("[Reva Push] Device registration unavailable:", error.message));
})();
