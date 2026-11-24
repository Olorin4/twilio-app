/* The WebSocket endpoint Twilio ConversationRelay connects to for a call the
AI receptionist is answering.

Express middleware does not run on WebSocket upgrades, so this endpoint does
its own two checks: Twilio's signature on the upgrade request, and a
single-use token that the (signature-checked) voice webhook issued for
exactly this call. */

const twilio = require("twilio");
const { WebSocketServer, WebSocket } = require("ws");
const { getConfig } = require("./config");

const WS_PATH = /^\/(?:webhooks\/([0-9a-f-]{36})\/)?receptionist\/ws$/i;
const POLICY_VIOLATION = 1008;
const INTERNAL_ERROR = 1011;

// Twilio signs the upgrade request with the account's auth token. Its docs
// say to validate against "the request URL" without saying whether that is
// the wss:// or https:// form, so either is accepted; both need the secret.
async function validateSignature(req, connectionId) {
  const baseUrl = process.env.TWILIO_WEBHOOK_BASE_URL;
  const signature = req.headers["x-twilio-signature"];
  if (!baseUrl || typeof signature !== "string" || !signature) return false;
  const authToken = connectionId
    ? (await require("../connectionWebhooks").loadConnectionAuth(connectionId))
        ?.authToken
    : process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return false;
  const https = baseUrl.replace(/\/$/, "") + req.url;
  return [https.replace(/^http/i, "ws"), https].some((url) =>
    twilio.validateRequest(authToken, signature, url, {}),
  );
}

// Stands in when the Anthropic client cannot be created (no API key, say):
// every turn fails, so the caller hears the fallback line and gets a
// callback promise instead of silence.
const failingAgent = {
  prewarm: async () => {},
  runTurn: async (history) => ({
    history,
    spoken: "",
    end: null,
    carrier: null,
    failed: true,
  }),
};

function attach(httpServer, deps = {}) {
  const {
    tokens = require("./tokens"),
    createSession = require("./session").createSession,
    createAgent = require("./agent").createAgent,
    createClient = () => new (require("@anthropic-ai/sdk").default)(),
    finalize = (...args) => require("./finalize").finalize(...args),
    getProfile = (id) => require("../agentProfiles").getProfile(id),
    setupTimeoutMs = 5000,
    profileTimeoutMs = 3000,
  } = deps;
  const checkSignature = deps.validateSignature || validateSignature;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  // Created on the first call and reused. Never at startup, so a missing
  // API key cannot stop the app from booting.
  let client;
  function getClient() {
    if (!client) client = createClient();
    return client;
  }

  // The call's agent profile, read once when the call starts, or null when
  // it is missing, unreadable, slow, or belongs to another workspace. Never
  // throws: on null the socket is closed so the caller gets the softphone.
  async function loadProfile(context) {
    let timer;
    try {
      const profile = await Promise.race([
        getProfile(context.agentProfileId),
        new Promise((resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("timed out")),
            profileTimeoutMs,
          );
        }),
      ]);
      if (!profile) {
        console.error("Receptionist agent profile not found.");
        return null;
      }
      if (profile.workspaceId !== context.workspaceId) {
        console.error("Receptionist agent profile is in another workspace.");
        return null;
      }
      return profile;
    } catch (error) {
      console.error("Receptionist agent profile unavailable:", error.message);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function onConnection(ws) {
    let session = null;
    // While the profile loads: the messages that arrive meanwhile, in order.
    let pending = null;
    let socketClosed = false;
    const refuse = () => ws.close(POLICY_VIOLATION, "unauthorized");
    const setupTimer = setTimeout(() => {
      if (!session && !pending) refuse();
    }, setupTimeoutMs);

    // Only called with a usable profile. If its agent cannot start, the
    // session still runs with the failing agent and speaks the profile's
    // own fallback line.
    function startSession(context, profile) {
      const config = getConfig();
      let agent = failingAgent;
      let activeClient = null;
      try {
        activeClient = getClient();
        agent = createAgent({ client: activeClient, config, profile });
      } catch (error) {
        console.error("Receptionist agent unavailable:", error.message);
      }
      return createSession({
        send: (payload) => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify(payload));
        },
        close: () => ws.close(1000),
        agent,
        config,
        context,
        profile,
        onFinished: (result) => {
          Promise.resolve()
            .then(() => finalize(result, context, { client: activeClient }))
            .catch((error) =>
              console.error("Receptionist finalize failed:", error.message),
            );
        },
      });
    }

    function forward(message) {
      Promise.resolve(session.handle(message)).catch((error) =>
        console.error("Receptionist message failed:", error.message),
      );
    }

    function begin(message) {
      const context =
        message.type === "setup"
          ? tokens.consume(message.customParameters?.token, message.callSid)
          : null;
      if (!context) return refuse();
      clearTimeout(setupTimer);
      pending = [message];
      loadProfile(context).then((profile) => {
        if (!profile) {
          // No agent to answer: closing with an error makes Twilio's
          // <Connect action> call endedHandler, which rings the softphone.
          pending = null;
          if (!socketClosed) ws.close(INTERNAL_ERROR, "profile unavailable");
          return;
        }
        try {
          session = startSession(context, profile);
        } catch (error) {
          console.error("Receptionist session failed:", error.message);
          // A session that could not even start cannot serve the call;
          // closing lets Twilio fall back to the usual path.
          pending = null;
          if (!socketClosed) ws.close(INTERNAL_ERROR, "session failed");
          return;
        }
        const queued = pending;
        pending = null;
        for (const queuedMessage of queued) {
          try {
            forward(queuedMessage);
          } catch (error) {
            console.error("Receptionist message failed:", error.message);
          }
        }
        if (socketClosed) closeSession();
      });
    }

    function closeSession() {
      try {
        session?.closed();
      } catch (error) {
        console.error("Receptionist close failed:", error.message);
      }
    }

    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return; // not JSON: ignore
      }
      if (!message || typeof message !== "object") return;
      // Nothing thrown here may escape: an uncaught exception in a socket
      // handler would take the whole app, and every other call, down.
      try {
        if (pending) return void pending.push(message);
        if (!session) return begin(message);
        forward(message);
      } catch (error) {
        console.error("Receptionist message failed:", error.message);
        // A session that could not even start cannot serve the call; closing
        // lets Twilio fall back to the usual path.
        if (!session && !pending) ws.close(INTERNAL_ERROR, "session failed");
      }
    });
    ws.on("close", () => {
      clearTimeout(setupTimer);
      socketClosed = true;
      // A session still being started is closed once it exists.
      if (!pending) closeSession();
    });
    ws.on("error", (error) =>
      console.error("Receptionist socket error:", error.message),
    );
  }

  httpServer.on("upgrade", async (req, socket, head) => {
    socket.on("error", () => {});
    const match = WS_PATH.exec((req.url || "").split("?")[0]);
    if (!match) return socket.destroy();
    let valid = false;
    try {
      valid = await checkSignature(req, match[1]);
    } catch (error) {
      console.error("Receptionist signature check failed:", error.message);
    }
    if (!valid) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, onConnection);
  });
  return wss;
}

module.exports = { attach, validateSignature };
