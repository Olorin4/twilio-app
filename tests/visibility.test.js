/* lineScope: which lines' history a person may see in a workspace, read in
one query. lineCondition: the SQL filter built from it. */
process.env.TWILIO_CALLER_ID = "+12025550000";
process.env.TWILIO_PREVIOUS_NUMBERS = "+12025550009";
jest.mock("../src/db", () => ({ query: jest.fn() }));
jest.mock("../src/token", () => ({ getIdentity: () => "operator" }));
const pool = require("../src/db");
const { lineScope, lineCondition, canSee } = require("../src/visibility");

const IRON_WING = "00000000-0000-4000-8000-000000000001";
const OTHER_WS = "00000000-0000-4000-8000-000000000002";
const CONN = "00000000-0000-4000-8000-0000000000c1";
const OWNER = "00000000-0000-4000-8000-0000000000b1";
const MEMBER = "00000000-0000-4000-8000-0000000000b2";
const OWNER2 = "00000000-0000-4000-8000-0000000000b3";
const hex = (id) => id.replace(/-/g, "");
const owner = { id: OWNER, role: "owner" };
const member = { id: MEMBER, role: "member", workspaceIds: [IRON_WING] };
const bootstrap = { id: null, role: "owner", bootstrap: true };

const SHARED = "+12025550100";
const AI = "+12025550101";
const UNASSIGNED = "+12025550102";
const PERSONAL = "+12025550199";
const line = (phone, extra = {}) => ({
  phone_number: phone,
  personal: false,
  handler: "softphone",
  connection_id: CONN,
  assignees: [],
  staffed: false,
  ...extra,
});
const lines = () => [
  line(SHARED, { assignees: [MEMBER], staffed: true }),
  line(AI, { handler: "ai_agent" }),
  line(UNASSIGNED),
  line(PERSONAL, { personal: true, assignees: [OWNER], staffed: true }),
];

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockResolvedValue({ rows: lines() });
});

test("an owner sees every shared line; the personal line is theirs", async () => {
  const scope = await lineScope(owner, IRON_WING);
  expect(pool.query).toHaveBeenCalledTimes(1);
  expect(pool.query.mock.calls[0][1]).toEqual([IRON_WING]);
  expect(scope).toMatchObject({
    all: true,
    hidden: [],
    clientPrefix: `client:u${hex(OWNER)}_`,
  });
  expect(scope.numbers).toEqual(
    expect.arrayContaining([SHARED, AI, UNASSIGNED, PERSONAL, "+12025550000"]),
  );
});

test("another owner does not see the first owner's personal line", async () => {
  const scope = await lineScope({ id: OWNER2, role: "owner" }, IRON_WING);
  expect(scope.all).toBe(true);
  expect(scope.hidden).toEqual([PERSONAL]);
  // Calls the first owner placed from it are private too.
  expect(scope.hiddenClients).toEqual([`client:u${hex(OWNER)}_c${hex(CONN)}`]);
  expect(canSee(scope, PERSONAL)).toBe(false);
  expect(canSee(scope, SHARED)).toBe(true);
});

test("a member of Iron Wing sees assigned and AI lines, and the legacy number", async () => {
  const scope = await lineScope(member, IRON_WING);
  expect(scope).toMatchObject({
    all: false,
    clientPrefix: `client:u${hex(MEMBER)}_`,
  });
  expect(scope.visible.sort()).toEqual(
    [SHARED, AI, "+12025550000", "+12025550009"].sort(),
  );
  expect(scope.visible).not.toContain(PERSONAL);
  expect(scope.visible).not.toContain(UNASSIGNED);
  expect(scope.numbers).toEqual(scope.visible);
  expect(canSee(scope, PERSONAL)).toBe(false);
});

test("a member outside Iron Wing gets no legacy number", async () => {
  const scope = await lineScope(
    { id: MEMBER, role: "member", workspaceIds: [OTHER_WS] },
    OTHER_WS,
  );
  expect(scope.visible.sort()).toEqual([SHARED, AI].sort());
});

test("the bootstrap login is an owner with no identity prefix", async () => {
  const scope = await lineScope(bootstrap, IRON_WING);
  expect(scope).toMatchObject({ all: true, clientPrefix: null });
  expect(scope.hidden).toEqual([PERSONAL]);
});

test("a personal line nobody can answer is visible to owners, not members", async () => {
  pool.query.mockResolvedValue({
    rows: [line(PERSONAL, { personal: true, assignees: [OWNER2] })],
  });
  expect((await lineScope(owner, IRON_WING)).hidden).toEqual([]);
  expect((await lineScope(member, IRON_WING)).visible).not.toContain(PERSONAL);
});

test("a user with a shared line on the connection keeps their calls visible", async () => {
  pool.query.mockResolvedValue({
    rows: [
      line(PERSONAL, { personal: true, assignees: [MEMBER], staffed: true }),
      line(SHARED, { assignees: [MEMBER], staffed: true }),
    ],
  });
  const scope = await lineScope(owner, IRON_WING);
  expect(scope.hidden).toEqual([PERSONAL]);
  expect(scope.hiddenClients).toEqual([]);
});

test("no signed-in user sees nothing", async () => {
  const scope = await lineScope(undefined, IRON_WING);
  expect(scope).toMatchObject({ all: false, visible: [], clientPrefix: null });
  expect(pool.query).not.toHaveBeenCalled();
});

test("history on a released number is visible to owners only", async () => {
  const released = "+12025550777";
  const ownerScope = await lineScope(owner, IRON_WING);
  const memberScope = await lineScope(member, IRON_WING);
  // Owners filter by what is hidden, so a number with no row passes.
  expect(ownerScope.hidden).not.toContain(released);
  expect(canSee(ownerScope, released)).toBe(true);
  // Members filter by what is visible, so it does not.
  expect(memberScope.visible).not.toContain(released);
  expect(canSee(memberScope, released)).toBe(false);
});

test("lineCondition builds an owner filter on hidden lines and others' private calls", async () => {
  const scope = await lineScope({ id: OWNER2, role: "owner" }, IRON_WING);
  const { sql, params } = lineCondition(scope, "LINE", "FROM", 6);
  expect(sql).toContain("$6::text[]");
  expect(sql).toContain("$7::text[]");
  expect(sql).toMatch(/NOT \(COALESCE\(LINE, ''\) = ANY\(\$7::text\[\]\)\)/);
  expect(params).toEqual([[`client:u${hex(OWNER)}_c${hex(CONN)}`], [PERSONAL]]);
});

test("lineCondition builds a member filter on visible lines and their own calls", async () => {
  const scope = await lineScope(member, IRON_WING);
  const { sql, params } = lineCondition(scope, "LINE", "FROM", 3);
  expect(sql).toMatch(/COALESCE\(LINE, ''\) = ANY\(\$4::text\[\]\)/);
  expect(sql).toContain(
    "left(COALESCE(FROM, ''), length($3::text)) = $3::text",
  );
  expect(params[0]).toBe(`client:u${hex(MEMBER)}_`);
  expect(params[1]).not.toContain(PERSONAL);
});

/* Softphone calls (from client:<identity>) are judged by the line they used
when the caller passes that line's SQL (clientLineExpr): the member's own call
always shows; otherwise a known line follows the normal rule, and an unknown
one (NULL) the old client: rule. The semantics run in users.pg.test.js. */
const CLIENT_LINE = "(SELECT child.from_number)";
const known = `(${CLIENT_LINE}) IS NOT NULL`;

test("owner B sees owner A's softphone call placed from a shared line", async () => {
  // A's only line on the connection is personal, so A's identity is hidden...
  const scope = await lineScope({ id: OWNER2, role: "owner" }, IRON_WING);
  expect(scope.hiddenClients).toEqual([`client:u${hex(OWNER)}_c${hex(CONN)}`]);
  const { sql, params } = lineCondition(scope, "LINE", "FROM", 6, CLIENT_LINE);
  // ...but a call whose line is known is judged by that line, not the caller.
  expect(sql).toContain(
    `WHEN ${known} THEN NOT ((${CLIENT_LINE}) = ANY($7::text[]))`,
  );
  expect(params).toEqual([[`client:u${hex(OWNER)}_c${hex(CONN)}`], [PERSONAL]]);
  expect(params[1]).not.toContain(SHARED);
});

test("owner B does not see owner A's softphone call placed from A's personal line", async () => {
  const scope = await lineScope({ id: OWNER2, role: "owner" }, IRON_WING);
  const { sql, params } = lineCondition(scope, "LINE", "FROM", 6, CLIENT_LINE);
  expect(params[1]).toContain(PERSONAL);
  // With no known line, the old rule on the caller's identity applies.
  expect(sql).toContain("ELSE NOT (COALESCE(FROM, '') = ANY($6::text[])) END");
});

test("an Iron Wing member sees the owner's softphone call on the legacy line", async () => {
  const scope = await lineScope(member, IRON_WING);
  const { sql, params } = lineCondition(scope, "LINE", "FROM", 3, CLIENT_LINE);
  expect(params[1]).toContain("+12025550000");
  expect(sql).toContain(`OR (${known} AND (${CLIENT_LINE}) = ANY($4::text[]))`);
  // Their own call still shows whatever line it used.
  expect(sql).toContain(
    "$3::text IS NOT NULL AND left(COALESCE(FROM, ''), length($3::text)) = $3::text",
  );
});

test("a member does not see an owner's softphone call from a line hidden from them", async () => {
  const scope = await lineScope(member, IRON_WING);
  const { sql, params } = lineCondition(scope, "LINE", "FROM", 3, CLIENT_LINE);
  expect(params).toHaveLength(2);
  expect(params[1]).not.toContain(PERSONAL);
  // Only membership of the visible lines lets another user's call through.
  expect(sql.match(/\$4::text\[\]/g)).toHaveLength(2);
});

test("callers without clientLineExpr behave exactly as before", () => {
  const ownerScope = { all: true, hidden: ["H"], hiddenClients: ["C"] };
  const memberScope = { all: false, visible: ["V"], clientPrefix: "P" };
  const ownerBefore = {
    sql: "(CASE WHEN COALESCE(FROM, '') LIKE 'client:%' THEN NOT (COALESCE(FROM, '') = ANY($6::text[]))\n        ELSE NOT (COALESCE(LINE, '') = ANY($7::text[])) END)",
    params: [["C"], ["H"]],
  };
  const memberBefore = {
    sql: "(CASE WHEN COALESCE(FROM, '') LIKE 'client:%'\n        THEN $3::text IS NOT NULL AND left(COALESCE(FROM, ''), length($3::text)) = $3::text\n        ELSE COALESCE(LINE, '') = ANY($4::text[]) END)",
    params: ["P", ["V"]],
  };
  expect(lineCondition(ownerScope, "LINE", "FROM", 6)).toEqual(ownerBefore);
  expect(lineCondition(ownerScope, "LINE", "FROM", 6, null)).toEqual(
    ownerBefore,
  );
  expect(lineCondition(memberScope, "LINE", "FROM", 3)).toEqual(memberBefore);
  expect(lineCondition(memberScope, "LINE", "FROM", 3, null)).toEqual(
    memberBefore,
  );
});
