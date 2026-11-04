jest.mock("../src/db", () => ({ query: jest.fn() }));
const { validate } = require("../src/contacts");

test("normalizes a phone number and trims contact fields", () => {
  expect(
    validate({
      name: "  Alex Driver  ",
      phone: "+1 (555) 123-4567",
      company: "  Carrier  ",
    }).values,
  ).toEqual({
    name: "Alex Driver",
    phone: "+15551234567",
    company: "Carrier",
    email: "",
    notes: "",
  });
});

test.each([
  [{ name: "", phone: "+15551234567" }, "Name is required."],
  [
    { name: "Alex", phone: "5551234567" },
    "Enter a phone number with its country code, such as +15551234567.",
  ],
  [
    { name: "Alex", phone: "+15551234567", email: "invalid" },
    "Enter a valid email address.",
  ],
  [{ name: "Alex", phone: { value: "+15551234567" } }, "Invalid phone."],
])("rejects invalid contact input", (input, message) => {
  expect(validate(input).error).toBe(message);
});
