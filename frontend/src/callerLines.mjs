// The lines an owner can call and text from in a workspace, for the caller ID
// picker in the phone status menu. Iron Wing also has the legacy number from
// the server environment, which is in use while no line is chosen.
export function callerLines({
  workspaceId,
  ironWingId,
  legacyPhone,
  connections,
}) {
  const numbers = (connections || [])
    .flatMap((connection) => connection.numbers || [])
    .filter((number) => number.voice_enabled);
  const lines = numbers.map((number) => ({
    value: number.id,
    phone: number.phone_number,
    text: number.label
      ? `${number.label} · ${number.phone_number}`
      : number.phone_number,
    active: number.active === true,
  }));
  if (workspaceId === ironWingId && legacyPhone)
    lines.unshift({
      value: "legacy",
      phone: legacyPhone,
      text: legacyPhone,
      active: !lines.some((line) => line.active),
    });
  return lines;
}
