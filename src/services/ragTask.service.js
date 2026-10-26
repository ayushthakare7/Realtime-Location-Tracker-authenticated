const { randomUUID } = require("crypto");

const tasks = new Map();
const TASK_TTL_MS = 10 * 60 * 1000;
const MAX_TASKS = 500;

function pruneTasks() {
  const now = Date.now();
  for (const [id, task] of tasks) {
    if (task.expiresAt <= now) tasks.delete(id);
  }
  while (tasks.size >= MAX_TASKS) {
    const oldestId = tasks.keys().next().value;
    if (!oldestId) break;
    tasks.delete(oldestId);
  }
}

function start(userId, work) {
  pruneTasks();
  const id = randomUUID();
  const task = {
    id,
    userId: String(userId),
    status: "pending",
    message: "Reva AI is waking up. This can take a few minutes after inactivity.",
    answer: null,
    expiresAt: Date.now() + TASK_TTL_MS
  };
  tasks.set(id, task);

  Promise.resolve()
    .then(() => {
      task.status = "running";
      return work();
    })
    .then(answer => {
      task.status = "completed";
      task.answer = String(answer || "I couldn't find enough information in the shared location history to answer that yet.");
      task.message = null;
      task.expiresAt = Date.now() + TASK_TTL_MS;
    })
    .catch(error => {
      console.error("[Reva RAG task] Failed:", error && (error.stack || error.message || error));
      task.status = "failed";
      task.answer = null;
      task.message = error?.code === "RAG_WAKE_TIMEOUT"
        ? "Reva AI is taking longer than expected to wake up. Please try again in a moment."
        : "Reva couldn't answer right now. Please try again.";
      task.expiresAt = Date.now() + TASK_TTL_MS;
    });

  return { id, status: task.status };
}

function getForUser(userId, id) {
  const task = tasks.get(String(id));
  if (!task || task.expiresAt <= Date.now() || task.userId !== String(userId)) {
    if (task && task.expiresAt <= Date.now()) tasks.delete(String(id));
    return null;
  }
  return {
    status: task.status,
    message: task.message,
    ...(task.status === "completed" ? { answer: task.answer } : {})
  };
}

module.exports = { start, getForUser };
