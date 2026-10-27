
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
let googleCredential = null;
let participants = [];

const peers = new Map();
const candidateQueues = new Map();

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

function status(message) {
  $("status").textContent = message;
}

function showSection(sectionId) {
  for (const id of [
    "loginSection",
    "homeSection",
    "waitingSection",
    "meetingSection"
  ]) {
    $(id).hidden = id !== sectionId;
  }
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

function connectSocket() {
  return new Promise((resolve, reject) => {
    if (socket.connected) return resolve();

    socket.auth = {
      name: currentUser?.name,
      credential: googleCredential
    };

    socket.once("connect", resolve);
    socket.once("connect_error", reject);
    socket.connect();
  });
}

function setUser(name) {
  currentUser = { name };
  $("userInfo").textContent = name;
  showSection("homeSection");
  status("Signed in as " + name);
}

$("loginBtn").onclick = () => {
  const name = $("displayName").value.trim();

  if (!name) {
    status("Please enter your name.");
    return;
  }

  setUser(name);
};

// Google login will be configured in a later step.
// Development login is currently enabled in .env.

window.handleGoogleLogin = response => {
  googleCredential = response.credential;

  const payload = JSON.parse(
    atob(
      response.credential.split(".")[1]
        .replace(/-/g, "+")
        .replace(/_/g, "/")
    )
  );

  setUser(payload.name || payload.email);
};

function meetingLink(roomId) {
  return location.origin + "/?room=" +
    encodeURIComponent(roomId);
}

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

      status("Camera unavailable. Joined with microphone only.");
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

  $("micBtn").textContent = localStream.getAudioTracks().length
    ? "Mute Mic"
    : "Mic Unavailable";

  $("cameraBtn").textContent = localStream.getVideoTracks().length
    ? "Turn Camera Off"
    : "Camera Unavailable";

  $("micBtn").disabled =
    localStream.getAudioTracks().length === 0;

  $("cameraBtn").disabled =
    localStream.getVideoTracks().length === 0;
}

function removePeer(id) {
  const pc = peers.get(id);

  if (pc) pc.close();

  peers.delete(id);
  candidateQueues.delete(id);

  const box = document.getElementById("video-" + id);
  if (box) box.remove();
}

function createPeer(id) {
  if (peers.has(id)) return peers.get(id);

  const pc = new RTCPeerConnection(rtcConfig);

  peers.set(id, pc);
  candidateQueues.set(id, []);

  const remoteStream = new MediaStream();

  const name = participants.find(p => p.id === id)?.name
    || "Participant";

  createVideo(id, name, remoteStream);

  for (const track of localStream?.getTracks() || []) {
    pc.addTrack(track, localStream);
  }

  pc.ontrack = event => {
    const tracks = event.streams[0]?.getTracks()
      || [event.track];

    for (const track of tracks) {
      if (!remoteStream.getTracks().some(
        existing => existing.id === track.id
      )) {
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
    console.error("WebRTC signaling error:", error);
    status("Video connection error: " + error.message);
  }
});

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

$("createBtn").onclick = async () => {
  const password = $("createPassword").value;

  if (password.length < 4) {
    status("Password must have at least 4 characters.");
    return;
  }

  $("createBtn").disabled = true;

  try {
    await connectSocket();

    const result = await request("create-room", {
      password
    });

    if (!result.ok) throw new Error(result.error);

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

    if (!result.ok) throw new Error(result.error);

    currentRoom = roomId;
    showSection("waitingSection");

    status("Request sent. Waiting for host approval.");
  } catch (error) {
    status(error.message);
  } finally {
    $("joinBtn").disabled = false;
  }
};

socket.on("join-approved", async data => {
  try {
    enterMeeting(data.roomId, data.role);

    await startMedia();

    for (const id of data.peers) {
      await callPeer(id);
    }

    status("Host approved your request. Joined meeting.");
  } catch (error) {
    status("Join error: " + error.message);
  }
});

socket.on("join-rejected", () => {
  resetMeeting();
  status("Your request was rejected by the host.");
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
  status("A participant joined the meeting.");
});

socket.on("participants-updated", data => {
  renderParticipants(data.participants);
});

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
}

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
      actionButton("Approve", "approve-request", user.id)
    );

    actions.appendChild(
      actionButton("Reject", "reject-request", user.id)
    );

    row.append(name, actions);
    container.appendChild(row);
  }
});

$("copyBtn").onclick = async () => {
  if (!currentRoom) return;

  try {
    await navigator.clipboard.writeText(
      meetingLink(currentRoom)
    );

    status("Invite link copied. Share password separately.");
  } catch {
    status("Could not copy link.");
  }
};

$("micBtn").onclick = () => {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;

  track.enabled = !track.enabled;

  $("micBtn").textContent = track.enabled
    ? "Mute Mic"
    : "Unmute Mic";
};

$("cameraBtn").onclick = () => {
  const track = localStream?.getVideoTracks()[0];
  if (!track) return;

  track.enabled = !track.enabled;

  $("cameraBtn").textContent = track.enabled
    ? "Turn Camera Off"
    : "Turn Camera On";
};

$("screenBtn").onclick = async () => {
  if (!currentRoom) return;

  try {
    if (screenStream) {
      stopScreenShare();
      return;
    }

    screenStream =
      await navigator.mediaDevices.getDisplayMedia({
        video: true
      });

    const screenTrack = screenStream.getVideoTracks()[0];

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
    status("Screen sharing unavailable: " + error.message);
  }
};

async function stopScreenShare() {
  if (!screenStream) return;

  const cameraTrack = localStream?.getVideoTracks()[0] || null;

  for (const pc of peers.values()) {
    const sender = pc.getSenders().find(
      s => s.track?.kind === "video"
    );

    if (sender) {
      await sender.replaceTrack(cameraTrack);
    }
  }

  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;

  $("screenBtn").textContent = "Share Screen";
}

function resetMeeting() {
  for (const id of [...peers.keys()]) {
    removePeer(id);
  }

  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
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

  socket.disconnect();

  history.replaceState({}, "", "/");

  showSection(currentUser ? "homeSection" : "loginSection");
}

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

socket.on("disconnect", () => {
  if (currentRoom) {
    resetMeeting();
    status("Disconnected from server. Please rejoin.");
  }
});

const params = new URLSearchParams(location.search);
const invitedRoom = params.get("room");

if (invitedRoom) {
  $("roomInput").value = invitedRoom;
  status("Meeting invitation detected. Please sign in.");
}

showSection("loginSection");
