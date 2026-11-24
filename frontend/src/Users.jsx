import React, { useCallback, useEffect, useState } from "react";
import { apiFetch } from "./api";

async function request(url, options) {
  const response = await apiFetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Could not update users.");
  return data;
}
const json = (body, method = "POST") => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const blank = {
  username: "",
  displayName: "",
  password: "",
  role: "member",
  workspaceIds: [],
};

function WorkspacePicker({ workspaces, value, onChange, disabled }) {
  return (
    <div className="settings-rings">
      {workspaces.map((workspace) => (
        <label key={workspace.id}>
          <input
            type="checkbox"
            checked={value.includes(workspace.id)}
            disabled={disabled}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...value, workspace.id]
                  : value.filter((id) => id !== workspace.id),
              )
            }
          />
          {workspace.name}
        </label>
      ))}
    </div>
  );
}

function UserRow({ user, workspaces, busy, onPatch, onPassword }) {
  const [password, setPassword] = useState("");
  const [editing, setEditing] = useState(false);
  const [ids, setIds] = useState(user.workspaceIds);
  useEffect(() => setIds(user.workspaceIds), [user.workspaceIds]);
  const names = workspaces
    .filter((workspace) => user.workspaceIds.includes(workspace.id))
    .map((workspace) => workspace.name);
  return (
    <article className="settings-connection">
      <strong>{user.displayName}</strong> <span>({user.username})</span>
      <p>
        {user.role === "owner" ? "Owner" : "Member"}
        {user.enabled ? "" : " · Disabled"}
        {" · "}
        {user.role === "owner"
          ? "All workspaces"
          : names.join(", ") || "No workspaces"}
      </p>
      <div className="settings-number">
        <button
          type="button"
          className="button button-light"
          disabled={busy}
          onClick={() => onPatch(user, { enabled: !user.enabled })}
        >
          {user.enabled ? "Disable" : "Enable"}
        </button>
        <button
          type="button"
          className="button button-light"
          disabled={busy}
          onClick={() =>
            onPatch(user, {
              role: user.role === "owner" ? "member" : "owner",
            })
          }
        >
          {user.role === "owner" ? "Make member" : "Make owner"}
        </button>
        {user.role === "member" && (
          <button
            type="button"
            className="button button-light"
            disabled={busy}
            onClick={() => setEditing(!editing)}
          >
            Workspaces
          </button>
        )}
      </div>
      {editing && user.role === "member" && (
        <div className="settings-numbers">
          <WorkspacePicker
            workspaces={workspaces}
            value={ids}
            onChange={setIds}
            disabled={busy}
          />
          <button
            type="button"
            className="button button-light"
            disabled={busy}
            onClick={async () => {
              if (await onPatch(user, { workspaceIds: ids })) setEditing(false);
            }}
          >
            Save workspaces
          </button>
        </div>
      )}
      <form
        className="settings-numbers"
        onSubmit={async (event) => {
          event.preventDefault();
          if (await onPassword(user, password)) setPassword("");
        }}
      >
        <label>
          New password for {user.username}
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button
          className="button button-light"
          disabled={busy || password.length < 12}
        >
          Reset password
        </button>
      </form>
    </article>
  );
}

export default function Users({ workspaces, me }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ ...blank });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    try {
      setUsers(await request("/settings/users"));
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const run = async (action, done) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      if (done) setNotice(done);
      await load();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const create = (event) => {
    event.preventDefault();
    return run(async () => {
      const created = await request("/settings/users", json(form));
      setForm({ ...blank });
      if (me?.bootstrap && created.role === "owner") {
        setNotice(
          `Sign in again as ${created.username}. The operator password stops working now.`,
        );
        // The browser then asks for the new login.
        setTimeout(() => window.location.reload(), 4000);
      } else setNotice("User created.");
    });
  };
  const patch = (user, changes) =>
    run(
      () => request(`/settings/users/${user.id}`, json(changes, "PATCH")),
      "User updated.",
    );
  const resetPassword = (user, password) =>
    run(async () => {
      const response = await apiFetch(`/settings/users/${user.id}/password`, {
        ...json({ password }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Could not reset the password.");
      }
    }, "Password reset.");
  const set = (patchValues) => setForm({ ...form, ...patchValues });
  return (
    <section className="settings-card card">
      <h2>Users</h2>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <form onSubmit={create} className="settings-block">
        <h3>Add a user</h3>
        <label>
          Username
          <input
            value={form.username}
            autoComplete="off"
            disabled={busy}
            onChange={(e) => set({ username: e.target.value })}
          />
        </label>
        <label>
          Display name
          <input
            value={form.displayName}
            disabled={busy}
            onChange={(e) => set({ displayName: e.target.value })}
          />
        </label>
        <label>
          Password (12 to 200 characters)
          <input
            type="password"
            autoComplete="new-password"
            value={form.password}
            disabled={busy}
            onChange={(e) => set({ password: e.target.value })}
          />
        </label>
        <label>
          Role
          <select
            value={form.role}
            disabled={busy}
            onChange={(e) => set({ role: e.target.value })}
          >
            <option value="member">Member</option>
            <option value="owner">Owner</option>
          </select>
        </label>
        {form.role === "member" ? (
          <WorkspacePicker
            workspaces={workspaces}
            value={form.workspaceIds}
            onChange={(workspaceIds) => set({ workspaceIds })}
            disabled={busy}
          />
        ) : (
          <p>All workspaces</p>
        )}
        <button className="button" disabled={busy}>
          Create user
        </button>
      </form>
      <div className="settings-block">
        <h3>People</h3>
        {users.length === 0 && <p>No users yet.</p>}
        {users.map((user) => (
          <UserRow
            key={user.id}
            user={user}
            workspaces={workspaces}
            busy={busy}
            onPatch={patch}
            onPassword={resetPassword}
          />
        ))}
      </div>
    </section>
  );
}
