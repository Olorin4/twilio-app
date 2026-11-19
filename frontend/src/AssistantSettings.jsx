import React, { useEffect, useRef, useState } from "react";
import { apiFetch } from "./api";

const defaults = { jack: true, liveAssist: true };

export function useAssistantSettings(workspace) {
  const [record, setRecord] = useState(null);
  const operation = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    operation.current = controller;
    apiFetch("/settings/assist", {
      headers: { "X-Workspace-Id": workspace },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then((data) => {
        if (!controller.signal.aborted) setRecord({ workspace, data });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setRecord({ workspace, error: "Could not load assistant settings." });
      });
    return () => {
      controller.abort();
      operation.current?.abort();
    };
  }, [workspace]);

  const current = record?.workspace === workspace ? record : null;
  async function change(key, value) {
    if (!current?.data || current.saving) return;
    const controller = new AbortController();
    operation.current = controller;
    setRecord({ workspace, data: current.data, saving: true });
    try {
      const response = await apiFetch("/settings/assist", {
        method: "PATCH",
        headers: {
          "X-Workspace-Id": workspace,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({ [key]: value }),
      });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!controller.signal.aborted) setRecord({ workspace, data });
    } catch {
      if (!controller.signal.aborted)
        setRecord({
          workspace,
          data: current.data,
          error: "Could not save assistant settings.",
        });
    }
  }

  return {
    preferences: current?.data?.preferences || defaults,
    available: current?.data?.available,
    disabled: !current?.data || current.saving,
    error: current?.error,
    change,
  };
}

export default function AssistantSettings({ settings }) {
  return (
    <div className="assistant-settings">
      {[
        [
          "jack",
          "AI assistant (Jack)",
          "Jack handles eligible incoming calls.",
        ],
        ["liveAssist", "Live Assist", "Suggestions during outbound calls."],
      ].map(([key, label, description]) => (
        <label className="assistant-setting" key={key}>
          <span>
            <strong>{label}</strong>
            <small>
              {settings.available?.[key] === false
                ? "Unavailable in this workspace"
                : description}
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="assistant-switch-input"
            aria-label={label}
            checked={settings.preferences[key]}
            disabled={settings.disabled}
            onChange={(event) => settings.change(key, event.target.checked)}
          />
          <span className="assistant-switch-track" aria-hidden="true" />
        </label>
      ))}
      {settings.error && (
        <p className="assistant-settings-error" role="alert">
          {settings.error}
        </p>
      )}
    </div>
  );
}
