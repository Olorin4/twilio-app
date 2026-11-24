const { isClientOf } = require("./identity");
function ownsMessage(message, numbers) {
  if (message.direction === "inbound") return numbers.includes(message.to);
  if (
    typeof message.direction === "string" &&
    message.direction.startsWith("outbound")
  )
    return numbers.includes(message.from);
  return false;
}
// `provider` is the line being synchronized; any softphone identity of it
// (src/identity.js) owns the calls it places.
function ownsRootCall(call, numbers, provider) {
  if (call.parentCallSid) return false;
  if (isClientOf(call.from, provider)) return true;
  if (call.direction === "inbound") return numbers.includes(call.to);
  if (
    typeof call.direction === "string" &&
    call.direction.startsWith("outbound")
  )
    return numbers.includes(call.from);
  return false;
}
module.exports = { ownsMessage, ownsRootCall };
