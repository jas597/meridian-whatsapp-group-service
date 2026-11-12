// Read group IDs/titles without serializing every chat's last message.
// whatsapp-web.js uses WAWebCollections now; window.Store is only present
// on older web clients. getChats() can fail for the entire directory when
// one unrelated chat has an incompatible message key.
function readPageGroupDirectory() {
  let collections;
  try {
    if (typeof window.require === "function") collections = window.require("WAWebCollections");
  } catch { /* Older web clients expose Store instead. */ }
  const chats = collections?.Chat || window.Store?.Chat;
  if (!chats || typeof chats.getModelsArray !== "function") {
    throw new Error("WhatsApp chat directory is not available.");
  }
  const models = chats.getModelsArray();
  if (!Array.isArray(models)) throw new Error("Invalid WhatsApp chat directory.");
  const groups = new Map();
  for (const chat of models) {
    try {
      const wid = chat?.id;
      const id = typeof wid === "string" ? wid
        : wid?._serialized || wid?.$1 || (wid?.user && wid?.server ? `${wid.user}@${wid.server}` : "");
      if (typeof id !== "string" || !id.endsWith("@g.us")) continue;
      const name = [chat.name, chat.formattedTitle, chat.groupMetadata?.subject]
        .find(value => typeof value === "string" && value.trim()) || "";
      groups.set(id, { id: { _serialized: id }, isGroup: true, name });
    } catch { /* An unreadable individual chat must not hide other groups. */ }
  }
  return [...groups.values()];
}

async function readGroupDirectory(client, logger) {
  let groups;
  if (client.pupPage) {
    try {
      groups = await client.pupPage.evaluate(readPageGroupDirectory);
      if (!Array.isArray(groups)) throw new Error("Invalid group directory response.");
    } catch {
      logger.warn("WhatsApp group directory lookup failed; trying the library directory");
    }
  }
  if (!groups) {
    try {
      const chats = await client.getChats();
      if (!Array.isArray(chats)) throw new Error("Invalid chat response.");
      groups = chats.filter(chat => chat?.isGroup === true
        && typeof chat.id?._serialized === "string" && chat.id._serialized.endsWith("@g.us"))
        .map(chat => ({ id: { _serialized: chat.id._serialized }, isGroup: true, name: chat.name || "" }));
    } catch {
      const error = new Error("WhatsApp groups could not be loaded. Try checking the connection again shortly.");
      error.statusCode = 503;
      throw error;
    }
  }
  // Counts only: don't put the account's group names or IDs in diagnostics.
  logger.info({ groupCount: groups.length,
    leavePlanningMatches: groups.filter(g => String(g.name).replace(/\s+/g, " ").trim().toLowerCase() === "leave planning").length,
  }, "WhatsApp group directory loaded");
  return groups;
}

module.exports = { readGroupDirectory };
