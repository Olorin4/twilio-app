﻿$(function () {
  const speakerDevices = document.getElementById("speaker-devices");
  const ringtoneDevices = document.getElementById("ringtone-devices");
  const outputVolumeBar = document.getElementById("output-volume");
  const inputVolumeBar = document.getElementById("input-volume");
  const volumeIndicators = document.getElementById("volume-indicators");
  const callButton = document.getElementById("button-call");
  const outgoingCallHangupButton = document.getElementById(
    "button-hangup-outgoing",
  );
  const callControlsDiv = document.getElementById("call-controls");
  const audioSelectionDiv = document.getElementById("output-selection");
  const getAudioDevicesButton = document.getElementById("get-devices");
  const logDiv = document.getElementById("log");
  const incomingCallDiv = document.getElementById("incoming-call");
  const incomingCallHangupButton = document.getElementById(
    "button-hangup-incoming",
  );
  const incomingCallAcceptButton = document.getElementById(
    "button-accept-incoming",
  );
  const incomingCallRejectButton = document.getElementById(
    "button-reject-incoming",
  );
  const phoneNumberInput = document.getElementById("phone-number");
  const incomingPhoneNumberEl = document.getElementById("incoming-number");
  const startupButton = document.getElementById("startup-button");
  const dtmfControlsDiv = document.getElementById("dtmf-controls");
  const dtmfButtons = document.querySelectorAll(".dtmf-button");

  let device;
  let token;
  let tokenRefreshInterval; // Variable to store interval reference
  let activeCall = null; // Track the currently active call

  // Event Listeners

  callButton.onclick = (e) => {
    e.preventDefault();
    makeOutgoingCall();
  };
  getAudioDevicesButton.onclick = getAudioDevices;
  speakerDevices.addEventListener("change", updateOutputDevice);
  ringtoneDevices.addEventListener("change", updateRingtoneDevice);
  dtmfButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const digit = button.getAttribute("data-digit");
      if (activeCall) {
        log(`Sending DTMF: ${digit}`);
        activeCall.sendDigits(digit); // Send the DTMF tone
      } else log("No active call to send DTMF.");
    });
  });

  // SETUP STEP 1:
  // Browser client should be started after a user gesture
  // to avoid errors in the browser console re: AudioContext
  startupButton.addEventListener("click", startupClient);

  // Notify Server When the Browser App is open or closed
  async function browserClientOnline(status) {
    await fetch("/client-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connected: status }),
    });
  }
  // Notify server when the browser app starts
  window.addEventListener("load", () => browserClientOnline(true));
  // Notify server when the browser app closes
  window.addEventListener("beforeunload", () => browserClientOnline(false));

  // SETUP STEP 2: Request an Access Token
  async function fetchToken() {
    try {
      const response = await fetch("/token");
      const data = await response.json();
      if (data.token) {
        log("✅ Token received.");
        return data;
      } else throw new Error("No token received from server.");
    } catch (err) {
      console.error("❌ Error fetching token:", err);
      log("An error occurred. See your browser console for more information.");
      return null;
    }
  }

  async function refreshToken() {
    log("🔄 Refreshing Twilio token...");
    const data = await fetchToken();
    if (data) {
      token = data.token;
      device.updateToken(token); // Update the Twilio Device with the new token
      log("✅ Token refreshed successfully.");
    } else log("❌ Token refresh failed. Try restarting the client.");
  }

  // SETUP STEP 3:
  // Instantiate a new Twilio.Device
  async function startupClient() {
    log("Requesting Access Token...");
    const data = await fetchToken();
    if (data) {
      token = data.token;
      setClientNameUI(data.identity);
      initializeDevice();

      // Set token refresh interval only once
      if (!tokenRefreshInterval) {
        tokenRefreshInterval = setInterval(refreshToken, 14100 * 1000);
        console.log("🔄 Token refresh scheduled.");
      }
    }
  }

  function initializeDevice() {
    logDiv.classList.remove("hide");
    log("Initializing Twilio Device...");

    device = new Twilio.Device(token, {
      logLevel: 1,
      codecPreferences: ["opus", "pcmu"],
    });

    addDeviceListeners(device);

    device.on("ready", () => console.log("✅ Twilio Device is READY!"));
    device.on("error", (error) =>
      console.error("❌ Twilio Device error:", error.message),
    );
    device.on("incoming", (call) =>
      console.log("📞 Incoming call from:", call.parameters.From),
    );
    device.register();
  }

  // SETUP STEP 4:
  // Listen for Twilio.Device states
  function addDeviceListeners(device) {
    device.on("registered", function () {
      log("Twilio.Device Ready to make and receive calls!");
      callControlsDiv.classList.remove("hide");
    });

    device.on("error", function (error) {
      log("Twilio.Device Error: " + error.message);
    });

    device.on("incoming", handleIncomingCall);

    device.audio.on("deviceChange", updateAllAudioDevices.bind(device));

    // Show audio selection UI if it is supported by the browser.
    if (device.audio.isOutputSelectionSupported) {
      audioSelectionDiv.classList.remove("hide");
    }
  }

  // MAKE AN OUTGOING CALL

  async function makeOutgoingCall() {
    var params = {
      // get the phone number to call from the DOM
      To: phoneNumberInput.value,
    };

    if (device) {
      log(`Attempting to call ${params.To} ...`);

      // Twilio.Device.connect() returns a Call object
      const call = await device.connect({ params });
      activeCall = call;

      // add listeners to the Call
      // "accepted" means the call has finished connecting and the state is now "open"
      call.on("accept", updateUIAcceptedOutgoingCall);
      call.on("disconnect", updateUIDisconnectedOutgoingCall);
      call.on("cancel", updateUIDisconnectedOutgoingCall);

      outgoingCallHangupButton.onclick = () => {
        log("Hanging up ...");
        call.disconnect();
      };
    } else log("Unable to make call.");
  }

  function updateUIAcceptedOutgoingCall(call) {
    log("Call in progress ...");
    callButton.disabled = true;
    outgoingCallHangupButton.classList.remove("hide");
    volumeIndicators.classList.remove("hide");
    dtmfControlsDiv.classList.remove("hide"); // Show DTMF controls
    bindVolumeIndicators(call);
  }

  function updateUIDisconnectedOutgoingCall() {
    log("Call disconnected.");
    callButton.disabled = false;
    outgoingCallHangupButton.classList.add("hide");
    volumeIndicators.classList.add("hide");
    dtmfControlsDiv.classList.add("hide"); // Hide DTMF controls
  }

  // HANDLE INCOMING CALL

  function handleIncomingCall(call) {
    log(`Incoming call from ${call.parameters.From}`);

    //show incoming call div and incoming phone number
    incomingCallDiv.classList.remove("hide");
    incomingPhoneNumberEl.innerHTML = call.parameters.From;

    //add event listeners for Accept, Reject, and Hangup buttons
    incomingCallAcceptButton.onclick = () => {
      acceptIncomingCall(call);
    };

    incomingCallRejectButton.onclick = () => {
      rejectIncomingCall(call);
    };

    incomingCallHangupButton.onclick = () => {
      hangupIncomingCall(call);
    };

    // add event listener to call object
    call.on("cancel", handleDisconnectedIncomingCall);
    call.on("disconnect", handleDisconnectedIncomingCall);
    call.on("reject", handleDisconnectedIncomingCall);
  }

  // ACCEPT INCOMING CALL

  function acceptIncomingCall(call) {
    call.accept();
    log("Accepted incoming call.");
    incomingCallAcceptButton.classList.add("hide");
    incomingCallRejectButton.classList.add("hide");
    incomingCallHangupButton.classList.remove("hide");
  }

  // REJECT INCOMING CALL

  function rejectIncomingCall(call) {
    call.reject();
    log("Rejected incoming call");
    resetIncomingCallUI();
  }

  // HANG UP INCOMING CALL

  function hangupIncomingCall(call) {
    call.disconnect();
    log("Hanging up incoming call");
    resetIncomingCallUI();
  }

  // HANDLE CANCELLED INCOMING CALL

  function handleDisconnectedIncomingCall() {
    log("Incoming call ended.");
    resetIncomingCallUI();
  }

  async function fetchIncomingMessages() {
    try {
      const response = await fetch("/messages", { redirect: "follow" });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const messages = await response.json();

      const smsLog = document.getElementById("sms-log");
      smsLog.innerHTML = "";

      messages.forEach((message) => {
        const li = document.createElement("li");
        li.textContent = `From: ${message.from}, Message: ${message.body}`;
        smsLog.appendChild(li);
      });
    } catch (err) {
      console.error("Failed to fetch incoming messages:", err);
    }
  }

  // Periodically fetch messages (every 15 seconds)
  setInterval(fetchIncomingMessages, 15000);

  // MISC USER INTERFACE

  // Activity log
  function log(message) {
    logDiv.innerHTML += `<p class="log-entry">&gt;&nbsp; ${message} </p>`;
    logDiv.scrollTop = logDiv.scrollHeight;
  }

  function setClientNameUI(clientName) {
    var div = document.getElementById("client-name");
    div.innerHTML = `Your client name: <strong>${clientName}</strong>`;
  }

  function resetIncomingCallUI() {
    incomingPhoneNumberEl.innerHTML = "";
    incomingCallAcceptButton.classList.remove("hide");
    incomingCallRejectButton.classList.remove("hide");
    incomingCallHangupButton.classList.add("hide");
    incomingCallDiv.classList.add("hide");
  }

  // AUDIO CONTROLS

  async function getAudioDevices() {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    updateAllAudioDevices.bind(device);
  }

  function updateAllAudioDevices() {
    if (device) {
      updateDevices(speakerDevices, device.audio.speakerDevices.get());
      updateDevices(ringtoneDevices, device.audio.ringtoneDevices.get());
    }
  }

  function updateOutputDevice() {
    const selectedDevices = Array.from(speakerDevices.children)
      .filter((node) => node.selected)
      .map((node) => node.getAttribute("data-id"));

    device.audio.speakerDevices.set(selectedDevices);
  }

  function updateRingtoneDevice() {
    const selectedDevices = Array.from(ringtoneDevices.children)
      .filter((node) => node.selected)
      .map((node) => node.getAttribute("data-id"));

    device.audio.ringtoneDevices.set(selectedDevices);
  }

  function bindVolumeIndicators(call) {
    call.on("volume", function (inputVolume, outputVolume) {
      var inputColor = "red";
      if (inputVolume < 0.5) {
        inputColor = "green";
      } else if (inputVolume < 0.75) {
        inputColor = "yellow";
      }

      inputVolumeBar.style.width = Math.floor(inputVolume * 300) + "px";
      inputVolumeBar.style.background = inputColor;

      var outputColor = "red";
      if (outputVolume < 0.5) {
        outputColor = "green";
      } else if (outputVolume < 0.75) {
        outputColor = "yellow";
      }

      outputVolumeBar.style.width = Math.floor(outputVolume * 300) + "px";
      outputVolumeBar.style.background = outputColor;
    });
  }

  // Update the available ringtone and speaker devices
  function updateDevices(selectEl, selectedDevices) {
    selectEl.innerHTML = "";

    device.audio.availableOutputDevices.forEach(function (device, id) {
      var isActive = selectedDevices.size === 0 && id === "default";
      selectedDevices.forEach(function (device) {
        if (device.deviceId === id) {
          isActive = true;
        }
      });

      var option = document.createElement("option");
      option.label = device.label;
      option.setAttribute("data-id", id);
      if (isActive) {
        option.setAttribute("selected", "selected");
      }
      selectEl.appendChild(option);
    });
  }
});
