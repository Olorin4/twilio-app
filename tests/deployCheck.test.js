const { checkDeployReadiness } = require("../src/deployCheck");

// A fake database that answers the checker's queries from a description of
// the schema and data it should report.
function fakeDb({
  handler = true,
  agentProfiles = true,
  jack = true,
  users = true,
  personal = true,
  repairable = 0,
  fail = false,
} = {}) {
  return {
    query: jest.fn(async (sql) => {
      if (fail)
        throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), {
          code: "ECONNREFUSED",
        });
      if (sql.includes("information_schema"))
        return {
          rows: [
            {
              handler_column: handler,
              agent_profiles_table: agentProfiles,
              users_table: users,
              personal_column: personal,
            },
          ],
        };
      if (sql.includes("FROM agent_profiles"))
        return { rows: [{ jack_imported: jack }] };
      if (sql.includes("FROM phone_call_sessions"))
        return { rows: [{ repairable: String(repairable) }] };
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
}
const goodEnv = { TRUST_PROXY: "1", TWILIO_IDENTITY: "iron_wing_operator" };

test("a fully migrated and configured production is ready", async () => {
  expect(await checkDeployReadiness(fakeDb(), goodEnv)).toEqual({
    ok: true,
    problems: [],
  });
});

test.each([
  [
    { handler: false },
    "Migration 013 has not run: connection_numbers.handler is missing (npm run migrate:agent-profiles).",
  ],
  [
    { agentProfiles: false },
    "Migration 013 has not run: the agent_profiles table is missing (npm run migrate:agent-profiles).",
  ],
  [
    { jack: false },
    "Jack has not been imported: Iron Wing has no default agent profile (npm run seed:agent-profiles).",
  ],
  [
    { users: false },
    "Migration 014 has not run: the app_users table is missing (npm run migrate:users).",
  ],
  [
    { personal: false },
    "Migration 014 has not run: connection_numbers.personal is missing (npm run migrate:users).",
  ],
  [
    { repairable: 3 },
    "Migration 015 has not run: 3 Live Assist sessions still hold a softphone identity (npm run migrate:session-lines).",
  ],
])("reports %o", async (state, problem) => {
  const result = await checkDeployReadiness(fakeDb(state), goodEnv);
  expect(result.ok).toBe(false);
  expect(result.problems).toEqual([problem]);
});

test("does not query agent profiles before the table exists", async () => {
  const db = fakeDb({ agentProfiles: false, jack: false });
  const { problems } = await checkDeployReadiness(db, goodEnv);
  expect(problems).toHaveLength(1);
  expect(
    db.query.mock.calls.some(([sql]) => sql.includes("FROM agent_profiles")),
  ).toBe(false);
});

test.each([
  [
    { TWILIO_IDENTITY: "iron_wing_operator" },
    "TRUST_PROXY is not set: production runs behind the edge nginx and needs TRUST_PROXY=1.",
  ],
  [
    { TRUST_PROXY: "0", TWILIO_IDENTITY: "iron_wing_operator" },
    "TRUST_PROXY is not set: production runs behind the edge nginx and needs TRUST_PROXY=1.",
  ],
  [
    { TRUST_PROXY: "true", TWILIO_IDENTITY: "iron_wing_operator" },
    "TRUST_PROXY=true would let clients forge their address; set it to the number of proxies in front of the app (usually 1).",
  ],
  [
    { TRUST_PROXY: "1" },
    "TWILIO_IDENTITY is not set: production needs a fixed identity for the legacy number.",
  ],
])("reports environment %o", async (env, problem) => {
  const result = await checkDeployReadiness(fakeDb(), env);
  expect(result.ok).toBe(false);
  expect(result.problems).toEqual([problem]);
});

test("lists every problem at once", async () => {
  const result = await checkDeployReadiness(
    fakeDb({ users: false, personal: false, repairable: 1 }),
    {},
  );
  expect(result.problems).toHaveLength(5);
});

test("a database that cannot be read is not ready, naming no host", async () => {
  const result = await checkDeployReadiness(fakeDb({ fail: true }), goodEnv);
  expect(JSON.stringify(result)).not.toContain("10.0.0.5");
  expect(result).toEqual({
    ok: false,
    problems: ["Could not read the database (ECONNREFUSED)."],
  });
});
