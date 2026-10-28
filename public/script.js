
/* ==========================================
   MeetSpace - Complete Frontend JavaScript
   Firebase + Video + Public/Private Chat
========================================== */

const $ = id => document.getElementById(id);

const socket = io({
  autoConnect: false,
  reconnection: false
});

let currentRoom = null;
let currentRole = null;
let currentUser = null;
let localStream = null;
let screenStream = null;
let participants = [];

const peers = new Map();
const candidateQueues = new Map();

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

/* ==========================================
   BASIC FUNCTIONS
========================================== */

function status(message) {
  $("status").textContent = message;
}

function showSection(sectionId) {
  [
    "loginSection",
    "homeSection",
    "waitingSection",
    "meetingSection"
  ].forEach(id => {
    $(id).hidden = id !== sectionId;
  });
}

function request(eventName, data) {
  return new Promise((resolve, reject) => {
    socket.timeout(10000).emit(
      eventName,
      data,
      (error, response) => {
        if (error) {
          reject(new Error("Server did not respond"));
        } else {
          resolve(response);
        }
      }
    );
  });
}

/* ==========================================
   FIREBASE AUTHENTICATION
========================================== */

async function waitForFirebase() {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (window.meetspaceAuth) {
      await window.meetspaceAuth.authReady;
      return window.meetspaceAuth;
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error(
    "Firebase failed to load. Check Firebase configuration."
  );
}

async function connectSocket() {
  if (socket.connected) return;

  if (!currentUser) {
    throw new Error("Please sign in first.");
  }

  const firebase = await waitForFirebase();
  const credential = await firebase.getUserToken();

  socket.auth = {
    name: currentUser.name,
    credential
  };

  return new Promise((resolve, reject) => {
    const onConnect = () => {
      socket.off("connect_error", onError);
      resolve();
    };

    const onError = error => {
      socket.off("connect", onConnect);
      reject(error);
    };

    socket.once("connect", onConnect);
    socket.once("connect_error", onError);
    socket.connect();
  });
}

function setUser(name, firebaseUser) {
  currentUser = {
    name,
    uid: firebaseUser.uid,
    isGuest: firebaseUser.isAnonymous,
    email: firebaseUser.email || null
  };

  $("userInfo").textContent =
    name + (firebaseUser.isAnonymous ? " (Guest)" : "");

  showSection("homeSection");
  status("Signed in as " + name);
}

function getSavedGuestName(uid) {
  return localStorage.getItem(
    "meetspace-guest-name-" + uid
  );
}

/* Google Login */

$("googleLoginBtn").onclick = async () => {
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

    status("Google sign-in successful.");
  } catch (error) {
    console.error("Google login error:", error);
    status("Google sign-in failed: " + error.message);
  } finally {
    button.disabled = false;
  }
};

/* Show Guest Name */

$("guestLoginBtn").onclick = () => {
  $("guestNameSection").hidden = false;
  $("guestName").focus();
};

/* Guest Login */

$("guestContinueBtn").onclick = async () => {
  const name = $("guestName").value.trim();

  if (!name) {
    status("Please enter your name.");
    return;
  }

  const button = $("guestContinueBtn");
  button.disabled = true;

  try {
    status("Signing in as a guest...");

    const firebase = await waitForFirebase();
    const user = await firebase.loginAsGuest();

    localStorage.setItem(
      "meetspace-guest-name-" + user.uid,
      name
    );

    setUser(name, user);
    status("Guest sign-in successful.");
  } catch (error) {
    console.error("Guest login error:", error);
    status("Guest sign-in failed: " + error.message);
  } finally {
    button.disabled = false;
  }
};

/* Restore Login */

async function restoreFirebaseSession() {
  try {
    const firebase = await waitForFirebase();

    firebase.onAuthStateChanged(
      firebase.auth,
      user => {
        if (!user || currentUser) return;

        if (user.isAnonymous) {
          const name = getSavedGuestName(user.uid);

          if (name) {
            setUser(name, user);
          } else {
            $("guestNameSection").hidden = false;
            status("Enter your guest name to continue.");
          }
        } else {
          setUser(
            user.displayName || user.email || "Google User",
            user
          );
        }
      }
    );
  } catch (error) {
    console.error("Firebase error:", error);
    status(error.message);
  }
}

/* ==========================================
   MEETING HELPERS
========================================== */

function meetingLink(roomId) {
  return location.origin + "/?room=" +
    encodeURIComponent(roomId);
}

function updateRole(role) {
  currentRole = role;

  $("roleText").textContent = "Role: " + role;

  $("hostPanel").hidden =
    role !== "host" && role !== "admin";
}

function enterMeeting(roomId, role) {
  currentRoom = roomId;

  $("roomText").textContent = roomId;

  updateRole(role);
  showSection("meetingSection");

  history.replaceState(
    {},
    "",
    "/?room=" + encodeURIComponent(roomId)
  );
}

/* ==========================================
   VIDEO ELEMENTS
========================================== */

function createVideo(id, name, stream, isLocal = false) {
  let box = document.getElementById("video-" + id);

  if (!box) {
    box = document.createElement("div");
    box.id = "video-" + id;
    box.className = "video-box";

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isLocal;

    const label = document.createElement("span");
    label.className = "video-label";

    box.append(video, label);
    $("videoGrid").appendChild(box);
  }

  box.querySelector(".video-label").textContent = name;

  const video = box.querySelector("video");

  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }

  video.play().catch(() => {});
}

async function startMedia() {
  if (localStream) return;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true
    });
  } catch (error) {
    console.warn("Camera unavailable:", error);

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false
      });

      status("Camera unavailable. Microphone only.");
    } catch (audioError) {
      console.warn("Microphone unavailable:", audioError);

      localStream = new MediaStream();
      status("Camera and microphone unavailable.");
    }
  }

  createVideo(
    "local",
    currentUser.name + " (You)",
    localStream,
    true
  );

  const hasAudio = localStream.getAudioTracks().length > 0;
  const hasVideo = localStream.getVideoTracks().length > 0;

  $("micBtn").textContent = hasAudio
    ? "Mute Mic"
    : "Mic Unavailable";

  $("cameraBtn").textContent = hasVideo
    ? "Turn Camera Off"
    : "Camera Unavailable";

  $("micBtn").disabled = !hasAudio;
  $("cameraBtn").disabled = !hasVideo;
}

/* ==========================================
   WEBRTC PEER CONNECTIONS
========================================== */

function removePeer(id) {
  const pc = peers.get(id);

  if (pc) pc.close();

  peers.delete(id);
  candidateQueues.delete(id);

  document.getElementById("video-" + id)?.remove();
}

function createPeer(id) {
  if (peers.has(id)) {
    return peers.get(id);
  }

  const pc = new RTCPeerConnection(rtcConfig);

  peers.set(id, pc);
  candidateQueues.set(id, []);

  const remoteStream = new MediaStream();

  const name =
    participants.find(p => p.id === id)?.name ||
    "Participant";

  createVideo(id, name, remoteStream);

  for (const track of localStream?.getTracks() || []) {
    pc.addTrack(track, localStream);
  }

  pc.ontrack = event => {
    const tracks =
      event.streams[0]?.getTracks() || [event.track];

    for (const track of tracks) {
      const exists = remoteStream.getTracks().some(
        existing => existing.id === track.id
      );

      if (!exists) {
        remoteStream.addTrack(track);
      }
    }

    createVideo(id, name, remoteStream);
  };

  pc.onicecandidate = event => {
    if (!event.candidate) return;

    socket.emit("signal", {
      to: id,
      signal: {
        type: "candidate",
        candidate: event.candidate
      }
    });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      status("Live connection established.");
    } else if (pc.connectionState === "failed") {
      status("Connection failed for a participant.");
    }
  };

  return pc;
}

async function callPeer(id) {
  const pc = createPeer(id);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.emit("signal", {
    to: id,
    signal: {
      type: "offer",
      sdp: pc.localDescription
    }
  });
}

socket.on("signal", async ({ from, signal }) => {
  if (!currentRoom || !localStream) return;

  try {
    const pc = createPeer(from);

    if (signal.type === "offer") {
      await pc.setRemoteDescription(signal.sdp);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit("signal", {
        to: from,
        signal: {
          type: "answer",
          sdp: pc.localDescription
        }
      });
    }

    if (signal.type === "answer") {
      await pc.setRemoteDescription(signal.sdp);
    }

    if (signal.type === "candidate") {
      if (pc.remoteDescription) {
        await pc.addIceCandidate(signal.candidate);
      } else {
        candidateQueues.get(from).push(signal.candidate);
      }
    }

    if (pc.remoteDescription) {
      const queue = candidateQueues.get(from) || [];
      candidateQueues.set(from, []);

      for (const candidate of queue) {
        await pc.addIceCandidate(candidate);
      }
    }
  } catch (error) {
    console.error("WebRTC error:", error);
    status("Video connection error: " + error.message);
  }
});

/* ==========================================
   CREATE MEETING
========================================== */

$("createBtn").onclick = async () => {
  const password = $("createPassword").value;

  if (password.length < 4) {
    showErrorToast(
      "createPassword",
      "Password must have at least 4 characters."
    );
    return;
  }

  $("createBtn").disabled = true;

  try {
    await connectSocket();

    const result = await request("create-room", {
      password
    });

    if (!result.ok) {
      throw new Error(result.error);
    }

    enterMeeting(result.roomId, "host");
    renderParticipants(result.participants);

    await startMedia();

    status("Meeting created. Share the ID and password.");
  } catch (error) {
    status(error.message);
  } finally {
    $("createBtn").disabled = false;
  }
};

/* ==========================================
   JOIN MEETING
========================================== */

$("joinBtn").onclick = async () => {
  const roomId = $("roomInput").value.trim();
  const password = $("joinPassword").value;

  if (!roomId || !password) {
    status("Enter Meeting ID and Password.");
    return;
  }

  $("joinBtn").disabled = true;

  try {
    await connectSocket();

    const result = await request("request-join", {
      roomId,
      password
    });

    if (!result.ok) {
      throw new Error(result.error);
    }

    currentRoom = roomId;
    showSection("waitingSection");

    status("Waiting for host approval.");
  } catch (error) {
    status(error.message);
  } finally {
    $("joinBtn").disabled = false;
  }
};

/* ==========================================
   MEETING SOCKET EVENTS
========================================== */

socket.on("join-approved", async data => {
  try {
    enterMeeting(data.roomId, data.role);
    await startMedia();

    for (const id of data.peers) {
      await callPeer(id);
    }

    status("Host approved your request.");
  } catch (error) {
    status("Join error: " + error.message);
  }
});

socket.on("join-rejected", () => {
  resetMeeting();
  status("Your request was rejected.");
});

socket.on("meeting-ended", () => {
  resetMeeting();
  status("The meeting has ended.");
});

socket.on("role-updated", role => {
  updateRole(role);
  renderParticipants(participants);
  status("Your role is now " + role);
});

socket.on("user-left", id => {
  removePeer(id);
  status("A participant left.");
});

socket.on("user-joined", () => {
  status("A participant joined.");
});

/* ==========================================
   PARTICIPANTS
========================================== */

function actionButton(label, action, targetId) {
  const button = document.createElement("button");
  button.textContent = label;

  button.onclick = async () => {
    try {
      const result = await request(action, targetId);

      if (!result.ok) {
        throw new Error(result.error);
      }

      status(label + " successful.");
    } catch (error) {
      status(error.message);
    }
  };

  return button;
}

function renderParticipants(list) {
  participants = list || [];

  const container = $("participantList");
  container.replaceChildren();

  for (const participant of participants) {
    const row = document.createElement("div");
    row.className = "participant-item";

    const details = document.createElement("div");
    details.className = "participant-details";

    const name = document.createElement("span");
    name.className = "participant-name";
    name.textContent = participant.name;

    const role = document.createElement("span");
    role.className = "participant-role";
    role.textContent = participant.role;

    details.append(name, role);
    row.appendChild(details);

    if (
      currentRole === "host" &&
      participant.id !== socket.id
    ) {
      const actions = document.createElement("div");
      actions.className = "participant-actions";

      actions.appendChild(
        actionButton(
          "Make Admin",
          "assign-admin",
          participant.id
        )
      );

      actions.appendChild(
        actionButton(
          "Make Host",
          "transfer-host",
          participant.id
        )
      );

      row.appendChild(actions);
    }

    container.appendChild(row);
  }

  updateChatRecipients(participants);
}

socket.on("participants-updated", data => {
  renderParticipants(data.participants);
});

/* ==========================================
   WAITING ROOM
========================================== */

socket.on("waiting-updated", waiting => {
  const container = $("waitingList");
  container.replaceChildren();

  if (!waiting.length) {
    const p = document.createElement("p");
    p.textContent = "No pending requests";
    container.appendChild(p);
    return;
  }

  for (const user of waiting) {
    const row = document.createElement("div");
    row.className = "waiting-item";

    const name = document.createElement("span");
    name.textContent = user.name;

    const actions = document.createElement("div");
    actions.className = "waiting-actions";

    actions.appendChild(
      actionButton(
        "Approve",
        "approve-request",
        user.id
      )
    );

    actions.appendChild(
      actionButton(
        "Reject",
        "reject-request",
        user.id
      )
    );

    row.append(name, actions);
    container.appendChild(row);
  }
});

/* ==========================================
   CHAT SETUP
========================================== */

const chatRecipient = $("chatRecipient");
const chatMessages = $("chatMessages");
const chatForm = $("chatForm");
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

  const available = [...chatRecipient.options].some(
    option => option.value === previous
  );

  chatRecipient.value = available
    ? previous
    : "everyone";
}

/* ==========================================
   DISPLAY CHAT MESSAGE
========================================== */

function displayChatMessage(message) {
  if (!currentRoom) return;

  chatMessages.querySelector(".chat-empty")?.remove();

  const isMine = message.from === socket.id;

  const bubble = document.createElement("div");
  bubble.className = "chat-message";

  if (isMine) bubble.classList.add("mine");
  if (message.private) bubble.classList.add("private");

  const header = document.createElement("div");
  header.className = "chat-message-header";

  const name = document.createElement("span");
  name.className = "chat-message-name";
  name.textContent = isMine
    ? "You"
    : message.fromName;

  const type = document.createElement("span");
  type.className = "chat-message-type";

  if (message.private) {
    type.textContent = isMine
      ? "🔒 Private to " + message.toName
      : "🔒 Private to you";
  } else {
    type.textContent = "Everyone";
  }

  const text = document.createElement("div");
  text.className = "chat-message-text";
  text.textContent = message.text;

  const time = document.createElement("span");
  time.className = "chat-message-time";

  time.textContent = new Date(
    message.timestamp
  ).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });

  header.append(name, type);
  bubble.append(header, text, time);

  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

socket.on("chat-message", displayChatMessage);

/* ==========================================
   SEND CHAT MESSAGE
========================================== */

chatForm.addEventListener("submit", async event => {
  event.preventDefault();

  if (
    !currentRoom ||
    !socket.connected ||
    $("meetingSection").hidden
  ) {
    status("Join a meeting to send messages.");
    return;
  }

  const text = chatInput.value.trim();
  if (!text) return;

  chatSendBtn.disabled = true;

  try {
    const result = await request("chat-message", {
      text,
      to: chatRecipient.value
    });

    if (!result.ok) {
      throw new Error(result.error);
    }

    chatInput.value = "";
    chatInput.focus();
  } catch (error) {
    status("Message failed: " + error.message);
  } finally {
    chatSendBtn.disabled = false;
  }
});

function clearMeetingChat() {
  chatMessages.replaceChildren();

  const empty = document.createElement("p");
  empty.className = "chat-empty";
  empty.textContent =
    "No messages yet. Start a conversation!";

  chatMessages.appendChild(empty);
  updateChatRecipients([]);

  chatInput.value = "";
  chatSendBtn.disabled = false;
}

/* ==========================================
   COPY INVITE LINK
========================================== */

$("copyBtn").onclick = async () => {
  if (!currentRoom) return;

  try {
    await navigator.clipboard.writeText(
      meetingLink(currentRoom)
    );

    $("copyBtn").textContent = "Copied!";

    status(
      "Invite link copied. Share password separately."
    );
  } catch (error) {
    status("Could not copy link.");
  }
};

/* ==========================================
   MICROPHONE
========================================== */

$("micBtn").onclick = () => {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;

  track.enabled = !track.enabled;

  $("micBtn").textContent = track.enabled
    ? "Mute Mic"
    : "Unmute Mic";
};

/* ==========================================
   CAMERA
========================================== */

$("cameraBtn").onclick = () => {
  const track = localStream?.getVideoTracks()[0];
  if (!track) return;

  track.enabled = !track.enabled;

  $("cameraBtn").textContent = track.enabled
    ? "Turn Camera Off"
    : "Turn Camera On";
};

/* ==========================================
   SCREEN SHARING
========================================== */

$("screenBtn").onclick = async () => {
  if (!currentRoom) return;

  try {
    if (screenStream) {
      await stopScreenShare();
      return;
    }

    screenStream =
      await navigator.mediaDevices.getDisplayMedia({
        video: true
      });

    const screenTrack =
      screenStream.getVideoTracks()[0];

    for (const pc of peers.values()) {
      const sender = pc.getSenders().find(
        s => s.track?.kind === "video"
      );

      if (sender) {
        await sender.replaceTrack(screenTrack);
      }
    }

    screenTrack.onended = stopScreenShare;

    $("screenBtn").textContent = "Stop Sharing";
    status("Screen sharing started.");
  } catch (error) {
    status(
      "Screen sharing unavailable: " + error.message
    );
  }
};

async function stopScreenShare() {
  if (!screenStream) return;

  const cameraTrack =
    localStream?.getVideoTracks()[0] || null;

  for (const pc of peers.values()) {
    const sender = pc.getSenders().find(
      s => s.track?.kind === "video"
    );

    if (sender) {
      await sender.replaceTrack(cameraTrack);
    }
  }

  screenStream.getTracks().forEach(track => track.stop());
  screenStream = null;

  $("screenBtn").textContent = "Share Screen";
}

/* ==========================================
   RESET MEETING
========================================== */

function resetMeeting() {
  for (const id of [...peers.keys()]) {
    removePeer(id);
  }

  if (screenStream) {
    screenStream.getTracks().forEach(
      track => track.stop()
    );
    screenStream = null;
  }

  if (localStream) {
    localStream.getTracks().forEach(
      track => track.stop()
    );
    localStream = null;
  }

  currentRoom = null;
  currentRole = null;
  participants = [];

  $("videoGrid").replaceChildren();
  $("participantList").replaceChildren();
  $("waitingList").replaceChildren();

  $("micBtn").textContent = "Mute Mic";
  $("cameraBtn").textContent = "Turn Camera Off";
  $("screenBtn").textContent = "Share Screen";
  $("copyBtn").textContent = "Copy Invite Link";

  clearMeetingChat();

  if (socket.connected) {
    socket.disconnect();
  }

  history.replaceState({}, "", "/");

  showSection(
    currentUser ? "homeSection" : "loginSection"
  );
}

/* ==========================================
   LEAVE / CANCEL
========================================== */

$("leaveBtn").onclick = () => {
  socket.emit("leave-room");
  resetMeeting();
  status("You left the meeting.");
};

$("cancelWaitingBtn").onclick = () => {
  socket.emit("leave-room");
  resetMeeting();
  status("Join request cancelled.");
};

/* ==========================================
   DISCONNECT
========================================== */

socket.on("disconnect", () => {
  if (currentRoom) {
    resetMeeting();
    status("Disconnected from server. Please rejoin.");
  }
});

/* ==========================================
   INVITATION LINK
========================================== */

const params = new URLSearchParams(location.search);
const invitedRoom = params.get("room");

if (invitedRoom) {
  $("roomInput").value = invitedRoom;

  status(
    "Meeting invitation detected. Please sign in."
  );
}

/* ==========================================
   TRANSPARENT PASSWORD ERROR TOAST
   RIGHT SIDE ABOVE PASSWORD INPUT
========================================== */

function showErrorToast(inputId, message) {
  const input = document.getElementById(inputId);
  if (!input) return;

  const card = input.closest(".option-card");
  if (!card) return;

  // Remove previous notification
  card.querySelector(":scope > .validation-tooltip")?.remove();

  clearTimeout(card._toastTimer);
  clearTimeout(card._toastRemoveTimer);

  // Password input red border
  input.classList.add("input-error");

  // New toast
  const toast = document.createElement("div");
  toast.className = "validation-tooltip";
  toast.setAttribute("role", "alert");
  toast.textContent = "⚠ " + message;

  card.appendChild(toast);

  // Position: top-right, just above password input
  const cardRect = card.getBoundingClientRect();
  const inputRect = input.getBoundingClientRect();

  const toastHeight = toast.getBoundingClientRect().height;

  const topPosition =
    inputRect.top -
    cardRect.top -
    toastHeight -
    14;

  toast.style.position = "absolute";
  toast.style.top = Math.max(8, topPosition) + "px";
  toast.style.bottom = "auto";
  toast.style.left = "auto";
  toast.style.right = "12px";
  toast.style.zIndex = "999";
  toast.style.maxWidth = "min(300px, calc(100% - 24px))";

  // Arrow pointing down to password field
  toast.classList.add("toast-above-input");

  input.focus();

  // Remove after 4 seconds
  card._toastTimer = setTimeout(() => {
    toast.classList.add("toast-hide");

    card._toastRemoveTimer = setTimeout(() => {
      toast.remove();
      input.classList.remove("input-error");
    }, 250);
  }, 4000);
}

/* ==========================================
   INITIALIZE
========================================== */

showSection("loginSection");
restoreFirebaseSession();
