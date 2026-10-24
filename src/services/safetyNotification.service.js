const SafetyNotification = require("../models/SafetyNotification");

async function queueNotification({ recipientId, journeyId, type, title, body, payload = {}, notificationKey }) {
  if (!recipientId || !journeyId || !notificationKey) return null;
  const notification = await SafetyNotification.findOneAndUpdate(
    { notificationKey },
    {
      $setOnInsert: {
        notificationKey,
        recipientId,
        journeyId,
        type,
        title,
        body,
        payload
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return notification;
}

async function notifyJourneyRecipients({ io, journey, type, title, body, recipients, payload = {}, keySuffix }) {
  const ids = [...new Set((recipients || []).map(id => String(id)))];
  const notifications = [];
  for (const recipientId of ids) {
    const notification = await queueNotification({
      recipientId,
      journeyId: journey._id,
      type,
      title,
      body,
      payload,
      notificationKey: String(journey._id) + ":" + keySuffix + ":" + recipientId
    });
    if (notification) {
      notifications.push(notification);
      io?.to("user:" + recipientId).emit("safety-notification", {
        id: String(notification._id),
        type: notification.type,
        title: notification.title,
        body: notification.body,
        payload: notification.payload,
        createdAt: notification.createdAt,
        readAt: notification.readAt
      });
    }
  }
  return notifications;
}

module.exports = { notifyJourneyRecipients, queueNotification };
