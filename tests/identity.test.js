jest.mock("../src/token", () => ({ getIdentity: () => "operator" }));
const { identityFor, parseIdentity, isClientOf } = require("../src/identity");

const userA = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  role: "member",
  bootstrap: false,
};
const userB = {
  id: "bbbbbbbb-2222-4222-8222-222222222222",
  role: "owner",
  bootstrap: false,
};
const bootstrap = {
  id: null,
  username: "operator",
  role: "owner",
  bootstrap: true,
  workspaceIds: [],
};
const connection = { id: "cccccccc-3333-4333-8333-333333333333" };
const otherConnection = { id: "dddddddd-4444-4444-8444-444444444444" };
const legacy = { legacy: true };
const hexA = "aaaaaaaa111141118111111111111111";
const hexC = "cccccccc333343338333333333333333";

describe("identityFor", () => {
  test("formats a user on a connection, a user on legacy and the bootstrap user", () => {
    const cases = [
      [identityFor(userA, connection), `u${hexA}_c${hexC}`],
      [identityFor(userA, legacy), `u${hexA}_legacy`],
      [identityFor(bootstrap, connection), `connection_${hexC}`],
      [identityFor(bootstrap, legacy), "operator"],
    ];
    for (const [actual, expected] of cases) {
      expect(actual).toBe(expected);
      expect(actual.length).toBeLessThanOrEqual(121);
    }
  });
  test("refuses a missing user or a real user without an id", () => {
    expect(() => identityFor(null, connection)).toThrow();
    expect(() => identityFor({ role: "owner" }, connection)).toThrow();
  });
});

describe("parseIdentity", () => {
  test("round-trips each format, with or without the client: prefix", () => {
    expect(parseIdentity(identityFor(userA, connection))).toEqual({
      userId: userA.id,
      connectionId: connection.id,
      legacy: false,
      bootstrap: false,
    });
    expect(parseIdentity(`client:${identityFor(userA, legacy)}`)).toEqual({
      userId: userA.id,
      connectionId: null,
      legacy: true,
      bootstrap: false,
    });
    expect(parseIdentity(identityFor(bootstrap, connection))).toEqual({
      userId: null,
      connectionId: connection.id,
      legacy: false,
      bootstrap: true,
    });
    expect(parseIdentity("client:operator")).toEqual({
      userId: null,
      connectionId: null,
      legacy: true,
      bootstrap: true,
    });
  });
  test("returns null for other names and malformed ids", () => {
    for (const bad of [
      "client:alice",
      "alice",
      "",
      null,
      undefined,
      42,
      `u${hexA.slice(1)}_c${hexC}`,
      `u${hexA}0_c${hexC}`,
      `u${hexA}_c${hexC.slice(2)}`,
      `u${hexA.toUpperCase()}_c${hexC}`,
      `u${hexA}_c${hexC}_x`,
      `u${hexA}_legacyx`,
      `connection_${hexC.slice(1)}`,
      `connection_${hexC}0`,
      `client:client:u${hexA}_legacy`,
    ])
      expect(parseIdentity(bad)).toBeNull();
  });
});

describe("isClientOf", () => {
  test("is true for any user or the bootstrap identity on the same connection", () => {
    expect(
      isClientOf(`client:${identityFor(userA, connection)}`, connection),
    ).toBe(true);
    expect(
      isClientOf(`client:${identityFor(userB, connection)}`, connection),
    ).toBe(true);
    expect(
      isClientOf(`client:${identityFor(bootstrap, connection)}`, connection),
    ).toBe(true);
  });
  test("is false for the same user on another connection or on legacy", () => {
    expect(
      isClientOf(`client:${identityFor(userA, otherConnection)}`, connection),
    ).toBe(false);
    expect(
      isClientOf(
        `client:${identityFor(bootstrap, otherConnection)}`,
        connection,
      ),
    ).toBe(false);
    expect(isClientOf(`client:${identityFor(userA, legacy)}`, connection)).toBe(
      false,
    );
    expect(isClientOf("client:operator", connection)).toBe(false);
  });
  test("legacy accepts any user's legacy identity and getIdentity()", () => {
    expect(isClientOf(`client:${identityFor(userA, legacy)}`, legacy)).toBe(
      true,
    );
    expect(isClientOf(`client:${identityFor(userB, legacy)}`, legacy)).toBe(
      true,
    );
    expect(isClientOf("client:operator", legacy)).toBe(true);
    expect(isClientOf(`client:${identityFor(userA, connection)}`, legacy)).toBe(
      false,
    );
    expect(
      isClientOf(`client:${identityFor(bootstrap, connection)}`, legacy),
    ).toBe(false);
  });
  test("rejects anything that is not a client: caller with a known format", () => {
    for (const from of [
      identityFor(userA, connection),
      "+15550000001",
      "client:alice",
      `client:u${hexA.slice(1)}_c${hexC}`,
      `client:u${hexA}_c${hexC}0`,
      undefined,
      null,
    ]) {
      expect(isClientOf(from, connection)).toBe(false);
      expect(isClientOf(from, legacy)).toBe(false);
    }
    expect(isClientOf(`client:${identityFor(userA, connection)}`, {})).toBe(
      false,
    );
    expect(isClientOf(`client:${identityFor(userA, connection)}`, null)).toBe(
      false,
    );
  });
});
