function ownsMessage(message, numbers) {
  if (message.direction === "inbound") return numbers.includes(message.to);
  if (
    typeof message.direction === "string" &&
    message.direction.startsWith("outbound")
  )
    return numbers.includes(message.from);
  return false;
}
function ownsRootCall(call, numbers, identity) {
  if (call.parentCallSid) return false;
  if (identity && call.from === `client:${identity}`) return true;
  if (call.direction === "inbound") return numbers.includes(call.to);
  if (
    typeof call.direction === "string" &&
    call.direction.startsWith("outbound")
  )
    return numbers.includes(call.from);
  return false;
}
module.exports = { ownsMessage, ownsRootCall };
