const DISTANCE_TERMS = /\b(distance|how far|far away|away from|separation|separate|closer|closest|nearest|nearer|nearby|road distance|driving distance|kilomet(?:er|re)s?|kms?|miles?|met(?:er|re)s?)\b/i;
const SELF_TERMS = /\b(me|myself|am i|i am|my location|where i am|where am i|from here|from my location|my current location)\b/i;
const FILLER = /\b(?:what(?:'s| is)?|how|many|much|far|is|are|the|distance|between|from|to|of|for|me|myself|my|i|am|where|here|location|current|right|now|please|calculate|work|out|tell|would|be|in|at|and|away|separate|separation|closer|closest|nearest|nearer|nearby|road|driving|kilometers?|kilometres?|kms?|miles?|meters?|metres?|compare|which|one|than|can|you|find|show|give|what)\b/gi;

function normalizeWords(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesWholeName(question, username) {
  const q = " " + normalizeWords(question) + " ";
  const name = " " + normalizeWords(username) + " ";
  return Boolean(name.trim()) && q.includes(name);
}

function cleanPlace(value, usernames = []) {
  let result = String(value || "");
  for (const username of usernames) {
    result = result.replace(new RegExp(username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
  }

  const cleaned = result
    .replace(FILLER, " ")
    .replace(/[?!,.;:()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Collapse an entire place phrase repeated while the user rephrases a question.
  // Examples: "Nagpur Nagpur" -> "Nagpur"; "New Delhi New Delhi" -> "New Delhi".
  const words = cleaned.split(" ").filter(Boolean);
  for (let phraseLength = 1; phraseLength <= Math.floor(words.length / 2); phraseLength++) {
    if (words.length % phraseLength !== 0) continue;
    const repeated = words.every((word, index) =>
      word.toLowerCase() === words[index % phraseLength].toLowerCase()
    );
    if (repeated) return words.slice(0, phraseLength).join(" ");
  }
  return cleaned;
}

/**
 * Produce a small, explicit plan for distance questions. This is intentionally
 * deterministic: an LLM may help with phrasing, but it never supplies coordinates
 * or bypasses the authorization checks performed by the execution layer.
 */
function planDistanceQuestion(question, friendUsernames = []) {
  const matched = [...new Set(friendUsernames.filter(name => includesWholeName(question, name)))]
    .sort((a, b) => question.toLowerCase().indexOf(a.toLowerCase()) - question.toLowerCase().indexOf(b.toLowerCase()));

  const selfMentioned = SELF_TERMS.test(question);

  const compareMatch = String(question).match(/\bwhich\b.*?\bcloser\s+to\s+([^,?]+)\s*,\s*(.+?)\s+or\s+(.+?)(?:[?.!]|$)/i);
  if (compareMatch) {
    const targetText = compareMatch[1].trim();
    let targetType = "place";
    let target = cleanPlace(targetText, matched);
    if (SELF_TERMS.test(targetText)) {
      targetType = "me";
      target = null;
    } else {
      const targetFriend = matched.find(name => includesWholeName(targetText, name));
      if (targetFriend) {
        targetType = "person";
        target = targetFriend;
      }
    }
    const firstPlace = cleanPlace(compareMatch[2]);
    const secondPlace = cleanPlace(compareMatch[3]);
    if (firstPlace && secondPlace) {
      return {
        intent: "compare_places",
        targetType,
        target,
        places: [firstPlace, secondPlace]
      };
    }
  }

  const ranking = /\b(closest|nearest|farthest|furthest)\b/i.exec(question);
  const asksForPerson = /\b(who|which friend|which person)\b/i.test(question);
  if (ranking && asksForPerson) {
    const relation = /farthest|furthest/i.test(ranking[1]) ? "farthest" : "closest";
    if (selfMentioned) {
      return { intent: "nearest_person", relation, targetType: "me", target: null };
    }
    if (matched.length) {
      return { intent: "nearest_person", relation, targetType: "person", target: matched[0] };
    }
    const targetMatch = String(question).match(/\b(?:to|from|near)\s+(.+?)(?:[?.!]|$)/i);
    if (targetMatch) {
      const targetPlace = cleanPlace(targetMatch[1]);
      if (targetPlace) return { intent: "nearest_person", relation, targetType: "place", target: targetPlace };
    }
  }

  if (!DISTANCE_TERMS.test(question)) return null;
  if (matched.length >= 2) {
    return {
      intent: "distance",
      origin: "friend",
      originPerson: matched[0],
      originType: "person",
      destination: matched[1],
      destinationType: "person"
    };
  }

  if (matched.length === 1) {
    const place = cleanPlace(question, matched);
    if (selfMentioned && !place) {
      return {
        intent: "distance", origin: "me", originPerson: null, originType: "person",
        destination: matched[0], destinationType: "person"
      };
    }
    if (place) {
      return {
        intent: "distance", origin: "friend", originPerson: matched[0], originType: "person",
        destination: place, destinationType: "place"
      };
    }
  }

  if (selfMentioned) {
    const place = cleanPlace(question);
    if (place) {
      return {
        intent: "distance", origin: "me", originPerson: null, originType: "person",
        destination: place, destinationType: "place"
      };
    }
  }

  // Place-to-place comparisons are independent of a user's current location.
  // Accept common natural-language patterns without guessing endpoints otherwise.
  const between = String(question).match(/\bbetween\s+(.+?)\s+and\s+(.+?)(?:[?.!]|$)/i);
  const fromTo = String(question).match(/\bfrom\s+(.+?)\s+to\s+(.+?)(?:[?.!]|$)/i);
  const fromIs = String(question).match(/\b(?:how far is|what is the distance from|distance from)\s+(.+?)\s+from\s+(.+?)(?:[?.!]|$)/i);
  let first = null;
  let second = null;
  if (between) {
    first = cleanPlace(between[1]);
    second = cleanPlace(between[2]);
  } else if (fromTo) {
    first = cleanPlace(fromTo[1]);
    second = cleanPlace(fromTo[2]);
  } else if (fromIs) {
    first = cleanPlace(fromIs[1]);
    second = cleanPlace(fromIs[2]);
  }

  if (first && second && first.toLowerCase() !== second.toLowerCase()) {
    return {
      intent: "distance",
      origin: "place",
      originPerson: null,
      originType: "place",
      originPlace: first,
      destination: second,
      destinationType: "place"
    };
  }

  return null;
}

module.exports = { planDistanceQuestion };
