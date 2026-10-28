
/* ==========================================
   MEETSPACE - FRONTEND APPLICATION
   Firebase Login + WebRTC + Socket.IO
   Meetings + Participants + Private Chat
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

const peers = new Map();
const remoteStreams = new Map();
const candidateQueues = new Map();

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

/* ==========================================
   STATUS AND PAGE DISPLAY
========================================== */

function status(message) {
  const element = $("status");
  if (element) element.textContent = message;
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
}

/* ==========================================
   SERVER REQUEST HELPER
========================================== */

function request(eventName, data) {
  return new Promise((resolve, reject) => {
    if (!socket.connected) {
      reject(new Error("Server is not connected."));
      return;
    }

    socket.timeout(10000).emit(
      eventName,
      data,
      (error, response) => {
        if (error) {
          reject(new Error("Server did not respond."));
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
   FIREBASE AUTHENTICATION
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

  throw new Error(
    "Firebase authentication could not be loaded."
  );
}

function setUser(name, firebaseUser) {
  currentUser = {
    uid: firebaseUser.uid,
    name: name,
    email: firebaseUser.email || null,
    isGuest: firebaseUser.isAnonymous
  };

  $("userInfo").textContent =
    name + (firebaseUser.isAnonymous ? " (Guest)" : "");

  showSection("homeSection");

  status("Signed in as " + name);
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

/* Google Login */

$("googleLoginBtn").addEventListener(
  "click",
  async () => {
    const button = $("googleLoginBtn");
    button.disabled = true;

    try {
      status("Signing in with Google...");

      const firebase = await waitForFirebase();

      const user = await firebase.loginWithGoogle();

      setUser(
        user.displayName ||
        user.email ||
        "Google User",
        user
      );

    } catch (error) {
      console.error("Google login:", error);

      status(
        "Google sign-in failed: " + error.message
      );

    } finally {
      button.disabled = false;
    }
  }
);

/* Show Guest Name Input */

$("guestLoginBtn").addEventListener("click", () => {
  $("guestNameSection").hidden = false;
  $("guestName").focus();
});

/* Guest Login */

$("guestContinueBtn").addEventListener(
  "click",
  async () => {
    const name = $("guestName").value.trim();

    if (!name) {
      status("Please enter your name.");
      $("guestName").focus();
      return;
    }

    const button = $("guestContinueBtn");
    button.disabled = true;

    try {
      status("Signing in as guest...");

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
      console.error("Guest login:", error);

      status(
        "Guest sign-in failed: " + error.message
      );

    } finally {
      button.disabled = false;
    }
  }
);

/* Enter key for Guest Name */

$("guestName").addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Enter") {
      $("guestContinueBtn").click();
    }
  }
);

/* Restore Existing Firebase Session */

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

            status(
              "Enter your name to continue as Guest."
            );
          }

          return;
        }

        setUser(
          user.displayName ||
          user.email ||
          "Google User",
          user
        );
      }
    );

  } catch (error) {
    console.error("Firebase initialization:", error);
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

  socket.auth = {
    name: currentUser.name,
    credential: credential
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
}

function enterMeeting(roomId, role) {
  currentRoom = roomId;
  currentRole = role;

  $("roomText").textContent = roomId;

  updateRole(role);
  showSection("meetingSection");

  history.replaceState(
    {},
    "",
    meetingLink(roomId)
  );

  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });
}

/* ==========================================
   VIDEO UI
========================================== */

function createVideo(
  id,
  name,
  stream,
  isLocal = false
) {
  let box = document.getElementById(
    "video-" + id
  );

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

  const label = box.querySelector(".video-label");
  const video = box.querySelector("video");

  label.textContent = name;

  if (video.srcObject !== stream) {
    video.srcObject = stream;
  }

  video.play().catch(() => {});
}

/* ==========================================
   LOCAL CAMERA AND MICROPHONE
========================================== */

async function startMedia() {
  if (localStream) return;

  try {
    localStream =
      await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });

  } catch (error) {
    console.warn("Camera and microphone:", error);

    try {
      localStream =
        await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: true
        });

      status(
        "Camera unavailable. Microphone enabled."
      );

    } catch {
      localStream = new MediaStream();

      status(
        "Camera and microphone unavailable."
      );
    }
  }

  createVideo(
    "local",
    currentUser.name + " (You)",
    localStream,
    true
  );

  const audioTrack =
    localStream.getAudioTracks()[0];

  const videoTrack =
    localStream.getVideoTracks()[0];

  $("micBtn").disabled = !audioTrack;
  $("cameraBtn").disabled = !videoTrack;

  $("micBtn").textContent = audioTrack
    ? "🎙 Mute Mic"
    : "Mic Unavailable";

  $("cameraBtn").textContent = videoTrack
    ? "◉ Turn Camera Off"
    : "Camera Unavailable";
}

/* ==========================================
   WEBRTC CONNECTIONS
========================================== */

function removePeer(id) {
  const peer = peers.get(id);

  if (peer) {
    peer.close();
  }

  peers.delete(id);
  remoteStreams.delete(id);
  candidateQueues.delete(id);

  document.getElementById(
    "video-" + id
  )?.remove();
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
    (participant) => participant.id === id
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
      const exists = remoteStream
        .getTracks()
        .some((existing) => {
          return existing.id === track.id;
        });

      if (!exists) {
        remoteStream.addTrack(track);
      }
    });

    createVideo(id, name, remoteStream);
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
      status(
        "Connection failed for a participant."
      );
    }
  };

  return peer;
}

async function callPeer(id) {
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

  const queue =
    candidateQueues.get(id) || [];

  candidateQueues.set(id, []);

  for (const candidate of queue) {
    await peer.addIceCandidate(candidate);
  }
}

socket.on("signal", async ({ from, signal }) => {
  if (!currentRoom || !localStream) return;

  try {
    const peer = createPeer(from);

    if (signal.type === "offer") {
      await peer.setRemoteDescription(
        signal.sdp
      );

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
      await peer.setRemoteDescription(
        signal.sdp
      );

      await flushCandidates(from, peer);
    }

    if (signal.type === "candidate") {
      if (peer.remoteDescription) {
        await peer.addIceCandidate(
          signal.candidate
        );
      } else {
        candidateQueues.get(from).push(
          signal.candidate
        );
      }
    }

  } catch (error) {
    console.error("WebRTC signaling:", error);

    status(
      "Video connection issue: " + error.message
    );
  }
});

/* ==========================================
   CREATE MEETING
========================================== */

$("createBtn").addEventListener(
  "click",
  async () => {
    const password = $("createPassword").value;

    if (password.length < 4) {
      showErrorToast(
        "createPassword",
        "Password must have at least 4 characters."
      );
      return;
    }

    if (password.length > 64) {
      showErrorToast(
        "createPassword",
        "Password cannot exceed 64 characters."
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

      renderParticipants(
        result.participants || []
      );

      await startMedia();

      status(
        "Meeting created. Share the invite link and password."
      );

    } catch (error) {
      console.error("Create meeting:", error);
      status(error.message);

    } finally {
      button.disabled = false;
    }
  }
);

/* ==========================================
   JOIN MEETING
========================================== */

$("joinBtn").addEventListener(
  "click",
  async () => {
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

      status(
        "Waiting for host or admin approval."
      );

    } catch (error) {
      console.error("Join meeting:", error);
      status(error.message);

    } finally {
      button.disabled = false;
    }
  }
);

/* ==========================================
   JOIN APPROVAL EVENTS
========================================== */

socket.on("join-approved", async (data) => {
  try {
    enterMeeting(
      data.roomId,
      data.role || "participant"
    );

    await startMedia();

    for (const id of data.peers || []) {
      await callPeer(id);
    }

    status(
      "Your request has been approved."
    );

  } catch (error) {
    console.error("Join approved:", error);
    status(error.message);
  }
});

socket.on("join-rejected", () => {
  resetMeeting();

  status(
    "Your meeting request was rejected."
  );
});

socket.on("meeting-ended", () => {
  resetMeeting();

  status(
    "The host has ended this meeting."
  );
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
  status("A participant left the meeting.");
});

/* ==========================================
   PARTICIPANT ACTION BUTTON
========================================== */

function actionButton(
  label,
  eventName,
  targetId
) {
  const button = document.createElement(
    "button"
  );

  button.type = "button";
  button.textContent = label;

  button.addEventListener(
    "click",
    async () => {
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
    }
  );

  return button;
}

/* ==========================================
   PARTICIPANT LIST
========================================== */

function renderParticipants(list) {
  participants = Array.isArray(list)
    ? list
    : [];

  const container = $("participantList");

  container.replaceChildren();

  for (const participant of participants) {
    const row = document.createElement("div");

    row.className = "participant-item";

    const details = document.createElement(
      "div"
    );

    details.className = "participant-details";

    const name = document.createElement(
      "span"
    );

    name.className = "participant-name";
    name.textContent = participant.name;

    const role = document.createElement(
      "span"
    );

    role.className = "participant-role";
    role.textContent = participant.role;

    details.append(name, role);
    row.appendChild(details);

    if (
      currentRole === "host" &&
      participant.id !== socket.id
    ) {
      const actions = document.createElement(
        "div"
      );

      actions.className =
        "participant-actions";

      actions.append(
        actionButton(
          "Make Admin",
          "assign-admin",
          participant.id
        ),
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

  // Refresh video labels
  participants.forEach((person) => {
    const box = document.getElementById(
      "video-" + person.id
    );

    if (box) {
      const label = box.querySelector(
        ".video-label"
      );

      if (label) {
        label.textContent = person.name;
      }
    }
  });
}

socket.on(
  "participants-updated",
  (data) => {
    renderParticipants(
      data.participants || []
    );
  }
);

/* ==========================================
   WAITING ROOM
========================================== */

socket.on(
  "waiting-updated",
  (waiting) => {
    const container = $("waitingList");
    container.replaceChildren();

    if (!Array.isArray(waiting) || !waiting.length) {
      const message = document.createElement(
        "p"
      );

      message.textContent =
        "No pending requests";

      container.appendChild(message);
      return;
    }

    for (const user of waiting) {
      const row = document.createElement(
        "div"
      );

      row.className = "waiting-item";

      const name = document.createElement(
        "span"
      );

      name.textContent = user.name;

      const actions = document.createElement(
        "div"
      );

      actions.className = "waiting-actions";

      actions.append(
        actionButton(
          "Approve",
          "approve-request",
          user.id
        ),
        actionButton(
          "Reject",
          "reject-request",
          user.id
        )
      );

      row.append(name, actions);

      container.appendChild(row);
    }
  }
);

/* ==========================================
   MEETING CHAT
========================================== */

const chatRecipient = $("chatRecipient");
const chatMessages = $("chatMessages");
const chatForm = $("chatForm");
const chatInput = $("chatInput");
const chatSendBtn = $("chatSendBtn");

/* Refresh recipient dropdown */

function updateChatRecipients(list) {
  const previous = chatRecipient.value;

  chatRecipient.replaceChildren();

  const everyone = document.createElement(
    "option"
  );

  everyone.value = "everyone";
  everyone.textContent =
    "Everyone (Public)";

  chatRecipient.appendChild(everyone);

  for (const person of list || []) {
    if (person.id === socket.id) continue;

    const option = document.createElement(
      "option"
    );

    option.value = person.id;
    option.textContent =
      person.name + " (Private)";

    chatRecipient.appendChild(option);
  }

  const exists = [
    ...chatRecipient.options
  ].some((option) => {
    return option.value === previous;
  });

  chatRecipient.value = exists
    ? previous
    : "everyone";
}

/* Display public or private chat message */

function displayChatMessage(message) {
  if (!currentRoom) return;

  chatMessages.querySelector(
    ".chat-empty"
  )?.remove();

  const mine = message.from === socket.id;

  const bubble = document.createElement(
    "div"
  );

  bubble.className = "chat-message";

  if (mine) {
    bubble.classList.add("mine");
  }

  if (message.private) {
    bubble.classList.add("private");
  }

  const header = document.createElement(
    "div"
  );

  header.className = "chat-message-header";

  const name = document.createElement(
    "span"
  );

  name.className = "chat-message-name";

  name.textContent = mine
    ? "You"
    : message.fromName;

  const type = document.createElement(
    "span"
  );

  type.className = "chat-message-type";

  if (message.private) {
    type.textContent = mine
      ? "🔒 Private to " + message.toName
      : "🔒 Private to you";
  } else {
    type.textContent = "Everyone";
  }

  const text = document.createElement(
    "div"
  );

  text.className = "chat-message-text";
  text.textContent = message.text;

  const time = document.createElement(
    "span"
  );

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

  chatMessages.scrollTop =
    chatMessages.scrollHeight;
}

socket.on(
  "chat-message",
  displayChatMessage
);

/* Send chat message */

chatForm.addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();

    if (
      !socket.connected ||
      !currentRoom ||
      $("meetingSection").hidden
    ) {
      status(
        "Join a meeting before sending messages."
      );
      return;
    }

    const text = chatInput.value.trim();

    if (!text) return;

    chatSendBtn.disabled = true;

    try {
      const result = await request(
        "chat-message",
        {
          text,
          to: chatRecipient.value
        }
      );

      if (!result.ok) {
        throw new Error(result.error);
      }

      chatInput.value = "";
      chatInput.focus();

    } catch (error) {
      console.error("Send chat:", error);

      status(
        "Message failed: " + error.message
      );

    } finally {
      chatSendBtn.disabled = false;
    }
  }
);

function clearMeetingChat() {
  chatMessages.replaceChildren();

  const empty = document.createElement(
    "div"
  );

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

$("copyBtn").addEventListener(
  "click",
  async () => {
    if (!currentRoom) return;

    const button = $("copyBtn");

    try {
      await navigator.clipboard.writeText(
        meetingLink(currentRoom)
      );

      button.textContent = "✓ Copied!";

      status(
        "Invite link copied. Share the meeting password separately."
      );

      setTimeout(() => {
        button.textContent =
          "⧉ Copy Invite Link";
      }, 2500);

    } catch (error) {
      status(
        "Unable to copy invite link."
      );
    }
  }
);

/* ==========================================
   MICROPHONE CONTROL
========================================== */

$("micBtn").addEventListener(
  "click",
  () => {
    const track =
      localStream?.getAudioTracks()[0];

    if (!track) return;

    track.enabled = !track.enabled;

    $("micBtn").textContent = track.enabled
      ? "🎙 Mute Mic"
      : "🎙 Unmute Mic";
  }
);

/* ==========================================
   CAMERA CONTROL
========================================== */

$("cameraBtn").addEventListener(
  "click",
  () => {
    const track =
      localStream?.getVideoTracks()[0];

    if (!track) return;

    track.enabled = !track.enabled;

    $("cameraBtn").textContent = track.enabled
      ? "◉ Turn Camera Off"
      : "◉ Turn Camera On";
  }
);

/* ==========================================
   SCREEN SHARING
========================================== */

$("screenBtn").addEventListener(
  "click",
  async () => {
    if (!currentRoom) return;

    try {
      if (screenStream) {
        await stopScreenShare();
        return;
      }

      screenStream =
        await navigator.mediaDevices
          .getDisplayMedia({
            video: true
          });

      const screenTrack =
        screenStream.getVideoTracks()[0];

      for (const peer of peers.values()) {
        const sender = peer
          .getSenders()
          .find((item) => {
            return item.track?.kind === "video";
          });

        if (sender) {
          await sender.replaceTrack(
            screenTrack
          );
        }
      }

      screenTrack.onended = () => {
        stopScreenShare().catch(
          console.error
        );
      };

      $("screenBtn").textContent =
        "Stop Sharing";

      status("Screen sharing started.");

    } catch (error) {
      console.error("Screen share:", error);

      status(
        "Screen sharing unavailable: " +
        error.message
      );
    }
  }
);

async function stopScreenShare() {
  if (!screenStream) return;

  const oldScreenStream = screenStream;
  screenStream = null;

  const cameraTrack =
    localStream?.getVideoTracks()[0] ||
    null;

  for (const peer of peers.values()) {
    const sender = peer
      .getSenders()
      .find((item) => {
        return item.track?.kind === "video";
      });

    if (sender) {
      await sender.replaceTrack(
        cameraTrack
      );
    }
  }

  oldScreenStream
    .getTracks()
    .forEach((track) => track.stop());

  $("screenBtn").textContent =
    "▣ Share Screen";

  status("Screen sharing stopped.");
}

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
    screenStream
      .getTracks()
      .forEach((track) => track.stop());

    screenStream = null;
  }

  if (localStream) {
    localStream
      .getTracks()
      .forEach((track) => track.stop());

    localStream = null;
  }

  currentRoom = null;
  currentRole = null;
  participants = [];

  $("videoGrid").replaceChildren();
  $("participantList").replaceChildren();
  $("waitingList").replaceChildren();

  $("micBtn").textContent = "🎙 Mute Mic";
  $("cameraBtn").textContent =
    "◉ Turn Camera Off";

  $("screenBtn").textContent =
    "▣ Share Screen";

  $("copyBtn").textContent =
    "⧉ Copy Invite Link";

  $("micBtn").disabled = false;
  $("cameraBtn").disabled = false;

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
    currentUser
      ? "homeSection"
      : "loginSection"
  );

  isLeaving = false;
}

/* ==========================================
   LEAVE / CANCEL
========================================== */

$("leaveBtn").addEventListener(
  "click",
  () => {
    if (socket.connected) {
      socket.emit("leave-room");
    }

    resetMeeting();

    status("You left the meeting.");
  }
);

$("cancelWaitingBtn").addEventListener(
  "click",
  () => {
    if (socket.connected) {
      socket.emit("leave-room");
    }

    resetMeeting();

    status("Join request cancelled.");
  }
);

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
   INVITE LINK DETECTION
========================================== */

const urlParams = new URLSearchParams(
  location.search
);

const invitedRoom = urlParams.get("room");

if (invitedRoom) {
  $("roomInput").value = invitedRoom;

  status(
    "Meeting invitation detected. Sign in to continue."
  );
}

/* ==========================================
   TRANSPARENT PASSWORD ERROR TOAST
   ABOVE PASSWORD INPUT, RIGHT ALIGNED
========================================== */

function showErrorToast(inputId, message) {
  const input = $(inputId);

  if (!input) return;

  const card = input.closest(".option-card");

  if (!card) return;

  const oldToast = card.querySelector(
    ":scope > .validation-tooltip"
  );

  if (oldToast) {
    oldToast.remove();
  }

  clearTimeout(card._toastTimer);
  clearTimeout(card._toastRemoveTimer);

  input.classList.add("input-error");

  const toast = document.createElement(
    "div"
  );

  toast.className = "validation-tooltip";
  toast.setAttribute("role", "alert");

  toast.textContent =
    "⚠ " + message;

  card.appendChild(toast);

  // Calculate actual position using the input.
  const cardRect =
    card.getBoundingClientRect();

  const inputRect =
    input.getBoundingClientRect();

  const toastHeight =
    toast.getBoundingClientRect().height;

  const top =
    inputRect.top -
    cardRect.top -
    toastHeight -
    13;

  toast.style.position = "absolute";
  toast.style.top =
    Math.max(8, top) + "px";

  toast.style.bottom = "auto";
  toast.style.left = "auto";
  toast.style.right = "12px";

  input.focus();

  card._toastTimer = setTimeout(() => {
    toast.classList.add("toast-hide");

    card._toastRemoveTimer =
      setTimeout(() => {
        toast.remove();

        input.classList.remove(
          "input-error"
        );
      }, 250);

  }, 4000);
}

/* ==========================================
   INITIALIZE APP
========================================== */

showSection("loginSection");
restoreFirebaseSession();
