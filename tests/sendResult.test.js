const fs = require("fs");
const vm = require("vm");
const path = require("path");
const source = fs
  .readFileSync(path.join(__dirname, "../frontend/src/sendResult.mjs"), "utf8")
  .replace(/export (async function|function|const)/g, "$1");
const { readSendResult } = vm.runInNewContext(
  `${source}\n({ readSendResult })`,
);

const reply = (ok, status, body) => ({
  ok,
  status,
  json: async () => {
    if (typeof body === "string") throw new SyntaxError("Unexpected token '<'");
    return body;
  },
});

test("an accepted send returns its data", async () => {
  expect(await readSendResult(reply(true, 202, { sid: "SM1" }))).toEqual({
    sid: "SM1",
  });
});
test("a refused send shows the server's reason", async () => {
  await expect(
    readSendResult(
      reply(false, 422, {
        error: "Twilio rejected the message (error 21612).",
      }),
    ),
  ).rejects.toThrow("Twilio rejected the message (error 21612).");
});
test("a refusal without a reason uses the fallback", async () => {
  await expect(readSendResult(reply(false, 400, {}))).rejects.toThrow(
    "Could not send the message.",
  );
});
test("an HTML page from a proxy is reported plainly, not as a JSON error", async () => {
  await expect(
    readSendResult(reply(false, 502, "<!DOCTYPE html>")),
  ).rejects.toThrow(
    "Could not confirm whether the message was sent (HTTP 502). Check Twilio before retrying.",
  );
});
