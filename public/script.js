
/* ==========================================
   MEETSPACE - COMPLETE FRONTEND SCRIPT
   Login + Meetings + WebRTC + Controls
========================================== */

const $ = (id) => document.getElementById(id);

const socket = io({
  autoConnect: false,
  reconnection: false
});

let currentUser = null;
let currentRoom = null;
let currentRole = null;

let localStream = null;
let screenStream = null;

let participants = [];
let isLeaving = false;

let selectedMainVideo = "local";
let activeScreenSharer = null;
let myHandRaised = false;
let raisedHands = new Set();

let selectedImage = null;
let imagePreviewUrl = null;
let chatVisible = true;

const peers = new Map();
const remoteStreams = new Map();
const candidateQueues = new Map();
const pendingOffers = new Set();


const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

// Load TURN servers securely through MeetSpace backend.
async function loadIceServers() {
  try {
    const firebase = await waitForFirebase();
    const token = await firebase.getUserToken();

    const response = await fetch("/api/ice-servers", {
      headers: {
        Authorization: `Bearer ${token}`
      },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`ICE API returned ${response.status}`);
    }

    const data = await response.json();

    if (!Array.isArray(data.iceServers) ||
        data.iceServers.length === 0) {
      throw new Error("No ICE servers returned");
    }

    rtcConfig.iceServers = data.iceServers;

    console.log("MeetSpace ICE configuration:", data.source);

  } catch (error) {
    console.warn("TURN setup failed. Using STUN:", error);
  }
}


/* ==========================================
   PROFESSIONAL SVG ICONS
========================================== */

const icons = {
  mic: `<svg viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="2" width="6" height="12" rx="3"/>
    <path d="M5 10a7 7 0 0 0 14 0"/>
    <path d="M12 17v5M8 22h8"/>
  </svg>`,

  micOff: `<svg viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">
    <path d="m2 2 20 20"/>
    <path d="M9 9v2a3 3 0 0 0 5 2.2"/>
    <path d="M15 9V5a3 3 0 0 0-5.8-1.1"/>
    <path d="M5 10a7 7 0 0 0 12 4.9"/>
    <path d="M12 17v5M8 22h8"/>
  </svg>`,

  video: `<svg viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="5" width="15" height="14" rx="2"/>
    <path d="m17 10 5-3v10l-5-3"/>
  </svg>`,

  videoOff: `<svg viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">
    <path d="m2 2 20 20"/>
    <path d="M10 5h5a2 2 0 0 1 2 2v3"/>
    <path d="M17 14v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7"/>
    <path d="m17 10 5-3v10l-5-3"/>
  </svg>`,

  screen: `<svg viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="3" width="20" height="15" rx="2"/>
    <path d="M8 22h8M12 18v4"/>
    <path d="m9 12 3-3 3 3M12 9v6"/>
  </svg>`,

  hand: `<svg viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 13V5a2 2 0 0 1 4 0v6"/>
    <path d="M12 11V4a2 2 0 0 1 4 0v7"/>
    <path d="M16 11V6a2 2 0 0 1 4 0v9"/>
    <path d="M8 10a2 2 0 0 0-4 0v6"/>
    <path d="M4 16c0 4 3 6 7 6h3c4 0 6-3 6-7"/>
  </svg>`,

  chat: `<svg viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5"/>
    <path d="M12.5 20a9 9 0 0 1-4-.9L3 21l1.9-4.5"/>
    <path d="M4.9 16.5A8.5 8.5 0 1 1 21 11.5"/>
  </svg>`,

  leave: `<svg viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 16.5v3a2 2 0 0 1-2.2 2"/>
    <path d="M4.2 21.5A2 2 0 0 1 2 19.5v-3"/>
    <path d="M2 16.5a10 10 0 0 1 20 0"/>
    <path d="M2 16.5h5l1.5 3-2 2"/>
    <path d="M22 16.5h-5l-1.5 3 2 2"/>
  </svg>`
};

/* ==========================================
   STATUS + SCREEN VISIBILITY
========================================== */

function status(message) {
  if ($("status")) {
    $("status").textContent = message;
  }
}

function showSection(sectionId) {
  const sections = [
    "loginSection",
    "homeSection",
    "waitingSection",
    "meetingSection"
  ];

  sections.forEach((id) => {
    const section = $(id);
    if (section) section.hidden = id !== sectionId;
  });

  const meetingView =
    sectionId === "meetingSection" ||
    sectionId === "waitingSection";

  document.body.classList.toggle(
    "meeting-view",
    meetingView
  );

  document.body.dataset.view =
    sectionId === "meetingSection"
      ? "meeting"
      : sectionId === "waitingSection"
        ? "waiting"
        : "home";

  if ($("home")) {
    $("home").hidden = meetingView;
  }

  if (meetingView) {
    window.scrollTo({ top: 0, behavior: "instant" });
  }
}

/* ==========================================
   SERVER REQUEST
========================================== */

function request(eventName, data, timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (!socket.connected) {
      reject(new Error("Server is not connected."));
      return;
    }

    socket.timeout(timeout).emit(
      eventName,
      data,
      (error, response) => {
        if (error) {
          reject(new Error(
            "Server did not respond. Backend update may be required."
          ));
          return;
        }

        resolve(response || {
          ok: false,
          error: "Unknown server response."
        });
      }
    );
  });
}

/* ==========================================
   FIREBASE AUTH
========================================== */

async function waitForFirebase() {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (window.meetspaceAuth) {
      await window.meetspaceAuth.authReady;
      return window.meetspaceAuth;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }

  throw new Error("Firebase authentication could not load.");
}

function savedGuestName(uid) {
  try {
    return localStorage.getItem(
      "meetspace-guest-name-" + uid
    );
  } catch {
    return null;
  }
}

function setUser(name, user) {
  currentUser = {
    uid: user.uid,
    name,
    email: user.email || null,
    isGuest: !!user.isAnonymous
  };

  $("userInfo").textContent =
    name + (user.isAnonymous ? " (Guest)" : "");

  showSection("homeSection");
  status("Signed in as " + name);
}

$("googleLoginBtn").addEventListener("click", async () => {
  const button = $("googleLoginBtn");
  button.disabled = true;

  try {
    status("Signing in with Google...");

    const firebase = await waitForFirebase();
    const user = await firebase.loginWithGoogle();

    setUser(
      user.displayName || user.email || "Google User",
      user
    );
  } catch (error) {
    console.error(error);
    status("Google sign-in failed: " + error.message);
  } finally {
    button.disabled = false;
  }
});

$("guestLoginBtn").addEventListener("click", () => {
  $("guestNameSection").hidden = false;
  $("guestName").focus();
});

$("guestContinueBtn").addEventListener("click", async () => {
  const name = $("guestName").value.trim();

  if (!name) {
    status("Please enter your name.");
    $("guestName").focus();
    return;
  }

  const button = $("guestContinueBtn");
  button.disabled = true;

  try {
    const firebase = await waitForFirebase();
    const user = await firebase.loginAsGuest();

    try {
      localStorage.setItem(
        "meetspace-guest-name-" + user.uid,
        name
      );
    } catch {}

    setUser(name, user);
  } catch (error) {
    console.error(error);
    status("Guest login failed: " + error.message);
  } finally {
    button.disabled = false;
  }
});

$("guestName").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    $("guestContinueBtn").click();
  }
});

async function restoreFirebaseSession() {
  try {
    const firebase = await waitForFirebase();

    firebase.onAuthStateChanged(
      firebase.auth,
      (user) => {
        if (!user || currentUser) return;

        if (user.isAnonymous) {
          const name = savedGuestName(user.uid);

          if (name) {
            setUser(name, user);
          } else {
            $("guestNameSection").hidden = false;
            status("Enter your guest name.");
          }
          return;
        }

        setUser(
          user.displayName || user.email || "Google User",
          user
        );
      }
    );
  } catch (error) {
    console.error(error);
    status(error.message);
  }
}

/* ==========================================
   SOCKET CONNECTION
========================================== */

async function connectSocket() {
  if (socket.connected) return;

  if (!currentUser) {
    throw new Error("Please sign in first.");
  }

  const firebase = await waitForFirebase();
  const credential = await firebase.getUserToken();
  await loadIceServers();

  socket.auth = {
    name: currentUser.name,
    credential
  };

  await new Promise((resolve, reject) => {
    const onConnect = () => {
      socket.off("connect_error", onError);
      resolve();
    };

    const onError = (error) => {
      socket.off("connect", onConnect);
      reject(error);
    };

    socket.once("connect", onConnect);
    socket.once("connect_error", onError);
    socket.connect();
  });
}

/* ==========================================
   MEETING HELPERS
========================================== */

function meetingLink(roomId) {
  return (
    location.origin +
    "/?room=" +
    encodeURIComponent(roomId)
  );
}

function updateRole(role) {
  currentRole = role;
  $("roleText").textContent = "Role: " + role;

  $("hostPanel").hidden =
    role !== "host" && role !== "admin";

  updateScreenControl();
}

function enterMeeting(roomId, role) {
  currentRoom = roomId;
  $("roomText").textContent = roomId;

  updateRole(role);
  showSection("meetingSection");

  history.replaceState(
    {},
    "",
    meetingLink(roomId)
  );
}

/* ==========================================
   MEETING CONTROL ICON + TEXT
========================================== */

function control(id, iconName, label, isOff = false) {
  const button = $(id);
  if (!button) return;

  const icon = button.querySelector(".ms-control-icon");
  const text = button.querySelector(".ms-control-label");

  if (icon && text) {
    icon.innerHTML = icons[iconName] || "";
    text.textContent = label;
  } else {
    button.innerHTML =
      `<span class="ms-control-icon">${icons[iconName] || ""}</span>` +
      `<span class="ms-control-label"></span>`;

    button.querySelector(
      ".ms-control-label"
    ).textContent = label;
  }

  button.classList.toggle("is-off", isOff);
  button.setAttribute("aria-label", label);
}

function updateMicControl() {
  const track = localStream?.getAudioTracks()[0];

  $("micBtn").disabled = !track;

  control(
    "micBtn",
    track?.enabled ? "mic" : "micOff",
    !track ? "Mic Unavailable" :
      track.enabled ? "Mute" : "Unmute",
    !track?.enabled
  );
}

function updateCameraControl() {
  const track = localStream?.getVideoTracks()[0];

  $("cameraBtn").disabled = !track;

  control(
    "cameraBtn",
    track?.enabled ? "video" : "videoOff",
    !track ? "Camera Unavailable" :
      track.enabled ? "Stop Video" : "Start Video",
    !track?.enabled
  );
}

function updateScreenControl() {
  let label = "Share Screen";

  if (screenStream) {
    label = "Stop Sharing";
  } else if (
    currentRole &&
    !["host", "admin"].includes(currentRole)
  ) {
    label = "Request Share";
  }

  control("screenBtn", "screen", label);

  $("screenBtn").classList.toggle(
    "is-active",
    !!screenStream
  );
}

function updateHandControl() {
  control(
    "raiseHandBtn",
    "hand",
    myHandRaised ? "Lower Hand" : "Raise Hand"
  );

  $("raiseHandBtn").classList.toggle(
    "is-active",
    myHandRaised
  );

  $("raiseHandBtn").setAttribute(
    "aria-pressed",
    String(myHandRaised)
  );
}

/* ==========================================
   VIDEO DISPLAY
========================================== */

function createVideo(id, name, stream, isLocal = false) {
  const elementId = "video-" + id;
  let box = document.getElementById(elementId);

  if (!box) {
    box = document.createElement("div");
    box.id = elementId;
    box.className = "video-box";

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isLocal;

    const label = document.createElement("span");
    label.className = "video-label";

    box.append(video, label);

    $("videoGrid").appendChild(box);

    box.addEventListener("click", () => {
      selectedMainVideo = id;
      renderVideoLayout();
    });
  }

  const video = box.querySelector("video");
  const label = box.querySelector(".video-label");

  label.textContent = name;

  const displayStream =
    isLocal && screenStream
      ? screenStream
      : stream;

  if (video.srcObject !== displayStream) {
    video.srcObject = displayStream;
  }

  video.muted = isLocal;

  video.play().catch((error) => {
    console.warn("Media playback:", error);
  });

  renderVideoLayout();
}

function renderVideoLayout() {
  const main = $("mainVideoStage");
  const grid = $("videoGrid");

  if (!main || !grid) return;

  const localBox = $("video-local");
  const sharedId = activeScreenSharer;

  const desiredId =
    sharedId || selectedMainVideo || "local";

  const desiredBox =
    document.getElementById("video-" + desiredId) ||
    localBox ||
    grid.querySelector(".video-box") ||
    main.querySelector(".video-box");

  if (!desiredBox) return;

  const currentMain = main.querySelector(".video-box");

  if (currentMain && currentMain !== desiredBox) {
    grid.prepend(currentMain);
  }

  if (desiredBox.parentElement !== main) {
    main.appendChild(desiredBox);
  }

  main.querySelectorAll(".video-box").forEach((box) => {
    if (box !== desiredBox) {
      grid.appendChild(box);
    }
  });

  grid.querySelectorAll(".video-box").forEach((box) => {
    box.classList.remove("is-selected");
  });
}

function showScreenBanner(name) {
  const banner = $("screenShareBanner");

  if (!banner) return;

  banner.hidden = !name;

  if (name) {
    $("screenShareName").textContent =
      name + " is sharing their screen";
  }
}

/* ==========================================
   CAMERA + MICROPHONE
========================================== */

async function startMedia() {
  if (localStream) return;

  try {
    localStream =
      await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
  } catch (error) {
    console.warn("Camera + microphone:", error);

    try {
      localStream =
        await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false
        });

      status("Camera enabled. Microphone unavailable.");
    } catch {
      try {
        localStream =
          await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: true
          });

        status("Microphone enabled. Camera unavailable.");
      } catch {
        localStream = new MediaStream();
        status("Allow camera and microphone permissions.");
      }
    }
  }

  selectedMainVideo = "local";

  createVideo(
    "local",
    currentUser.name + " (You)",
    localStream,
    true
  );

  updateMicControl();
  updateCameraControl();
  updateScreenControl();

  if (socket.connected && currentRoom) {
    socket.emit("media-ready");
  }

  for (const id of [...pendingOffers]) {
    pendingOffers.delete(id);

    callPeer(id).catch((error) => {
      console.error("Deferred connection:", error);
    });
  }
}

/* ==========================================
   WEBRTC CONNECTIONS
========================================== */

function removePeer(id) {
  const peer = peers.get(id);

  if (peer) peer.close();

  peers.delete(id);
  remoteStreams.delete(id);
  candidateQueues.delete(id);
  pendingOffers.delete(id);

  $("video-" + id)?.remove();

  if (selectedMainVideo === id) {
    selectedMainVideo = "local";
  }

  if (activeScreenSharer === id) {
    activeScreenSharer = null;
    showScreenBanner(null);
  }

  renderVideoLayout();
}

function createPeer(id) {
  if (peers.has(id)) {
    return peers.get(id);
  }

  const peer = new RTCPeerConnection(rtcConfig);

  peers.set(id, peer);
  candidateQueues.set(id, []);

  const remoteStream = new MediaStream();

  remoteStreams.set(id, remoteStream);

  const person = participants.find(
    (item) => item.id === id
  );

  const name = person?.name || "Participant";

  createVideo(id, name, remoteStream);

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      peer.addTrack(track, localStream);
    });
  }

  peer.ontrack = (event) => {
    const tracks =
      event.streams[0]?.getTracks() ||
      [event.track];

    tracks.forEach((track) => {
      const exists =
        remoteStream.getTracks().some(
          (existing) => existing.id === track.id
        );

      if (!exists) {
        remoteStream.addTrack(track);
      }
    });

    createVideo(id, name, remoteStream);

    const video = $("video-" + id)?.querySelector(
      "video"
    );

    if (video) {
      video.muted = false;

      video.play().catch(() => {
        status(
          "Click the participant video to enable sound."
        );
      });
    }
  };

  peer.onicecandidate = (event) => {
    if (!event.candidate) return;

    socket.emit("signal", {
      to: id,
      signal: {
        type: "candidate",
        candidate: event.candidate
      }
    });
  };

  peer.onconnectionstatechange = () => {
    if (peer.connectionState === "failed") {
      console.warn("WebRTC connection failed:", id);

      status(
        "A video connection failed. A TURN server may be needed."
      );
    }
  };

  return peer;
}

async function callPeer(id) {
  if (
    !currentRoom ||
    !id ||
    id === socket.id ||
    peers.has(id)
  ) {
    return;
  }

  if (!localStream) {
    pendingOffers.add(id);
    return;
  }

  const peer = createPeer(id);

  const offer = await peer.createOffer();

  await peer.setLocalDescription(offer);

  socket.emit("signal", {
    to: id,
    signal: {
      type: "offer",
      sdp: peer.localDescription
    }
  });
}

async function flushCandidates(id, peer) {
  if (!peer.remoteDescription) return;

  const queue = candidateQueues.get(id) || [];

  candidateQueues.set(id, []);

  for (const candidate of queue) {
    await peer.addIceCandidate(candidate);
  }
}

socket.on("signal", async ({ from, signal } = {}) => {
  if (!currentRoom || !signal || !from) return;

  if (!localStream) {
    console.warn("Received signaling before local media");
    return;
  }

  try {
    const peer = createPeer(from);

    if (signal.type === "offer") {
      await peer.setRemoteDescription(signal.sdp);
      await flushCandidates(from, peer);

      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);

      socket.emit("signal", {
        to: from,
        signal: {
          type: "answer",
          sdp: peer.localDescription
        }
      });
    }

    if (signal.type === "answer") {
      await peer.setRemoteDescription(signal.sdp);
      await flushCandidates(from, peer);
    }

    if (signal.type === "candidate") {
      if (peer.remoteDescription) {
        await peer.addIceCandidate(signal.candidate);
      } else {
        candidateQueues.get(from).push(
          signal.candidate
        );
      }
    }
  } catch (error) {
    console.error("WebRTC signaling:", error);
    status("Video connection issue: " + error.message);
  }
});

socket.on("peer-ready", ({ id } = {}) => {
  if (!currentRoom || !id) return;

  callPeer(id).catch((error) => {
    console.error("Peer connection:", error);
  });
});

/* ==========================================
   CREATE MEETING
========================================== */

function showErrorToast(inputId, message) {
  const input = $(inputId);
  const card = input?.closest(".option-card");

  if (!card) {
    status(message);
    return;
  }

  card.querySelector(".validation-tooltip")?.remove();

  input.classList.add("input-error");

  const toast = document.createElement("div");
  toast.className = "validation-tooltip";
  toast.setAttribute("role", "alert");
  toast.textContent = "⚠ " + message;

  card.appendChild(toast);

  const cardRect = card.getBoundingClientRect();
  const inputRect = input.getBoundingClientRect();

  const toastHeight = toast.getBoundingClientRect().height;

  toast.style.top = Math.max(
    8,
    inputRect.top - cardRect.top - toastHeight - 13
  ) + "px";

  toast.style.right = "12px";

  input.focus();

  setTimeout(() => {
    toast.classList.add("toast-hide");

    setTimeout(() => {
      toast.remove();
      input.classList.remove("input-error");
    }, 250);
  }, 4000);
}

$("createBtn").addEventListener("click", async () => {
  const password = $("createPassword").value;

  if (password.length < 4 || password.length > 64) {
    showErrorToast(
      "createPassword",
      "Password must be between 4 and 64 characters."
    );
    return;
  }

  const button = $("createBtn");
  button.disabled = true;

  try {
    status("Creating your meeting...");

    await connectSocket();

    const result = await request(
      "create-room",
      { password }
    );

    if (!result.ok) {
      throw new Error(result.error);
    }

    enterMeeting(result.roomId, "host");

    renderParticipants(result.participants || []);

    await startMedia();

    status(
      "Meeting created. Share the invite link and password."
    );
  } catch (error) {
    console.error(error);
    status(error.message);
  } finally {
    button.disabled = false;
  }
});

/* ==========================================
   JOIN MEETING
========================================== */

$("joinBtn").addEventListener("click", async () => {
  const roomId = $("roomInput").value.trim();
  const password = $("joinPassword").value;

  if (!roomId) {
    status("Please enter a Meeting ID.");
    $("roomInput").focus();
    return;
  }

  if (!password) {
    showErrorToast(
      "joinPassword",
      "Please enter the meeting password."
    );
    return;
  }

  const button = $("joinBtn");
  button.disabled = true;

  try {
    status("Sending join request...");

    await connectSocket();

    const result = await request(
      "request-join",
      { roomId, password }
    );

    if (!result.ok) {
      throw new Error(result.error);
    }

    currentRoom = roomId;

    showSection("waitingSection");

    status("Waiting for host or admin approval.");
  } catch (error) {
    console.error(error);
    status(error.message);
  } finally {
    button.disabled = false;
  }
});

/* ==========================================
   MEETING EVENTS
========================================== */

socket.on("join-approved", async (data) => {
  try {
    enterMeeting(
      data.roomId,
      data.role || "participant"
    );

    await startMedia();

    status("Your request has been approved.");
  } catch (error) {
    console.error(error);
    status(error.message);
  }
});

socket.on("join-rejected", () => {
  resetMeeting();
  status("Your meeting request was rejected.");
});

socket.on("meeting-ended", () => {
  resetMeeting();
  status("The host has ended this meeting.");
});

socket.on("role-updated", (role) => {
  updateRole(role);
  renderParticipants(participants);
  status("Your role is now " + role);
});

socket.on("user-joined", () => {
  status("A participant joined the meeting.");
});

socket.on("user-left", (id) => {
  removePeer(id);
  raisedHands.delete(id);
  updateRaisedHandsUI();
  status("A participant left the meeting.");
});

/* ==========================================
   HOST ACTION BUTTONS
========================================== */

function actionButton(label, eventName, targetId) {
  const button = document.createElement("button");

  button.type = "button";
  button.textContent = label;

  button.addEventListener("click", async () => {
    button.disabled = true;

    try {
      const result = await request(
        eventName,
        targetId
      );

      if (!result.ok) {
        throw new Error(result.error);
      }

      status(label + " successful.");
    } catch (error) {
      status(error.message);
    } finally {
      button.disabled = false;
    }
  });

  return button;
}

/* ==========================================
   PARTICIPANTS
========================================== */

function renderParticipants(list) {
  participants = Array.isArray(list) ? list : [];

  const container = $("participantList");
  container.replaceChildren();

  if ($("participantCount")) {
    $("participantCount").textContent =
      "(" + participants.length + ")";
  }

  for (const person of participants) {
    const row = document.createElement("div");
    row.className = "participant-item";

    const details = document.createElement("div");
    details.className = "participant-details";

    const name = document.createElement("span");
    name.className = "participant-name";
    name.textContent =
      person.name +
      (person.id === socket.id ? " (You)" : "") +
      (raisedHands.has(person.id) ? " ✋" : "");

    const role = document.createElement("span");
    role.className = "participant-role";
    role.textContent = person.role;

    details.append(name, role);
    row.appendChild(details);

    if (
      currentRole === "host" &&
      person.id !== socket.id
    ) {
      const actions = document.createElement("div");
      actions.className = "participant-actions";

      actions.append(
        actionButton(
          "Make Admin",
          "assign-admin",
          person.id
        ),
        actionButton(
          "Make Host",
          "transfer-host",
          person.id
        )
      );

      row.appendChild(actions);
    }

    if (
      ["host", "admin"].includes(currentRole) &&
      person.id !== socket.id
    ) {
      const actions =
        row.querySelector(".participant-actions") ||
        document.createElement("div");

      actions.className = "participant-actions";

      actions.appendChild(
        actionButton(
          "Mute",
          "mute-participant",
          person.id
        )
      );

      if (!actions.parentElement) {
        row.appendChild(actions);
      }
    }

    container.appendChild(row);

    const box = $("video-" + person.id);

    if (box) {
      box.querySelector(".video-label").textContent =
        person.name;
    }
  }

  updateChatRecipients(participants);
  updateRaisedHandsUI();
}

socket.on("participants-updated", (data) => {
  renderParticipants(data.participants || []);
});

/* ==========================================
   PARTICIPANTS COLLAPSE
========================================== */

$("participantsToggle").addEventListener("click", () => {
  const body = $("participantsBody");
  const button = $("participantsToggle");

  body.hidden = !body.hidden;

  button.textContent = body.hidden ? "⌄" : "⌃";

  button.setAttribute(
    "aria-expanded",
    String(!body.hidden)
  );

  button.setAttribute(
    "aria-label",
    body.hidden ? "Show participants" : "Hide participants"
  );
});

/* ==========================================
   WAITING ROOM
========================================== */

socket.on("waiting-updated", (waiting) => {
  const container = $("waitingList");
  container.replaceChildren();

  if (!Array.isArray(waiting) || !waiting.length) {
    const message = document.createElement("p");
    message.textContent = "No pending requests";
    container.appendChild(message);
    return;
  }

  for (const user of waiting) {
    const row = document.createElement("div");
    row.className = "waiting-item";

    const name = document.createElement("span");
    name.textContent = user.name;

    const actions = document.createElement("div");
    actions.className = "waiting-actions";

    actions.append(
      actionButton("Approve", "approve-request", user.id),
      actionButton("Reject", "reject-request", user.id)
    );

    row.append(name, actions);
    container.appendChild(row);
  }
});

/* ==========================================
   HAND RAISE
   Requires next server.js update
========================================== */

function updateRaisedHandsUI() {
  const count = raisedHands.size;

  $("raisedHandCount").textContent = count;

  $("raisedHandsBar").hidden = count === 0;

  const names = participants
    .filter((person) => raisedHands.has(person.id))
    .map((person) => person.name);

  $("raisedHandsNames").textContent = names.join(", ");

  document.querySelectorAll(".video-box").forEach((box) => {
    const id = box.id.replace(/^video-/, "");

    let hand = box.querySelector(".hand-indicator");

    if (raisedHands.has(id)) {
      if (!hand) {
        hand = document.createElement("span");
        hand.className = "hand-indicator";
        hand.textContent = "✋";
        box.appendChild(hand);
      }
    } else {
      hand?.remove();
    }
  });
}

$("raiseHandBtn").addEventListener("click", async () => {
  if (!currentRoom) return;

  const next = !myHandRaised;

  try {
    const result = await request(
      "raise-hand",
      { raised: next }
    );

    if (!result.ok) {
      throw new Error(result.error);
    }

    myHandRaised = next;
    updateHandControl();
  } catch (error) {
    status(error.message);
  }
});

socket.on("hands-updated", (data) => {
  raisedHands = new Set(
    Array.isArray(data?.ids) ? data.ids : []
  );

  myHandRaised = raisedHands.has(socket.id);

  updateHandControl();
  updateRaisedHandsUI();
  renderParticipants(participants);
});

/* ==========================================
   PUBLIC + PRIVATE CHAT
========================================== */

const chatRecipient = $("chatRecipient");
const chatMessages = $("chatMessages");
const chatInput = $("chatInput");
const chatSendBtn = $("chatSendBtn");

function updateChatRecipients(list) {
  const previous = chatRecipient.value;

  chatRecipient.replaceChildren();

  const everyone = document.createElement("option");
  everyone.value = "everyone";
  everyone.textContent = "Everyone (Public)";

  chatRecipient.appendChild(everyone);

  for (const person of list || []) {
    if (person.id === socket.id) continue;

    const option = document.createElement("option");
    option.value = person.id;
    option.textContent = person.name + " (Private)";

    chatRecipient.appendChild(option);
  }

  const exists = [...chatRecipient.options].some(
    (option) => option.value === previous
  );

  chatRecipient.value = exists
    ? previous
    : "everyone";
}

function displayChatMessage(message) {
  if (!currentRoom) return;

  chatMessages.querySelector(".chat-empty")?.remove();

  const mine = message.from === socket.id;

  const bubble = document.createElement("div");
  bubble.className = "chat-message";

  if (mine) bubble.classList.add("mine");
  if (message.private) bubble.classList.add("private");

  const header = document.createElement("div");
  header.className = "chat-message-header";

  const name = document.createElement("span");
  name.className = "chat-message-name";

  name.textContent = mine
    ? "You"
    : message.fromName || "Participant";

  const type = document.createElement("span");
  type.className = "chat-message-type";

  type.textContent = message.private
    ? mine
      ? "🔒 Private to " + message.toName
      : "🔒 Private to you"
    : "Everyone";

  header.append(name, type);
  bubble.appendChild(header);

  if (message.text) {
    const text = document.createElement("div");
    text.className = "chat-message-text";
    text.textContent = message.text;
    bubble.appendChild(text);
  }

  if (
    typeof message.image === "string" &&
    message.image.startsWith("data:image/")
  ) {
    const image = document.createElement("img");
    image.src = message.image;
    image.alt = "Shared chat image";
    image.loading = "lazy";

    bubble.appendChild(image);
  }

  const time = document.createElement("span");
  time.className = "chat-message-time";

  time.textContent = new Date(
    message.timestamp || Date.now()
  ).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });

  bubble.appendChild(time);
  chatMessages.appendChild(bubble);

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

socket.on("chat-message", displayChatMessage);

/* ==========================================
   CHAT IMAGE SELECT + PREVIEW
========================================== */

$("attachImageBtn").addEventListener("click", () => {
  $("chatImageInput").click();
});

function clearSelectedImage() {
  selectedImage = null;
  $("chatImageInput").value = "";

  if (imagePreviewUrl) {
    URL.revokeObjectURL(imagePreviewUrl);
    imagePreviewUrl = null;
  }

  $("chatImageThumbnail").removeAttribute("src");
  $("chatImagePreview").hidden = true;
}

$("removeChatImageBtn").addEventListener(
  "click",
  clearSelectedImage
);

$("chatImageInput").addEventListener("change", () => {
  const file = $("chatImageInput").files[0];

  if (!file) return;

  const allowed = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif"
  ];

  if (!allowed.includes(file.type)) {
    status("Only JPG, PNG, WEBP and GIF images are allowed.");
    clearSelectedImage();
    return;
  }

  if (file.size > 2 * 1024 * 1024) {
    status("Image must be smaller than 2 MB.");
    clearSelectedImage();
    return;
  }

  clearSelectedImage();

  selectedImage = file;
  imagePreviewUrl = URL.createObjectURL(file);

  $("chatImageThumbnail").src = imagePreviewUrl;
  $("chatImageFilename").textContent = file.name;
  $("chatImagePreview").hidden = false;
});

function imageToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(
      new Error("Could not read image.")
    );

    reader.readAsDataURL(file);
  });
}

/* ==========================================
   SEND CHAT
========================================== */

$("chatForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!socket.connected || !currentRoom) {
    status("Join a meeting before sending messages.");
    return;
  }

  const text = chatInput.value.trim();

  if (!text && !selectedImage) return;

  chatSendBtn.disabled = true;

  try {
    const data = {
      text,
      to: chatRecipient.value
    };

    if (selectedImage) {
      data.image = await imageToDataURL(selectedImage);
    }

    const result = await request(
      "chat-message",
      data,
      selectedImage ? 20000 : 10000
    );

    if (!result.ok) {
      throw new Error(result.error);
    }

    chatInput.value = "";
    clearSelectedImage();
    chatInput.focus();
  } catch (error) {
    console.error("Chat error:", error);
    status("Message failed: " + error.message);
  } finally {
    chatSendBtn.disabled = false;
  }
});

function clearMeetingChat() {
  chatMessages.replaceChildren();

  const empty = document.createElement("div");
  empty.className = "chat-empty";
  empty.textContent = "No messages yet. Start a conversation!";

  chatMessages.appendChild(empty);

  updateChatRecipients([]);
  chatInput.value = "";
  chatSendBtn.disabled = false;
  clearSelectedImage();
}

/* ==========================================
   CHAT SHOW / HIDE
========================================== */

$("toggleChatBtn").addEventListener("click", () => {
  chatVisible = !chatVisible;

  $("chatPanel").hidden = !chatVisible;

  $("toggleChatBtn").setAttribute(
    "aria-expanded",
    String(chatVisible)
  );

  $("toggleChatBtn").classList.toggle(
    "is-active",
    chatVisible
  );
});

/* ==========================================
   INVITE LINK
========================================== */

$("copyBtn").addEventListener("click", async () => {
  if (!currentRoom) return;

  try {
    await navigator.clipboard.writeText(
      meetingLink(currentRoom)
    );

    $("copyBtn").textContent = "✓ Copied!";

    status(
      "Invite link copied. Share the password separately."
    );

    setTimeout(() => {
      $("copyBtn").textContent = "⧉ Copy Invite Link";
    }, 2500);
  } catch {
    status("Unable to copy invite link.");
  }
});

/* ==========================================
   MIC CONTROL
========================================== */

$("micBtn").addEventListener("click", () => {
  const track = localStream?.getAudioTracks()[0];

  if (!track) return;

  track.enabled = !track.enabled;

  updateMicControl();
});

/* ==========================================
   CAMERA CONTROL
========================================== */

$("cameraBtn").addEventListener("click", () => {
  const track = localStream?.getVideoTracks()[0];

  if (!track) return;

  track.enabled = !track.enabled;

  updateCameraControl();
});

/* ==========================================
   HOST / ADMIN MUTE
   Server will enforce permissions next
========================================== */

socket.on("force-mute", () => {
  const track = localStream?.getAudioTracks()[0];

  if (track) {
    track.enabled = false;
    updateMicControl();
    status("A host or admin muted your microphone.");
  }
});

/* ==========================================
   SCREEN SHARE
========================================== */

async function startScreenShare() {
  if (!currentRoom || screenStream) return;

  const stream =
    await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false
    });

  const track = stream.getVideoTracks()[0];

  if (!track) {
    stream.getTracks().forEach((item) => item.stop());
    throw new Error("No screen track was captured.");
  }

  screenStream = stream;

  try {
    for (const peer of peers.values()) {
      const sender = peer.getSenders().find(
        (item) => item.track?.kind === "video"
      );

      if (sender) {
        await sender.replaceTrack(track);
      }
    }

    activeScreenSharer = "local";
    selectedMainVideo = "local";

    createVideo(
      "local",
      currentUser.name + " (Screen)",
      localStream,
      true
    );

    showScreenBanner(currentUser.name);

    socket.emit("screen-share-state", {
      sharing: true
    });

    track.onended = () => {
      stopScreenShare().catch(console.error);
    };

    updateScreenControl();

    status("Screen sharing started.");
  } catch (error) {
    screenStream = null;
    stream.getTracks().forEach((item) => item.stop());
    throw error;
  }
}

async function stopScreenShare() {
  if (!screenStream) return;

  const previous = screenStream;
  screenStream = null;

  const cameraTrack =
    localStream?.getVideoTracks()[0] || null;

  for (const peer of peers.values()) {
    const sender = peer.getSenders().find(
      (item) => item.track?.kind === "video"
    );

    if (sender) {
      await sender.replaceTrack(cameraTrack);
    }
  }

  previous.getTracks().forEach((track) => track.stop());

  activeScreenSharer = null;
  selectedMainVideo = "local";

  createVideo(
    "local",
    currentUser.name + " (You)",
    localStream,
    true
  );

  showScreenBanner(null);

  socket.emit("screen-share-state", {
    sharing: false
  });

  updateScreenControl();
  status("Screen sharing stopped.");
}

$("screenBtn").addEventListener("click", async () => {
  if (!currentRoom) return;

  $("screenBtn").disabled = true;

  try {
    if (screenStream) {
      await stopScreenShare();
      return;
    }

    if (["host", "admin"].includes(currentRole)) {
      await startScreenShare();
      return;
    }

    const result = await request(
      "request-screen-share",
      {}
    );

    if (!result.ok) {
      throw new Error(result.error);
    }

    status("Screen share request sent to host/admin.");
  } catch (error) {
    console.error(error);
    status("Screen sharing: " + error.message);
  } finally {
    $("screenBtn").disabled = false;
  }
});

/* ==========================================
   SHARE APPROVAL EVENTS
   Backend support required
========================================== */

socket.on("screen-share-request", (data) => {
  if (!["host", "admin"].includes(currentRole)) return;

  const container = $("screenShareRequests");
  if (!container || !data?.id) return;

  if (document.getElementById("share-" + data.id)) {
    return;
  }

  const row = document.createElement("div");
  row.id = "share-" + data.id;
  row.className = "waiting-item";

  const name = document.createElement("span");
  name.textContent =
    (data.name || "Participant") + " wants to share screen";

  const actions = document.createElement("div");
  actions.className = "waiting-actions";

  const approve = actionButton(
    "Approve",
    "approve-screen-share",
    data.id
  );

  const reject = actionButton(
    "Reject",
    "reject-screen-share",
    data.id
  );

  actions.append(approve, reject);
  row.append(name, actions);
  container.appendChild(row);
});

socket.on("screen-share-approved", async () => {
  try {
    await startScreenShare();
  } catch (error) {
    status("Could not share screen: " + error.message);
  }
});

socket.on("screen-share-rejected", () => {
  status("Your screen share request was rejected.");
});

socket.on("screen-share-updated", (data) => {
  if (!data) return;

  if (data.sharing) {
    activeScreenSharer = data.id || null;

    const person = participants.find(
      (item) => item.id === data.id
    );

    showScreenBanner(person?.name || "Participant");
  } else {
    activeScreenSharer = null;
    showScreenBanner(null);
  }

  renderVideoLayout();
});

/* ==========================================
   RESET MEETING
========================================== */

function resetMeeting() {
  if (isLeaving) return;

  isLeaving = true;

  for (const id of [...peers.keys()]) {
    removePeer(id);
  }

  if (screenStream) {
    screenStream.getTracks().forEach(
      (track) => track.stop()
    );
    screenStream = null;
  }

  if (localStream) {
    localStream.getTracks().forEach(
      (track) => track.stop()
    );
    localStream = null;
  }

  currentRoom = null;
  currentRole = null;
  participants = [];

  selectedMainVideo = "local";
  activeScreenSharer = null;
  myHandRaised = false;
  raisedHands.clear();
  pendingOffers.clear();

  $("mainVideoStage").replaceChildren();
  $("videoGrid").replaceChildren();
  $("participantList").replaceChildren();
  $("waitingList").replaceChildren();

  $("screenShareRequests")?.replaceChildren();

  $("participantCount").textContent = "0";
  $("participantsBody").hidden = false;

  $("participantsToggle").textContent = "⌃";
  $("participantsToggle").setAttribute(
    "aria-expanded", "true"
  );

  $("chatPanel").hidden = false;
  chatVisible = true;

  $("toggleChatBtn").setAttribute(
    "aria-expanded", "true"
  );

  showScreenBanner(null);
  updateRaisedHandsUI();
  updateHandControl();
  updateScreenControl();

  control("micBtn", "mic", "Mute");
  control("cameraBtn", "video", "Stop Video");

  $("micBtn").disabled = false;
  $("cameraBtn").disabled = false;

  $("copyBtn").textContent = "⧉ Copy Invite Link";

  clearMeetingChat();

  if (socket.connected) {
    socket.disconnect();
  }

  history.replaceState(
    {},
    "",
    location.pathname
  );

  showSection(
    currentUser ? "homeSection" : "loginSection"
  );

  isLeaving = false;
}

/* ==========================================
   LEAVE / CANCEL MEETING
========================================== */

$("leaveBtn").addEventListener("click", () => {
  if (socket.connected) {
    socket.emit("leave-room");
  }

  resetMeeting();
  status("You left the meeting.");
});

$("cancelWaitingBtn").addEventListener("click", () => {
  if (socket.connected) {
    socket.emit("leave-room");
  }

  resetMeeting();
  status("Join request cancelled.");
});

/* ==========================================
   DISCONNECT
========================================== */

socket.on("disconnect", () => {
  if (currentRoom && !isLeaving) {
    resetMeeting();

    status(
      "Disconnected from server. Please rejoin."
    );
  }
});

/* ==========================================
   INVITATION LINK
========================================== */

const urlParams = new URLSearchParams(location.search);
const invitedRoom = urlParams.get("room");

if (invitedRoom) {
  $("roomInput").value = invitedRoom;

  status(
    "Meeting invitation detected. Sign in to continue."
  );
}

/* ==========================================
   INITIALIZE
========================================== */

control("micBtn", "mic", "Mute");
control("cameraBtn", "video", "Stop Video");
control("screenBtn", "screen", "Share Screen");
control("raiseHandBtn", "hand", "Raise Hand");
control("toggleChatBtn", "chat", "Chat");
control("leaveBtn", "leave", "Leave");

showSection("loginSection");
restoreFirebaseSession();

console.log("MeetSpace frontend loaded.");
