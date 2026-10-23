const User = require("../models/User");
const Friendship = require("../models/Friendship");

const DISTANCE_INTENT = /\b(distance|far|apart|kilomet(?:er|re)s?|miles?|how long|travel time|drive|driving)\b/i;

function findNameOccurrences(question, names) {
  const text = String(question || "").toLocaleLowerCase("en");
  return names
    .filter(name => name && text.includes(name.toLocaleLowerCase("en")))
    .sort((a, b) => text.indexOf(a.toLocaleLowerCase("en")) - text.indexOf(b.toLocaleLowerCase("en")));
}

/**
 * Recognize person-to-person distance questions using the actual authorized
 * users' usernames, rather than a fixed list of sample question phrasings.
 * The LLM remains the general-purpose parser for other intents and wording.
 */
async function inferPersonDistanceIntent(question, currentUserId) {
  if (!DISTANCE_INTENT.test(question)) return null;

  const friendships = await Friendship.find({
    status: "accepted",
    $or: [{ requester: currentUserId }, { recipient: currentUserId }]
  }).select("requester recipient").lean();

  const friendIds = friendships.map(item =>
    String(item.requester) === String(currentUserId) ? item.recipient : item.requester
  );

  if (friendIds.length < 2) return null;

  const friends = await User.find({ _id: { $in: friendIds } })
    .select("_id username")
    .lean();

  const matches = findNameOccurrences(question, friends.map(user => user.username));
  const distinct = [];
  for (const name of matches) {
    const user = friends.find(item => item.username.toLocaleLowerCase("en") === name.toLocaleLowerCase("en"));
    if (user && !distinct.some(item => String(item._id) === String(user._id))) distinct.push(user);
  }

  if (distinct.length < 2) return null;

  return {
    intent: "distance",
    origin: "friend",
    originPerson: distinct[0].username,
    destination: distinct[1].username,
    destinationType: "person"
  };
}

module.exports = { inferPersonDistanceIntent };
