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
const MISMATCH = "The passwords do not match.";
const blank = {
  username: "",
  displayName: "",
  password: "",
  confirm: "",
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
  const [confirm, setConfirm] = useState("");
  const [mismatch, setMismatch] = useState(false);
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
          if (password !== confirm) return setMismatch(true);
          setMismatch(false);
          if (await onPassword(user, password)) {
            setPassword("");
            setConfirm("");
          }
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
        <label>
          Confirm password
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            disabled={busy}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        {mismatch && (
          <p className="settings-error" role="alert">
            {MISMATCH}
          </p>
        )}
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
      // An action returns false when the list must not be reloaded.
      const reload = (await action()) !== false;
      if (done) setNotice(done);
      if (reload) await load();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const [createMismatch, setCreateMismatch] = useState(false);
  const create = (event) => {
    event.preventDefault();
    if (form.password !== form.confirm) return setCreateMismatch(true);
    setCreateMismatch(false);
    return run(async () => {
      const body = { ...form };
      delete body.confirm;
      const created = await request("/settings/users", json(body));
      setForm({ ...blank });
      if (me?.bootstrap && created.role === "owner") {
        setNotice(
          `Sign in again as ${created.username}. The operator password stops working now.`,
        );
        // The operator login no longer works, so nothing is refetched with
        // it (that would pop the login dialog before this is read); the
        // reload then asks for the new login.
        setTimeout(() => window.location.reload(), 4000);
        return false;
      }
      setNotice("User created.");
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
          Confirm password
          <input
            type="password"
            autoComplete="new-password"
            value={form.confirm}
            disabled={busy}
            onChange={(e) => set({ confirm: e.target.value })}
          />
        </label>
        {createMismatch && (
          <p className="settings-error" role="alert">
            {MISMATCH}
          </p>
        )}
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
