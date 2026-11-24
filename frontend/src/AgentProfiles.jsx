import React, { useEffect, useState } from "react";
import { apiFetch } from "./api";

const KINDS = [
  ["receptionist", "Receptionist (screens new leads)"],
  ["dispatcher", "Dispatcher (takes messages, flags urgent calls)"],
  ["support", "Support (handles support requests)"],
];
const CAPS = { greeting: 500, instructions: 20000, knowledge: 60000 };
const emptyForm = {
  kind: "support",
  name: "",
  personaName: "",
  companyName: "",
  greeting: "",
  instructions: "",
  knowledge: "",
  voice: "",
  alertEmail: "",
  dailyLimit: "",
  enabled: true,
};

async function request(url, options) {
  const response = await apiFetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Could not update agents.");
  return data;
}
const json = (body, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const toForm = (profile) => ({
  ...emptyForm,
  ...Object.fromEntries(
    Object.keys(emptyForm).map((key) => [key, profile[key] ?? ""]),
  ),
  enabled: profile.enabled !== false,
});

function Counter({ value, cap }) {
  const length = (value || "").length;
  return (
    <small className={length > cap ? "settings-error" : undefined}>
      {length.toLocaleString()} / {cap.toLocaleString()} characters
    </small>
  );
}

export default function AgentProfiles({ workspaceId, profiles, onChanged }) {
  // editing: null (closed), "new", or a profile id.
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [revisions, setRevisions] = useState([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const base = `/settings/workspaces/${workspaceId}/agents`;

  useEffect(() => {
    setEditing(null);
    setRevisions([]);
    setError("");
    setNotice("");
  }, [workspaceId]);

  const run = async (action, done) => {
    setWorking(true);
    setError("");
    setNotice("");
    try {
      await action();
      if (done) setNotice(done);
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  };
  const set = (key) => (event) =>
    setForm({
      ...form,
      [key]:
        event.target.type === "checkbox"
          ? event.target.checked
          : event.target.value,
    });

  const loadRevisions = async (id) =>
    setRevisions(await request(`${base}/${id}/revisions`));
  const startNew = () => {
    setEditing("new");
    setForm({ ...emptyForm });
    setRevisions([]);
    setError("");
    setNotice("");
  };
  const startEdit = (profile) =>
    run(async () => {
      setEditing(profile.id);
      setForm(toForm(profile));
      await loadRevisions(profile.id);
    });
  // A new non-receptionist agent should say who it is until the owner edits it.
  const changeKind = (event) => {
    const kind = event.target.value;
    setForm({ ...form, kind });
  };
  const startingPoint = () => {
    if (form.kind === "receptionist" || form.instructions.trim()) return form;
    if (!form.personaName.trim() || !form.companyName.trim()) return form;
    return {
      ...form,
      instructions: `You are ${form.personaName.trim()}, answering calls for ${form.companyName.trim()}.`,
    };
  };
  const fillStartingPoint = () => {
    const next = startingPoint();
    if (next !== form) setForm(next);
  };

  const payload = () => {
    const body = { ...form };
    if (body.dailyLimit === "") delete body.dailyLimit;
    else body.dailyLimit = Number(body.dailyLimit);
    if (editing !== "new") delete body.kind;
    return body;
  };
  const save = (event) => {
    event.preventDefault();
    return run(async () => {
      if (editing === "new") {
        const created = await request(base, json(payload()));
        await onChanged();
        setEditing(created.id);
        setForm(toForm(created));
        await loadRevisions(created.id);
      } else {
        const updated = await request(
          `${base}/${editing}`,
          json(payload(), "PUT"),
        );
        await onChanged();
        setForm(toForm(updated));
        await loadRevisions(editing);
      }
    }, "Agent saved.");
  };
  const makeDefault = (profile) =>
    run(async () => {
      await request(`${base}/${profile.id}/default`, json({}));
      await onChanged();
    }, `${profile.name} is now the default agent.`);
  const restore = (revision) => {
    if (
      !window.confirm(
        "Restore this version? Your current text is kept as a revision.",
      )
    )
      return;
    return run(async () => {
      const restored = await request(
        `${base}/${editing}/revisions/${revision.id}/restore`,
        json({}),
      );
      await onChanged();
      setForm(toForm(restored));
      await loadRevisions(editing);
    }, "Revision restored.");
  };

  const current = profiles.find((p) => p.id === editing);
  return (
    <div className="settings-block">
      <h3>AI agents</h3>
      {profiles.length === 0 ? (
        <p>No agents for this workspace yet.</p>
      ) : (
        profiles.map((profile) => (
          <article className="settings-connection" key={profile.id}>
            <strong>{profile.name}</strong>
            <p>
              {profile.kind} · {profile.personaName} · {profile.companyName}
              {profile.isDefault ? " · Default" : ""}
              {profile.enabled ? "" : " · Off"}
            </p>
            <button
              type="button"
              className="button button-light"
              disabled={working}
              onClick={() => startEdit(profile)}
            >
              Edit
            </button>
            {!profile.isDefault && (
              <button
                type="button"
                className="button button-light"
                disabled={working}
                onClick={() => makeDefault(profile)}
              >
                Make default
              </button>
            )}
          </article>
        ))
      )}
      {editing === null && (
        <button
          type="button"
          className="button button-light"
          onClick={startNew}
        >
          Add agent
        </button>
      )}
      {editing !== null && (
        <form onSubmit={save} className="settings-block">
          <h3>{editing === "new" ? "New agent" : `Edit ${current?.name}`}</h3>
          <label>
            Kind
            <select
              value={form.kind}
              onChange={changeKind}
              disabled={editing !== "new"}
            >
              {KINDS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Name
            <input
              value={form.name}
              onChange={set("name")}
              maxLength={120}
              required
            />
          </label>
          <label>
            Persona name
            <input
              value={form.personaName}
              onChange={set("personaName")}
              onBlur={editing === "new" ? fillStartingPoint : undefined}
              maxLength={120}
              required
            />
          </label>
          <label>
            Company
            <input
              value={form.companyName}
              onChange={set("companyName")}
              onBlur={editing === "new" ? fillStartingPoint : undefined}
              maxLength={120}
              required
            />
          </label>
          <label>
            Greeting
            <textarea
              value={form.greeting}
              onChange={set("greeting")}
              rows={2}
              required
            />
            <Counter value={form.greeting} cap={CAPS.greeting} />
          </label>
          <label>
            Instructions
            <textarea
              value={form.instructions}
              onChange={set("instructions")}
              rows={8}
            />
            <Counter value={form.instructions} cap={CAPS.instructions} />
          </label>
          <label>
            Knowledge
            <textarea
              value={form.knowledge}
              onChange={set("knowledge")}
              rows={8}
            />
            <Counter value={form.knowledge} cap={CAPS.knowledge} />
          </label>
          <label>
            Voice
            <input value={form.voice} onChange={set("voice")} maxLength={64} />
          </label>
          <label>
            Alert email
            <input
              type="email"
              value={form.alertEmail}
              onChange={set("alertEmail")}
            />
          </label>
          <label>
            Daily call limit
            <input
              type="number"
              min={1}
              max={1000}
              value={form.dailyLimit}
              onChange={set("dailyLimit")}
              placeholder="Default for this kind"
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={set("enabled")}
            />
            Enabled
          </label>
          <button className="button button-green" disabled={working}>
            {working ? "Saving…" : "Save agent"}
          </button>
          <button
            type="button"
            className="button button-light"
            disabled={working}
            onClick={() => {
              setEditing(null);
              setRevisions([]);
            }}
          >
            Close
          </button>
          {editing !== "new" && (
            <details>
              <summary>Revisions ({revisions.length})</summary>
              {revisions.length === 0 ? (
                <p>No earlier versions.</p>
              ) : (
                revisions.map((revision) => (
                  <div className="settings-number" key={revision.id}>
                    <span>
                      {new Date(revision.savedAt).toLocaleString()} ·{" "}
                      {revision.savedBy}
                    </span>
                    <button
                      type="button"
                      className="button button-light"
                      disabled={working}
                      onClick={() => restore(revision)}
                    >
                      Restore
                    </button>
                  </div>
                ))
              )}
            </details>
          )}
        </form>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
