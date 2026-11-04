import { useCallback, useEffect, useRef, useState } from "react";
import { Device } from "@twilio/voice-sdk";

async function getToken() {
  const response = await fetch("/token", { cache: "no-store" });
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

export function useVoice() {
  const deviceRef = useRef(null);
  const callRef = useRef(null);
  const startingRef = useRef(false);
  const callGenerationRef = useRef(0);
  const dialingRef = useRef(false);
  const [connection, setConnection] = useState("offline");
  const [identity, setIdentity] = useState("");
  const [tokenStatus, setTokenStatus] = useState({
    state: "not-issued",
    expiresAt: null,
    lastRefreshedAt: null,
  });
  const [call, setCall] = useState(null);
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [outputs, setOutputs] = useState([]);
  const [outputSupported, setOutputSupported] = useState(false);
  const [speaker, setSpeaker] = useState("default");
  const [ringtone, setRingtone] = useState("default");
  const [levels, setLevels] = useState({ input: 0, output: 0 });

  const updateOutputs = useCallback((device) => {
    if (!device?.audio) return;
    setOutputSupported(device.audio.isOutputSelectionSupported);
    setOutputs(
      Array.from(device.audio.availableOutputDevices.values()).map(
        ({ deviceId, label }) => ({ deviceId, label: label || "Audio output" }),
      ),
    );
  }, []);

  const clearCall = useCallback((instance) => {
    if (callRef.current !== instance) return;
    callRef.current = null;
    setCall(null);
    setMuted(false);
    setLevels({ input: 0, output: 0 });
  }, []);

  const watchCall = useCallback(
    (instance, direction, number) => {
      callRef.current = instance;
      setCall({
        direction,
        number,
        phase: direction === "incoming" ? "ringing" : "connecting",
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
    },
    [clearCall],
  );

  const start = useCallback(async () => {
    if (startingRef.current || deviceRef.current) return;
    startingRef.current = true;
    setConnection("connecting");
    setError("");
    let device;
    try {
      const data = await getToken();
      setIdentity(data.identity);
      setTokenStatus({
        state: "valid",
        expiresAt: tokenExpiration(data.token),
        lastRefreshedAt: null,
      });
      device = new Device(data.token, { codecPreferences: ["opus", "pcmu"] });
      deviceRef.current = device;
      device.on("registered", () => setConnection("online"));
      device.on("unregistered", () => setConnection("offline"));
      device.on("error", (err) =>
        setError(err.message || "Phone connection failed."),
      );
      device.on("incoming", (incoming) => {
        if (callRef.current || dialingRef.current) {
          incoming.reject();
          return;
        }
        watchCall(
          incoming,
          "incoming",
          incoming.parameters.From || "Unknown caller",
        );
      });
      device.on("tokenWillExpire", async () => {
        setTokenStatus((current) => ({ ...current, state: "refreshing" }));
        try {
          const refreshed = await getToken();
          device.updateToken(refreshed.token);
          setTokenStatus({
            state: "valid",
            expiresAt: tokenExpiration(refreshed.token),
            lastRefreshedAt: Date.now(),
          });
        } catch (err) {
          setTokenStatus((current) => ({
            ...current,
            state: "refresh-failed",
          }));
          setError(err.message);
        }
      });
      device.audio?.on("deviceChange", () => updateOutputs(device));
      await device.register();
      updateOutputs(device);
    } catch (err) {
      if (device) device.destroy();
      deviceRef.current = null;
      setConnection("offline");
      setError(err.message || "Phone connection failed.");
    } finally {
      startingRef.current = false;
    }
  }, [updateOutputs, watchCall]);

  const dial = useCallback(
    async (number) => {
      const device = deviceRef.current;
      if (!device || callRef.current || dialingRef.current || !number.trim())
        return;
      dialingRef.current = true;
      const generation = ++callGenerationRef.current;
      setError("");
      setCall({
        direction: "outgoing",
        number: number.trim(),
        phase: "connecting",
      });
      try {
        const instance = await device.connect({
          params: { To: number.trim() },
        });
        if (generation !== callGenerationRef.current) {
          instance.disconnect();
          return;
        }
        watchCall(instance, "outgoing", number.trim());
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
    callGenerationRef.current += 1;
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

  const accept = useCallback(() => {
    callRef.current?.accept();
  }, []);
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
      await deviceRef.current.audio[
        kind === "speaker" ? "speakerDevices" : "ringtoneDevices"
      ].set(id);
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
      deviceRef.current?.destroy();
      deviceRef.current = null;
    },
    [],
  );
  return {
    connection,
    identity,
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
    dial,
    hangup,
    accept,
    toggleMute,
    digit,
    chooseOutput,
    refreshAudio,
  };
}
