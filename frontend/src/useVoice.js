import { useCallback, useEffect, useRef, useState } from "react";
import { Device } from "@twilio/voice-sdk";
import { apiFetch, IRON_WING_WORKSPACE_ID } from "./api";
import { popLine, shouldFetch, isCurrent } from "./screenPop.mjs";
import { ownerVoiceKey } from "./voiceSelection.mjs";

const NO_LINE_MESSAGE = "No line is assigned to you in this workspace.";
async function getToken(target) {
  const headers = { "X-Workspace-Id": target.workspace_id };
  if (target.connection_id === "legacy")
    headers["X-Legacy-Connection"] = "true";
  else headers["X-Connection-Number-Id"] = target.number_id;
  const response = await apiFetch("/token", { cache: "no-store", headers });
  if (response.status === 403) throw new Error(NO_LINE_MESSAGE);
  if (!response.ok) throw new Error("Could not connect to the phone service.");
  const data = await response.json();
  if (!data.token) throw new Error("The phone service did not return a token.");
  return data;
}
function tokenExpiration(token) {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const { exp } = JSON.parse(atob(payload));
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}
const emptyToken = () => ({
  state: "not-issued",
  expiresAt: null,
  lastRefreshedAt: null,
});

export function useVoice(workspace) {
  const entries = useRef(new Map());
  const workspaceRef = useRef(workspace);
  const deviceRef = useRef(null);
  const phoneNumberRef = useRef("");
  const callRef = useRef(null);
  // The screen pop request for the call it belongs to: { instance, controller }.
  const popRef = useRef(null);
  const startingRef = useRef(false);
  const resumeRef = useRef(false);
  const deviceGenerationRef = useRef(0);
  const callGenerationRef = useRef(0);
  const dialingRef = useRef(false);
  const [connection, setConnection] = useState("offline");
  const [identity, setIdentity] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [tokenStatus, setTokenStatus] = useState(emptyToken);
  const [call, setCall] = useState(null);
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [outputs, setOutputs] = useState([]);
  const [outputSupported, setOutputSupported] = useState(false);
  const [speaker, setSpeaker] = useState("default");
  const [ringtone, setRingtone] = useState("default");
  const speakerRef = useRef("default");
  const ringtoneRef = useRef("default");
  const [levels, setLevels] = useState({ input: 0, output: 0 });
  // A member calls and texts only from their own lines; owners keep the
  // workspace's active number and never use these.
  const [member, setMember] = useState(false);
  const [lines, setLines] = useState([]);
  const [lineId, setLineId] = useState("");
  // True once a member's lines have loaded and there are none.
  const [noLine, setNoLine] = useState(false);
  // null for owners: their caller ID is the workspace's active number.
  const linesRef = useRef(null);
  const lineIdRef = useRef("");
  workspaceRef.current = workspace;

  const updateOutputs = useCallback((device) => {
    if (!device?.audio) return;
    setOutputSupported(device.audio.isOutputSelectionSupported);
    setOutputs(
      Array.from(device.audio.availableOutputDevices.values()).map(
        ({ deviceId, label }) => ({ deviceId, label: label || "Audio output" }),
      ),
    );
  }, []);
  const refreshSelection = useCallback(() => {
    const current = workspaceRef.current;
    const memberLine = linesRef.current
      ? linesRef.current.find((line) => line.numberId === lineIdRef.current) ||
        linesRef.current[0]
      : undefined;
    const key = linesRef.current
      ? memberLine?.connectionId || null
      : ownerVoiceKey(current, IRON_WING_WORKSPACE_ID);
    const entry = key ? entries.current.get(key) : undefined;
    deviceRef.current = entry?.device || null;
    phoneNumberRef.current = linesRef.current
      ? memberLine?.phoneNumber || ""
      : current?.active_phone || entry?.target.phone_number || "";
    setPhoneNumber(phoneNumberRef.current);
    setIdentity(entry?.identity || "");
    setTokenStatus(entry?.tokenStatus || emptyToken());
    setConnection(
      startingRef.current ? "connecting" : entry?.online ? "online" : "offline",
    );
    if (entry?.device) updateOutputs(entry.device);
    else {
      setOutputs([]);
      setOutputSupported(false);
    }
  }, [updateOutputs]);
  useEffect(() => {
    refreshSelection();
  }, [
    workspace?.id,
    workspace?.active_connection_id,
    workspace?.active_phone,
    refreshSelection,
  ]);
  // linesRef stays null for owners, so they keep today's behaviour.
  useEffect(() => {
    let cancelled = false;
    apiFetch("/me", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((me) => {
        if (!cancelled && me?.role === "member") setMember(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!member) return undefined;
    let cancelled = false;
    // Until the lines load, a member has no caller ID at all.
    linesRef.current = [];
    lineIdRef.current = "";
    setLines([]);
    setLineId("");
    setNoLine(false);
    refreshSelection();
    if (!workspace?.id) return undefined;
    apiFetch(`/me/lines?workspace=${encodeURIComponent(workspace.id)}`, {
      cache: "no-store",
    })
      .then((response) => {
        if (!response.ok) throw new Error("Could not load your lines.");
        return response.json();
      })
      .then((own) => {
        if (cancelled) return;
        const usable = Array.isArray(own) ? own : [];
        linesRef.current = usable;
        lineIdRef.current = usable[0]?.numberId || "";
        setLines(usable);
        setLineId(lineIdRef.current);
        setNoLine(!usable.length);
        refreshSelection();
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Could not load your lines.");
      });
    return () => {
      cancelled = true;
    };
  }, [member, workspace?.id, refreshSelection]);
  const chooseLine = useCallback(
    (numberId) => {
      if (callRef.current || dialingRef.current) return;
      if (!linesRef.current?.some((line) => line.numberId === numberId)) return;
      lineIdRef.current = numberId;
      setLineId(numberId);
      refreshSelection();
    },
    [refreshSelection],
  );

  const clearCall = useCallback((instance) => {
    if (callRef.current !== instance) return;
    if (popRef.current?.instance === instance) {
      popRef.current.controller.abort();
      popRef.current = null;
    }
    callRef.current = null;
    setCall(null);
    setMuted(false);
    setLevels({ input: 0, output: 0 });
  }, []);
  const watchCall = useCallback(
    (instance, direction, number, target) => {
      if (popRef.current) {
        popRef.current.controller.abort();
        popRef.current = null;
      }
      callRef.current = instance;
      setCall({
        direction,
        number,
        workspaceName: target?.workspace_name,
        localNumber:
          instance.customParameters?.get?.("CalledNumber") ||
          target?.phone_number,
        lineLabel: instance.customParameters?.get?.("CalledLabel") || undefined,
        phase: direction === "incoming" ? "ringing" : "connecting",
        callerContext: null,
      });
      instance.on("accept", () =>
        setCall((current) =>
          current && callRef.current === instance
            ? { ...current, phase: "active" }
            : current,
        ),
      );
      ["cancel", "disconnect", "reject"].forEach((event) =>
        instance.on(event, () => clearCall(instance)),
      );
      instance.on("error", (err) => {
        setError(err.message || "The call could not be completed.");
        clearCall(instance);
      });
      instance.on("volume", (input, output) => setLevels({ input, output }));
      // Screen pop: started only after the call is shown and its handlers are
      // registered, never awaited, silent on failure, and aborted when the
      // call ends or another replaces it.
      if (
        direction === "incoming" &&
        target?.workspace_id &&
        shouldFetch(number)
      ) {
        try {
          const ringAt = Date.now();
          const controller = new AbortController();
          popRef.current = { instance, controller };
          const timer = setTimeout(() => controller.abort(), 3000);
          apiFetch(`/contacts/${encodeURIComponent(number)}/timeline?limit=3`, {
            cache: "no-store",
            signal: controller.signal,
            headers: { "X-Workspace-Id": target.workspace_id },
          })
            .then((response) => (response.ok ? response.json() : null))
            .then((data) => {
              const line = data && popLine(data, ringAt);
              if (!line || !isCurrent(instance, callRef.current)) return;
              setCall((current) =>
                current && callRef.current === instance
                  ? { ...current, callerContext: line }
                  : current,
              );
            })
            .catch(() => {})
            .finally(() => {
              clearTimeout(timer);
              if (popRef.current?.controller === controller)
                popRef.current = null;
            });
        } catch {
          // The screen pop is optional; the call goes on without it.
        }
      }
    },
    [clearCall],
  );

  const start = useCallback(async () => {
    if (startingRef.current || callRef.current || dialingRef.current) return;
    const generation = ++deviceGenerationRef.current;
    startingRef.current = true;
    setConnection("connecting");
    setError("");
    // Restart all registrations together so a newly added connection is also
    // registered. No active call is interrupted.
    for (const entry of entries.current.values()) entry.device.destroy();
    entries.current.clear();
    deviceRef.current = null;
    try {
      const response = await apiFetch("/settings/voice-targets");
      if (!response.ok) throw new Error("Could not load phone connections.");
      const targets = await response.json();
      if (generation !== deviceGenerationRef.current) return;
      const results = await Promise.allSettled(
        targets.map(async (target) => {
          const data = await getToken(target);
          if (generation !== deviceGenerationRef.current) return;
          const device = new Device(data.token, {
            codecPreferences: ["opus", "pcmu"],
          });
          const entry = {
            device,
            target,
            identity: data.identity,
            online: false,
            tokenStatus: {
              state: "valid",
              expiresAt: tokenExpiration(data.token),
              lastRefreshedAt: null,
            },
          };
          entries.current.set(target.connection_id, entry);
          device.on("registered", () => {
            entry.online = true;
            refreshSelection();
          });
          device.on("unregistered", () => {
            entry.online = false;
            refreshSelection();
          });
          device.on("error", () => {
            entry.online = false;
            refreshSelection();
            setError(`Phone connection failed for ${target.workspace_name}.`);
          });
          device.on("incoming", (incoming) => {
            if (callRef.current || dialingRef.current) {
              incoming.reject();
              return;
            }
            watchCall(
              incoming,
              "incoming",
              incoming.parameters.From || "Unknown caller",
              target,
            );
          });
          device.on("tokenWillExpire", async () => {
            entry.tokenStatus = { ...entry.tokenStatus, state: "refreshing" };
            refreshSelection();
            try {
              const refreshed = await getToken(target);
              if (entries.current.get(target.connection_id) !== entry) return;
              device.updateToken(refreshed.token);
              entry.tokenStatus = {
                state: "valid",
                expiresAt: tokenExpiration(refreshed.token),
                lastRefreshedAt: Date.now(),
              };
            } catch {
              if (entries.current.get(target.connection_id) !== entry) return;
              entry.tokenStatus = {
                ...entry.tokenStatus,
                state: "refresh-failed",
              };
              setError(
                `Phone token refresh failed for ${target.workspace_name}.`,
              );
            }
            refreshSelection();
          });
          device.audio?.on("deviceChange", () => {
            if (deviceRef.current === device) updateOutputs(device);
          });
          try {
            await device.register();
            if (generation !== deviceGenerationRef.current) {
              entries.current.delete(target.connection_id);
              device.destroy();
            }
          } catch (err) {
            entries.current.delete(target.connection_id);
            device.destroy();
            throw err;
          }
        }),
      );
      if (generation !== deviceGenerationRef.current) return;
      const rejected = results.filter((result) => result.status === "rejected");
      const noLineAssigned = rejected.find(
        (result) => result.reason?.message === NO_LINE_MESSAGE,
      );
      if (noLineAssigned) setError(NO_LINE_MESSAGE);
      else if (rejected.length)
        setError(
          "One or more workspace phone connections could not connect. Check Settings.",
        );
      if (!targets.length) setError("No voice connection is configured.");
    } catch (err) {
      if (generation === deviceGenerationRef.current)
        setError(err.message || "Phone connection failed.");
    } finally {
      if (generation === deviceGenerationRef.current) {
        startingRef.current = false;
        refreshSelection();
      }
    }
  }, [refreshSelection, updateOutputs, watchCall]);
  const canSwitch = useCallback(
    () => !callRef.current && !dialingRef.current && !startingRef.current,
    [],
  );
  // Pause registrations for a connection change. Remember whether the phone
  // was connected so resume() can restore it with fresh tokens.
  const stop = useCallback(() => {
    if (!canSwitch()) return false;
    resumeRef.current = entries.current.size > 0;
    for (const entry of entries.current.values()) entry.device.destroy();
    entries.current.clear();
    refreshSelection();
    return true;
  }, [canSwitch, refreshSelection]);
  // Re-register after stop() if the phone was connected. Returns whether it
  // restarted; a phone the operator had not connected stays disconnected.
  const resume = useCallback(() => {
    const shouldResume = resumeRef.current;
    resumeRef.current = false;
    if (shouldResume) start();
    return shouldResume;
  }, [start]);
  const dial = useCallback(
    async (number, intentId) => {
      const device = deviceRef.current;
      if (!device || callRef.current || dialingRef.current || !number.trim())
        return;
      dialingRef.current = true;
      const generation = ++callGenerationRef.current;
      const target = { workspace_name: workspaceRef.current?.name };
      setError("");
      setCall({
        direction: "outgoing",
        number: number.trim(),
        workspaceName: target.workspace_name,
        phase: "connecting",
      });
      try {
        const instance = await device.connect({
          params: {
            To: number.trim(),
            FromNumber: phoneNumberRef.current,
            ...(intentId ? { AssistIntent: intentId } : {}),
          },
        });
        if (device.audio?.isOutputSelectionSupported) {
          try {
            if (speakerRef.current !== "default")
              await device.audio.speakerDevices.set(speakerRef.current);
            if (ringtoneRef.current !== "default")
              await device.audio.ringtoneDevices.set(ringtoneRef.current);
          } catch {
            setError(
              `Could not apply audio settings to ${target.workspace_name}.`,
            );
          }
        }
        if (generation !== callGenerationRef.current) {
          instance.disconnect();
          return;
        }
        watchCall(instance, "outgoing", number.trim(), target);
      } catch (err) {
        if (generation === callGenerationRef.current) {
          setCall(null);
          setError(err.message || "The call could not be started.");
        }
      } finally {
        if (generation === callGenerationRef.current)
          dialingRef.current = false;
      }
    },
    [watchCall],
  );
  const hangup = useCallback(() => {
    callGenerationRef.current++;
    dialingRef.current = false;
    const instance = callRef.current;
    if (!instance) {
      setCall(null);
      return;
    }
    if (instance.status() === "pending") instance.reject();
    else instance.disconnect();
    clearCall(instance);
  }, [clearCall]);
  const accept = useCallback(() => callRef.current?.accept(), []);
  const toggleMute = useCallback(() => {
    if (!callRef.current) return;
    const next = !callRef.current.isMuted();
    callRef.current.mute(next);
    setMuted(next);
  }, []);
  const digit = useCallback((value) => {
    if (callRef.current?.status() === "open") callRef.current.sendDigits(value);
  }, []);
  const chooseOutput = useCallback(async (kind, id) => {
    try {
      const devices = [...entries.current.values()]
        .map((entry) => entry.device)
        .filter((device) => device.audio?.isOutputSelectionSupported);
      if (!devices.length)
        throw new Error("Audio output selection is not available.");
      await Promise.all(
        devices.map((device) =>
          device.audio[
            kind === "speaker" ? "speakerDevices" : "ringtoneDevices"
          ].set(id),
        ),
      );
      (kind === "speaker" ? speakerRef : ringtoneRef).current = id;
      (kind === "speaker" ? setSpeaker : setRingtone)(id);
    } catch (err) {
      setError(err.message || "Could not change audio output.");
    }
  }, []);
  const refreshAudio = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      updateOutputs(deviceRef.current);
    } catch {
      setError("Microphone permission is needed to use the phone.");
    }
  }, [updateOutputs]);
  useEffect(
    () => () => {
      deviceGenerationRef.current++;
      for (const entry of entries.current.values()) entry.device.destroy();
      entries.current.clear();
      deviceRef.current = null;
    },
    [],
  );
  return {
    connection,
    identity,
    phoneNumber,
    member,
    lines,
    lineId,
    noLine,
    chooseLine,
    tokenStatus,
    call,
    error,
    setError,
    muted,
    levels,
    outputs,
    outputSupported,
    speaker,
    ringtone,
    start,
    stop,
    resume,
    canSwitch,
    dial,
    hangup,
    accept,
    toggleMute,
    digit,
    chooseOutput,
    refreshAudio,
  };
}
