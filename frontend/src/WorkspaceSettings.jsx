import React, { useCallback, useEffect, useState } from "react";
import { apiFetch, IRON_WING_WORKSPACE_ID } from "./api";

const blank = {
  accountSid: "",
  authToken: "",
  apiKeySid: "",
  apiKeySecret: "",
  twimlAppSid: "",
};
const fields = [
  ["accountSid", "Account SID", false],
  ["authToken", "Auth Token", true],
  ["apiKeySid", "API Key SID", false],
  ["apiKeySecret", "API Key Secret", true],
  ["twimlAppSid", "TwiML App SID", false],
];
async function request(url, options) {
  const response = await apiFetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Could not update settings.");
  return data;
}
const json = (body, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export default function WorkspaceSettings({
  workspaceId,
  busy,
  onWorkspaceCreated,
  onNumberChangeStart,
  onNumberChangeEnd,
  onNumberChanged,
}) {
  const [connections, setConnections] = useState([]);
  const [webhookBase, setWebhookBase] = useState("");
  const [legacy, setLegacy] = useState(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [connectionName, setConnectionName] = useState("");
  const [editingConnection, setEditingConnection] = useState(null);
  const [numberManager, setNumberManager] = useState(null);
  const [extraNumbers, setExtraNumbers] = useState([]);
  const [credentials, setCredentials] = useState({ ...blank });
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    try {
      setConnections(
        await request(`/settings/workspaces/${workspaceId}/connections`),
      );
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, [workspaceId]);
  useEffect(() => {
    setCredentials({ ...blank });
    setEditingConnection(null);
    setNumberManager(null);
    setExtraNumbers([]);
    setPreview(null);
    setSelected([]);
    setNotice("");
    load();
  }, [load]);
  useEffect(() => {
    request("/settings/config")
      .then((data) => {
        setWebhookBase(data.webhookBaseUrl || "");
        setLegacy({
          phone: data.legacyPhoneNumber,
          accountSid: data.legacyAccountSid,
        });
      })
      .catch(() => setWebhookBase(""));
  }, []);
  const create = async (event) => {
    event.preventDefault();
    setWorking(true);
    setError("");
    try {
      const workspace = await request(
        "/settings/workspaces",
        json({ name: workspaceName }),
      );
      setWorkspaceName("");
      await onWorkspaceCreated(workspace);
      setNotice("Workspace created.");
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  };
  const validate = async (event) => {
    event.preventDefault();
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const data = await request(
        "/settings/connections/validate",
        json(credentials),
      );
      setPreview(data);
      setSelected([]);
    } catch (err) {
      setPreview(null);
      setError(err.message);
    } finally {
      setWorking(false);
    }
  };
  // Changes that affect which phone connections exist pause the browser phone,
  // apply the change, then re-register it with fresh tokens if it was connected.
  const withPhonePaused = async (blockedMessage, action, doneMessage) => {
    if (busy) return;
    setWorking(true);
    setError("");
    setNotice("");
    let paused = false;
    try {
      if (!onNumberChangeStart()) throw new Error(blockedMessage);
      paused = true;
      await action();
      paused = false;
      const resumed = onNumberChangeEnd();
      setNotice(
        `${doneMessage} ${
          resumed ? "Reconnecting the phone." : "Connect the phone to use it."
        }`,
      );
    } catch (err) {
      setError(err.message);
    } finally {
      // A failed change leaves the previous configuration, so restore it.
      if (paused) onNumberChangeEnd();
      setWorking(false);
    }
  };
  const save = () =>
    withPhonePaused(
      "Finish the current call before adding a connection.",
      async () => {
        if (editingConnection)
          await request(
            `/settings/workspaces/${workspaceId}/connections/${editingConnection.id}`,
            json({ credentials }, "PUT"),
          );
        else
          await request(
            `/settings/workspaces/${workspaceId}/connections`,
            json({
              name: connectionName,
              credentials,
              selectedNumberSids: selected,
            }),
          );
        setCredentials({ ...blank });
        setConnectionName("");
        setEditingConnection(null);
        setPreview(null);
        setSelected([]);
        await load();
      },
      "Connection saved. Verify its Twilio webhooks.",
    );
  const activate = (numberId) =>
    withPhonePaused(
      "Finish the current call before changing the number.",
      async () => {
        await request(
          `/settings/workspaces/${workspaceId}/active-number`,
          json({ numberId }),
        );
        await onNumberChanged();
        await load();
      },
      "Number selected.",
    );
  const activateLegacy = () =>
    withPhonePaused(
      "Finish the current call before changing the number.",
      async () => {
        await request(
          `/settings/workspaces/${workspaceId}/legacy-number`,
          json({}),
        );
        await onNumberChanged();
        await load();
      },
      "Existing Iron Wing number selected.",
    );
  const manageNumbers = async (connection) => {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const data = await request(
        `/settings/workspaces/${workspaceId}/connections/${connection.id}/numbers/validate`,
        json({}),
      );
      setNumberManager({ connection, numbers: data.numbers });
      setExtraNumbers([]);
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  };
  const addNumbers = () => {
    if (!numberManager || !extraNumbers.length) return;
    return withPhonePaused(
      "Finish the current call before changing numbers.",
      async () => {
        await request(
          `/settings/workspaces/${workspaceId}/connections/${numberManager.connection.id}/numbers`,
          json({ selectedNumberSids: extraNumbers }),
        );
        setNumberManager(null);
        setExtraNumbers([]);
        await onNumberChanged();
        await load();
      },
      "Numbers added. Configure their Twilio webhooks.",
    );
  };
  return (
    <section className="settings-card card">
      <h2>Workspace settings</h2>
      <form onSubmit={create} className="settings-block">
        <h3>Create workspace</h3>
        <label>
          Workspace name
          <input
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
            maxLength={120}
            required
          />
        </label>
        <button className="button button-green" disabled={working}>
          Create workspace
        </button>
      </form>
      <div className="settings-block">
        <h3>Twilio connections</h3>
        {workspaceId === IRON_WING_WORKSPACE_ID && legacy?.phone && (
          <article className="settings-connection">
            <strong>Existing Iron Wing connection</strong>
            <p>
              {legacy.phone} · {legacy.accountSid}
            </p>
            <p>Configured in the server environment.</p>
            <button
              type="button"
              className="button button-light"
              disabled={
                working ||
                busy ||
                !connections.some((connection) =>
                  connection.numbers.some((number) => number.active),
                )
              }
              onClick={activateLegacy}
            >
              Select existing number
            </button>
          </article>
        )}
        {connections.length === 0 ? (
          <p>No saved connections for this workspace.</p>
        ) : (
          connections.map((connection) => (
            <article className="settings-connection" key={connection.id}>
              <strong>{connection.name}</strong>
              <p>{connection.account_sid}</p>
              <button
                type="button"
                className="button button-light"
                disabled={working || busy}
                onClick={() => {
                  setEditingConnection(connection);
                  setConnectionName(connection.name);
                  setCredentials({
                    ...blank,
                    accountSid: connection.account_sid,
                    twimlAppSid: connection.twiml_app_sid,
                  });
                  setPreview(null);
                  setSelected([]);
                  setError("");
                  setNotice("");
                }}
              >
                Update credentials
              </button>
              <button
                type="button"
                className="button button-light"
                disabled={working || busy}
                onClick={() => manageNumbers(connection)}
              >
                Add numbers
              </button>
              <p>
                Webhook routing is not verified. Check the Twilio configuration
                before relying on this connection.
              </p>
              {connection.numbers.map((number) => (
                <div className="settings-number" key={number.id}>
                  <span>
                    {number.phone_number} ·{" "}
                    {number.voice_enabled ? "Voice" : "No voice"} ·{" "}
                    {number.sms_enabled ? "SMS" : "No SMS"}
                  </span>
                  <button
                    className="button button-light"
                    disabled={working || busy || number.active}
                    onClick={() => activate(number.id)}
                  >
                    {number.active ? "Selected" : "Select"}
                  </button>
                </div>
              ))}
              {numberManager?.connection.id === connection.id && (
                <div className="settings-numbers">
                  <p>Select additional numbers owned by this account:</p>
                  {numberManager.numbers
                    .filter(
                      (number) =>
                        !connection.numbers.some(
                          (existing) =>
                            existing.provider_number_sid === number.sid,
                        ),
                    )
                    .map((number) => (
                      <label key={number.sid}>
                        <input
                          type="checkbox"
                          checked={extraNumbers.includes(number.sid)}
                          onChange={(event) =>
                            setExtraNumbers(
                              event.target.checked
                                ? [...extraNumbers, number.sid]
                                : extraNumbers.filter(
                                    (sid) => sid !== number.sid,
                                  ),
                            )
                          }
                        />
                        {number.phoneNumber} ·{" "}
                        {number.voice ? "Voice" : "No voice"} ·{" "}
                        {number.sms ? "SMS" : "No SMS"}
                      </label>
                    ))}
                  <button
                    type="button"
                    className="button button-green"
                    disabled={working || busy || !extraNumbers.length}
                    onClick={addNumbers}
                  >
                    Save numbers
                  </button>
                  <button
                    type="button"
                    className="button button-light"
                    onClick={() => {
                      setNumberManager(null);
                      setExtraNumbers([]);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}
              <details>
                <summary>Twilio webhook URLs</summary>
                {webhookBase ? (
                  <>
                    <p>
                      Voice: {webhookBase}/webhooks/{connection.id}/voice
                    </p>
                    <p>
                      Incoming SMS: {webhookBase}/webhooks/{connection.id}/sms
                    </p>
                    <p>
                      Configure the voice URL on the number and its TwiML App,
                      and the inbound SMS URL on the number or Messaging
                      Service.
                    </p>
                  </>
                ) : (
                  <p>The webhook base URL is not configured.</p>
                )}
              </details>
            </article>
          ))
        )}
      </div>
      <form onSubmit={validate} className="settings-block">
        <h3>
          {editingConnection
            ? `Update ${editingConnection.name} credentials`
            : "Add Twilio connection"}
        </h3>
        <label>
          Connection name
          <input
            value={connectionName}
            onChange={(e) => setConnectionName(e.target.value)}
            maxLength={120}
            required
            readOnly={!!editingConnection}
          />
        </label>
        {fields.map(([key, label, secret]) => (
          <label key={key}>
            {label}
            <input
              type={secret ? "password" : "text"}
              autoComplete="off"
              value={credentials[key]}
              required
              readOnly={
                !!editingConnection &&
                (key === "accountSid" || key === "twimlAppSid")
              }
              onChange={(e) => {
                setCredentials({ ...credentials, [key]: e.target.value });
                setPreview(null);
                setSelected([]);
              }}
            />
          </label>
        ))}
        <button className="button button-light" disabled={working}>
          {working ? "Checking…" : "Validate credentials"}
        </button>
        {preview && (
          <div className="settings-numbers">
            {editingConnection ? (
              <p>
                Credentials validated. Existing numbers must still belong to
                this account.
              </p>
            ) : (
              <>
                <p>Select the numbers for this workspace:</p>
                {preview.numbers.length === 0 ? (
                  <p>No numbers found.</p>
                ) : (
                  preview.numbers.map((number) => (
                    <label key={number.sid}>
                      <input
                        type="checkbox"
                        checked={selected.includes(number.sid)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, number.sid]
                              : selected.filter((sid) => sid !== number.sid),
                          )
                        }
                      />
                      {number.phoneNumber} ·{" "}
                      {number.voice ? "Voice" : "No voice"} ·{" "}
                      {number.sms ? "SMS" : "No SMS"}
                    </label>
                  ))
                )}
              </>
            )}
            <button
              type="button"
              className="button button-green"
              disabled={
                working || busy || (!editingConnection && !selected.length)
              }
              onClick={save}
            >
              {editingConnection ? "Save credentials" : "Save connection"}
            </button>
          </div>
        )}
        {editingConnection && (
          <button
            type="button"
            className="button button-light"
            onClick={() => {
              setEditingConnection(null);
              setCredentials({ ...blank });
              setConnectionName("");
              setPreview(null);
              setSelected([]);
            }}
          >
            Cancel update
          </button>
        )}
      </form>
      {busy && (
        <p role="status">
          Finish the current call or phone connection before changing the
          selected number.
        </p>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
