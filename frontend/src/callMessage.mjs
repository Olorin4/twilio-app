const validNumber = (value) => /^\+[1-9]\d{1,14}$/.test(value || "");
const normalize = (value) => String(value || "").replace(/[\s().-]/g, "");

export function messageTargetForCall(phone, callLocalNumber, activeNumber) {
  const target = normalize(phone);
  const callLocal = normalize(callLocalNumber);
  const active = normalize(activeNumber);
  if (!validNumber(target)) return null;
  const localNumber = validNumber(callLocal) ? callLocal : active;
  if (!validNumber(localNumber)) return null;
  return { phone: target, localNumber };
}
