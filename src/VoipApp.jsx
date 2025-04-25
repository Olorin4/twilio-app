/* VoiApp.jsx is responsible for the client-side logic of
   the Twilio VoIP application. It is a JavaScript file that
   is loaded in the browser and interacts with the 
   Twilio Device API to make and receive calls. It also handles 
   the user interface elements and events such as call buttons,
   volume indicators, and audio device selection. */

import React, { useEffect, useState, useRef } from "react";
import { Button } from "@/components/Button";
import { Card, CardContent } from "@/components/Card";
import { Input } from "@/components/Input";
import "../index.css";

let device;

export default function VoipApp() {
  const [started, setStarted] = useState(false);
  const [token, setToken] = useState("");
  const [identity, setIdentity] = useState("");
  const [incomingCall, setIncomingCall] = useState(null);
  const [activeCall, setActiveCall] = useState(null);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [messages, setMessages] = useState([]);
  const [calls, setCalls] = useState([]);
  const [speakerDevices, setSpeakerDevices] = useState([]);
  const [ringtoneDevices, setRingtoneDevices] = useState([]);
  const [selectedSpeaker, setSelectedSpeaker] = useState("");
  const [selectedRingtone, setSelectedRingtone] = useState("");
  const [inputVolume, setInputVolume] = useState(0);
  const [outputVolume, setOutputVolume] = useState(0);
  const logRef = useRef();
  const tokenIntervalRef = useRef(null);

  useEffect(() => {
    fetchMessages();
    fetchCalls();
    const logsInterval = setInterval(() => {
      fetchMessages();
      fetchCalls();
    }, 60000);
    return () => clearInterval(logsInterval);
  }, []);

  useEffect(() => {
    return () => {
      if (device) device.destroy();
      if (tokenIntervalRef.current) clearInterval(tokenIntervalRef.current);
    };
  }, []);

  async function fetchToken() {
    const res = await fetch("/token");
    const data = await res.json();
    return data;
  }

  async function startupClient() {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      log("❌ Microphone access denied.");
      return;
    }
    log("🔑 Requesting Access Token...");
    const data = await fetchToken();
    if (data && data.token) {
      log("✅ Token received.");
      setStarted(true);
      setToken(data.token);
      setIdentity(data.identity);
      initializeDevice(data.token);

      tokenIntervalRef.current = setInterval(refreshToken, 3540 * 1000);
      log("🔄 Token refresh scheduled.");
    } else {
      log("❌ Failed to receive token.");
    }
  }

  async function refreshToken() {
    log("🔄 Refreshing Twilio token...");
    const data = await fetchToken();
    if (data && data.token) {
      log("✅ Token received.");
      if (device) {
        device.updateToken(data.token);
        log("✅ Token refreshed successfully.");
      } else {
        initializeDevice(data.token);
        log("✅ Device initialized with refreshed token.");
      }
    } else {
      log("❌ Token refresh failed. Try restarting the client.");
    }
  }

  function initializeDevice(newToken) {
    device = new Twilio.Device(newToken, {
      logLevel: 1,
      codecPreferences: ["opus", "pcmu"],
    });

    device.on("ready", () => {
      log("✅ Twilio Device is READY!");
      if (device.audio.isOutputSelectionSupported) {
        updateAudioDevices();
      }
    });
    device.on("registered", () => log("✅ Device registered."));
    device.on("unregistered", () => log("⚠️ Device unregistered."));
    device.on("error", (err) => log("❌ Device error: " + err.message));

    device.on("incoming", (call) => {
      setIncomingCall(call);
      log("📞 Incoming call from: " + call.parameters.From);
    });

    device.audio.on("deviceChange", updateAudioDevices);
    device.register();
  }

  async function updateAudioDevices() {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      log("❌ Microphone permission denied for device list.");
      return;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((d) => d.kind === "audiooutput");
    setSpeakerDevices(outputs);
    setRingtoneDevices(outputs);
  }

  async function fetchMessages() {
    try {
      const res = await fetch("/message-logs");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMessages(data);
    } catch (err) {
      console.error("❌ Fetch messages failed:", err);
    }
  }

  async function fetchCalls() {
    try {
      const res = await fetch("/call-logs");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCalls(data);
    } catch (err) {
      console.error("❌ Fetch calls failed:", err);
    }
  }

  function log(message) {
    const div = document.createElement("div");
    div.textContent = message;
    if (logRef.current) {
      logRef.current.appendChild(div);
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }

  function bindVolumeIndicators(call) {
    call.on("volume", (inputVol, outputVol) => {
      setInputVolume(inputVol);
      setOutputVolume(outputVol);
    });
  }

  function handleOutgoingCall() {
    if (device) {
      const params = { To: phoneNumber };
      const call = device.connect({ params });
      setActiveCall(call);
      log("📞 Calling " + phoneNumber);

      call.on("accept", () => {
        log("✅ Call in progress...");
        bindVolumeIndicators(call);
      });

      call.on("disconnect", () => {
        log("❌ Call disconnected.");
        setActiveCall(null);
      });

      call.on("cancel", () => {
        log("❌ Call canceled.");
        setActiveCall(null);
      });
    } else {
      log("❌ Unable to make call.");
    }
  }

  function sendDtmf(digit) {
    if (activeCall) {
      activeCall.sendDigits(digit);
      log("🎚️ Sent DTMF: " + digit);
    }
  }

  function acceptCall() {
    if (!incomingCall) return;
    incomingCall.accept();
    log("✅ Accepted incoming call.");
    setActiveCall(incomingCall);
    setIncomingCall(null);

    incomingCall.on("disconnect", () => {
      log("❌ Incoming call ended.");
      setActiveCall(null);
    });
    incomingCall.on("cancel", () => {
      log("❌ Caller hung up.");
      setIncomingCall(null);
      setActiveCall(null);
    });
    incomingCall.on("reject", () => {
      log("❌ Caller rejected.");
      setIncomingCall(null);
      setActiveCall(null);
    });
    bindVolumeIndicators(incomingCall);
  }

  function rejectCall() {
    if (!incomingCall) return;
    incomingCall.reject();
    log("❌ Rejected incoming call.");
    setIncomingCall(null);
  }

  function hangupCall() {
    if (activeCall) {
      activeCall.disconnect();
      log("❌ Call disconnected.");
      setActiveCall(null);
    }
  }

  const dtmfKeys = ["1","2","3","4","5","6","7","8","9","*","0","#"];

  if (!started) {
    return (
      <div className="startup-screen">
        <Button onClick={startupClient}>Start Softphone</Button>
      </div>
    );
  }

  return (
    <div className="app-container">
      <div className="sidebar">
        <h2>Messages</h2>
        <ul>
          {messages.map((msg, idx) => (
            <li key={idx} className="log-entry">
              <div>From: {msg.from_number}</div>
              <div>{new Date(msg.timestamp).toLocaleString()}</div>
              <div>{msg.body}</div>
            </li>
          ))}
        </ul>
        <h2>Calls</h2>
        <ul>
          {calls.map((call, idx) => (
            <li key={idx} className="log-entry">
              <div>From: {call.from_number}</div>
              <div>{new Date(call.timestamp).toLocaleString()}</div>
              <div>Duration: {call.duration != null ? `${call.duration} sec` : 'N/A'}</div>
              <div>Status: {call.status}</div>
            </li>
          ))}
        </ul>
      </div>

      <div className="main-content">
        <Card>
          <CardContent>
            <h2>Welcome, {identity}</h2>
            <div className="row">
              <Input
                placeholder="Enter phone number"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
              />
              <Button onClick={handleOutgoingCall} disabled={!!activeCall}>Call</Button>
              {activeCall && (
                <Button onClick={hangupCall} variant="destructive">Hang Up</Button>
              )}
            </div>

            {speakerDevices.length > 0 && (
              <div className="device-select">
                <label>Speaker</label>
                <select
                  value={selectedSpeaker}
                  onChange={(e) => {
                    setSelectedSpeaker(e.target.value);
                    device.audio.speakerDevices.set([e.target.value]);
                  }}
                >
                  {speakerDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || "Unknown"}</option>
                  ))}
                </select>
              </div>
            )}
            {ringtoneDevices.length > 0 && (
              <div className="device-select">
                <label>Ringtone</label>
                <select
                  value={selectedRingtone}
                  onChange={(e) => {
                    setSelectedRingtone(e.target.value);
                    device.audio.ringtoneDevices.set([e.target.value]);
                  }}
                >
                  {ringtoneDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || "Unknown"}</option>
                  ))}
                </select>
              </div>
            )}

            {activeCall && (
              <div className="volume-indicators">
                <p>🎙️ Mic Volume:</p>
                <div className="volume-bar">
                  <div
                    style={{ width: `${Math.floor(inputVolume * 100)}%` }}
                    className={inputVolume < 0.5 ? 'green' : inputVolume < 0.75 ? 'yellow' : 'red'}
                  />
                </div>
                <p>🔊 Speaker Volume:</p>
                <div className="volume-bar">
                  <div
                    style={{ width: `${Math.floor(outputVolume * 100)}%` }}
                    className={outputVolume < 0.5 ? 'green' : outputVolume < 0.75 ? 'yellow' : 'red'}
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {incomingCall && (
          <Card className="incoming-call">
            <CardContent>
              <h2>Incoming Call</h2>
              <p>From: {incomingCall.parameters.From}</p>
              <div className="row">
                <Button onClick={acceptCall}>Accept</Button>
                <Button onClick={rejectCall} variant="destructive">Reject</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {activeCall && (
          <div className="dtmf-grid">
            {dtmfKeys.map((k) => (
              <Button key={k} onClick={() => sendDtmf(k)}>{k}</Button>
            ))}
          </div>
        )}

        <div ref={logRef} className="log-box" />
      </div>
    </div>
  );
}