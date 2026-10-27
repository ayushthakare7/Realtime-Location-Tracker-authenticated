// Backwards-compatible facade for existing imports. Keep route/API behavior unchanged.
module.exports = { ...require("./friendshipController"), ...require("./historyController"), ...require("./mapAssistantController") };
