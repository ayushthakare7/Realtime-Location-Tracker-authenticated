// Backwards-compatible facade for existing imports.
module.exports = { ...require("./safetyJourneyLifecycleController"), ...require("./safetyNotificationController") };
