// Props for a field that holds a password someone else will use (the Users
// screen). Chromium's built-in password manager treats a username field next
// to new-password fields as a sign-up form, and in Brave that crashed the
// whole browser as focus left the username field. Where the browser can mask
// ordinary text (Chromium, Safari), the field is a masked text field, which
// password managers ignore; elsewhere (Firefox) it stays a password field.

export function canMaskText(css) {
  return Boolean(
    css &&
      typeof css.supports === "function" &&
      css.supports("-webkit-text-security", "disc"),
  );
}

export function secretFieldProps(canMask) {
  const common = {
    autoCapitalize: "off",
    autoCorrect: "off",
    spellCheck: false,
  };
  return canMask
    ? {
        type: "text",
        autoComplete: "off",
        ...common,
        style: { WebkitTextSecurity: "disc" },
      }
    : { type: "password", autoComplete: "new-password", ...common };
}
