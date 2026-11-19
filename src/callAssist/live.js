const { EventEmitter } = require("node:events");

const events = new EventEmitter();
events.setMaxListeners(0);

// Keep only the latest caption per speaker for an active drawer. Draft text
// is never part of the saved transcript or the model's input.
const sessions = new Map();
function publishCaption(id, caption) {
  let session = sessions.get(id);
  if (!session) {
    session = { captions: {}, expiry: null };
    sessions.set(id, session);
  }
  const previous = session.captions[caption.speaker];
  if (previous && previous.sequence >= caption.sequence) return;
  session.captions[caption.speaker] = caption;
  clearTimeout(session.expiry);
  session.expiry = setTimeout(() => clearCaptions(id), 60_000);
  session.expiry.unref();
  events.emit(id);
}

function clearCaptions(id) {
  clearTimeout(sessions.get(id)?.expiry);
  sessions.delete(id);
}

function readCaptions(id) {
  return Object.values(sessions.get(id)?.captions || {});
}

module.exports = { events, publishCaption, clearCaptions, readCaptions };
