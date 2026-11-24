jest.mock("../src/token", () => ({ callerID: "+15550001111", client: {} }));
const token = require("../src/token");
const create = jest.fn();
const fetchFax = jest.fn();
token.client.fax = {
  faxes: Object.assign(
    jest.fn(() => ({ fetch: fetchFax })),
    { create },
  ),
};
const { sendFax, getFaxStatus } = require("../src/sendFax");

const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});
const body = { to: "+15552223333", mediaUrl: "https://example.test/doc.pdf" };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  create.mockResolvedValue({ sid: "FX1" });
  fetchFax.mockResolvedValue({ status: "delivered" });
});

test("an owner can fax from the legacy number", async () => {
  const res = response();
  await sendFax({ user: { id: "x", role: "owner" }, body }, res);
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ from: "+15550001111", to: body.to }),
  );
  expect(res.json).toHaveBeenCalledWith({ success: true, faxSid: "FX1" });
  const status = response();
  await getFaxStatus(
    { user: { role: "owner" }, params: { faxSid: "FX1" } },
    status,
  );
  expect(status.json).toHaveBeenCalledWith({
    success: true,
    status: "delivered",
  });
});

test("a member, or nobody, can't fax from the legacy number", async () => {
  for (const user of [{ id: "y", role: "member" }, undefined]) {
    const res = response();
    await sendFax({ user, body }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Only an owner can use this line.",
    });
    const status = response();
    await getFaxStatus({ user, params: { faxSid: "FX1" } }, status);
    expect(status.status).toHaveBeenCalledWith(403);
  }
  expect(create).not.toHaveBeenCalled();
  expect(fetchFax).not.toHaveBeenCalled();
});
