const { EventEmitter } = require("events");
const events = new EventEmitter();
events.setMaxListeners(0);
function publish() {
  events.emit("change");
}
function stream(req, res) {
  res
    .status(200)
    .set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
  res.flushHeaders();
  res.write("event: ready\ndata: {}\n\n");
  const changed = () => res.write("event: messages\ndata: {}\n\n");
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25000);
  events.on("change", changed);
  req.on("close", () => {
    clearInterval(heartbeat);
    events.off("change", changed);
  });
}
module.exports = { publish, stream };
