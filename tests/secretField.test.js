const fs = require("fs");
const vm = require("vm");
const path = require("path");
// The .mjs helper is plain functions; load it the way leadCard.test.js does.
const loadModule = async () => {
  const source = fs
    .readFileSync(
      path.join(__dirname, "../frontend/src/secretField.mjs"),
      "utf8",
    )
    .replace(/export (function|const)/g, "$1");
  return vm.runInNewContext(`${source}\n({ secretFieldProps, canMaskText })`);
};

test("where text can be masked, a secret is a masked text field the password manager ignores", async () => {
  const { secretFieldProps } = await loadModule();
  expect(JSON.parse(JSON.stringify(secretFieldProps(true)))).toEqual({
    type: "text",
    autoComplete: "off",
    autoCapitalize: "off",
    autoCorrect: "off",
    spellCheck: false,
    style: { WebkitTextSecurity: "disc" },
  });
});

test("where it cannot (Firefox), it stays a password field", async () => {
  const { secretFieldProps } = await loadModule();
  expect(JSON.parse(JSON.stringify(secretFieldProps(false)))).toEqual({
    type: "password",
    autoComplete: "new-password",
    autoCapitalize: "off",
    autoCorrect: "off",
    spellCheck: false,
  });
});

test("canMaskText follows CSS.supports and is false without it", async () => {
  const { canMaskText } = await loadModule();
  expect(canMaskText({ supports: () => true })).toBe(true);
  expect(canMaskText({ supports: () => false })).toBe(false);
  expect(canMaskText(undefined)).toBe(false);
  expect(canMaskText({})).toBe(false);
});
