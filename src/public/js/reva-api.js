// Shared browser API client used by the dashboard and journey pages.
(function attachRevaApi(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.RevaApi = api;
})(typeof window !== "undefined" ? window : globalThis, function createRevaApiModule() {
  function createApiClient(basePath, token, fallbackMessage = "Request failed") {
    const base = String(basePath || "").replace(/\/$/, "");
    return async function api(path, options = {}) {
      const response = await fetch(base + path, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
          ...(options.headers || {})
        }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || fallbackMessage);
      return data;
    };
  }

  return Object.freeze({ createApiClient });
});
