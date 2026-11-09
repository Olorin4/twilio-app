export function formatCallDate(value, timeZone, now = new Date()) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime()))
    return "Date and time unavailable";
  const parts = (value) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .formatToParts(value)
        .map(({ type, value }) => [type, value]),
    );
  const dayNumber = (value) => {
    const { year, month, day } = parts(value);
    return Date.UTC(Number(year), Number(month) - 1, Number(day)) / 86400000;
  };
  const difference = dayNumber(now) - dayNumber(date);
  if (difference === 0 || difference === 1) {
    const time = date.toLocaleTimeString([], {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    });
    return `${difference === 0 ? "Today" : "Yesterday"}, ${time}`;
  }
  return date.toLocaleString([], {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
