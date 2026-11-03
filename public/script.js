
/* ================================================
   MEETSPACE FINAL — SCRIPT.JS
   PART 1 / 3
   Navigation, Firebase, Rooms, Gallery, Media
================================================ */

"use strict";

const $ = id => document.getElementById(id);
const socket = io({
  autoConnect: false,
  reconnection: false
});

const MAX_PEOPLE = 10;
const KEYS = [
  "mic", "camera", "share", "chat",
  "hand", "approval", "autoEnd"
];

const DEFAULT_SETTINGS = {
  mic: true,
  camera: true,
  share: false,
  chat: true,
  hand: true,
  approval: true,
  autoEnd: true
};

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

const icons = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 2l20 20M9 9v2a3 3 0 0 0 5 2M15 9V5a3 3 0 0 0-6 0M5 10a7 7 0 0 0 12 5M12 17v5M8 22h8"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="15" height="14" rx="2"/><path d="m17 10 5-3v10l-5-3"/></svg>',
  videoOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 2l20 20M10 5h5a2 2 0 0 1 2 2v3M17 14v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7m15 3 5-3v10l-5-3"/></svg>',
  screen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="15" rx="2"/><path d="M8 22h8M12 18v4m-3-9 3-3 3 3m-3-3v6"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11a9 9 0 0 1-9 9 9 9 0 0 1-4-.9L3 21l2-4a9 9 0 1 1 16-6Z"/></svg>',
  hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 12V5a2 2 0 0 1 4 0v6m0-1V4a2 2 0 0 1 4 0v7m0-1V6a2 2 0 0 1 4 0v9M8 10a2 2 0 0 0-4 0v6c0 4 3 6 7 6h3c4 0 6-3 6-7"/></svg>',
  leave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16v3a2 2 0 0 1-2 2M2 16v3a2 2 0 0 0 2 2m-2-5a10 10 0 0 1 20 0M2 16h5l2 4-2 2m15-6h-5l-2 4 2 2"/></svg>'
};

let currentUser = null;
let currentRoom = null;
let currentRole = null;

let localStream = null;
let screenStream = null;

let participants = [];
let currentSettings = { ...DEFAULT_SETTINGS };

let meetingEndsAt = null;
let meetingStartsAt = null;
let isLeaving = false;

let activeScreenSharer = null;
let selectedMainVideo = "local";

let myHandRaised = false;
let raisedHands = new Set();

let shareGrantUntil = 0;
let pendingPage = "home";
let currentPage = "home";

let sidebarTab = null;
let selectedImage = null;
let imagePreviewUrl = null;

let waitingRoomUsers = [];
let screenRequests = [];

const pendingRequests = new Map();
let pausedRequestKey = null;
let activeRequest = null;

const peers = new Map();
const iceQueue = new Map();
const earlyOffers = new Map();
const pendingPeerReady = new Set();

let adjustmentMode = "add";
let adjustmentPreset = "15";

/* ==========================================
   STATUS / NOTIFICATIONS
========================================== */

function status(message) {
  if ($("status")) {
    $("status").textContent = message;
  }
}

function notify(message, kind = "info") {
  let target = $("meetspaceToastContainer");

  if (!target) {
    target = document.createElement("div");
    target.id = "meetspaceToastContainer";

    target.style.cssText =
      "position:fixed;z-index:99999;top:16px;right:16px;" +
      "width:min(350px,calc(100vw - 32px));" +
      "display:grid;gap:8px;pointer-events:none";

    document.body.appendChild(target);
  }

  const item = document.createElement("div");

  item.setAttribute("role", "status");

  item.style.cssText =
    "padding:12px 14px;border-radius:11px;" +
    "background:#282d45;color:#fff;border:1px solid " +
    (
      kind === "error"
        ? "#df6c85"
        : kind === "success"
          ? "#5bd7b2"
          : "#968bf5"
    ) +
    ";box-shadow:0 12px 35px #0006;" +
    "font:600 12px system-ui";

  item.textContent = message;
  target.appendChild(item);

  setTimeout(() => item.remove(), 4500);
}

function hasAuth() {
  return Boolean(currentUser?.uid);
}

function setVisible(id, visible) {
  if ($(id)) {
    $(id).hidden = !visible;
  }
}

/* ==========================================
   WEBSITE NAVIGATION
========================================== */

function showSection(id) {
  for (const name of [
    "loginSection",
    "homeSection",
    "waitingSection",
    "meetingSection"
  ]) {
    setVisible(name, name === id);
  }

  setVisible(
    "home",
    id !== "meetingSection" && id !== "waitingSection"
  );

  if (id === "meetingSection") {
    document.body.dataset.view = "meeting";
  } else if (id === "waitingSection") {
    document.body.dataset.view = "waiting";
  }
}

function navigate(page, keepHistory = false) {
  if (
    currentRoom &&
    (
      page === "home" ||
      page === "join" ||
      page === "create"
    )
  ) {
    notify("Leave your current meeting first", "error");
    return;
  }

  currentPage = page;

  const isForm =
    page === "create" || page === "join";

  if (isForm && !hasAuth()) {
    pendingPage = page;

    showSection("loginSection");

    setVisible("landingSection", false);
    setVisible("homeBenefits", false);
  } else {
    showSection(
      isForm ? "homeSection" : "loginSection"
    );

    setVisible("loginSection", false);
    setVisible("homeSection", isForm);
    setVisible("landingSection", page === "home");
    setVisible("homeBenefits", page === "home");
  }

  setVisible(
    "createPage",
    page === "create" && hasAuth()
  );

  setVisible(
    "joinPage",
    page === "join" && hasAuth()
  );

  setVisible("features", page === "features");
  setVisible("support", page === "support");

  document.body.dataset.view = page;

  document.querySelectorAll(
    "[data-page], #mobileBottomNav button"
  ).forEach(node => {
    const active = node.dataset.page === page;

    node.classList.toggle("active", active);
    node.classList.toggle("is-active", active);

    if (node.closest(".mobile-bottom-nav")) {
      if (active) {
        node.setAttribute("aria-current", "page");
      } else {
        node.removeAttribute("aria-current");
      }
    }
  });

  if (!keepHistory && page !== "meeting") {
    const url =
      page === "join" &&
      new URLSearchParams(location.search).has("room")
        ? location.pathname + location.search
        : location.pathname;

    history.replaceState({}, "", url);
  }

  window.scrollTo(0, 0);
}

/* ==========================================
   SERVER REQUEST WITH ACKNOWLEDGEMENT
========================================== */

function request(
  event,
  data = {},
  timeoutMs = 20000
) {
  return new Promise((resolve, reject) => {
    if (!socket.connected) {
      return reject(
        new Error("Not connected to meeting server")
      );
    }

    socket.timeout(timeoutMs).emit(
      event,
      data,
      (error, response) => {
        if (error) {
          return reject(
            new Error(
              `Server did not respond to ${event}. ` +
              "Restart the server and check its terminal."
            )
          );
        }

        if (
          !response ||
          typeof response.ok !== "boolean"
        ) {
          return reject(
            new Error(
              `Unexpected response from ${event}`
            )
          );
        }

        resolve(response);
      }
    );
  });
}

/* ==========================================
   FIREBASE AUTHENTICATION
========================================== */

async function waitForFirebase() {
  for (let tries = 0; tries < 100; tries++) {
    if (window.meetspaceAuth) {
      await window.meetspaceAuth.authReady;
      return window.meetspaceAuth;
    }

    await new Promise(
      done => setTimeout(done, 100)
    );
  }

  throw new Error(
    "Firebase Auth not available. Check firebase-auth.js"
  );
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

function setUser(user, displayName) {
  if (!user?.uid) return;

  currentUser = {
    uid: user.uid,
    name:
      displayName ||
      user.displayName ||
      user.email ||
      "Guest",
    email: user.email || null,
    guest: Boolean(user.isAnonymous)
  };

  if ($("userInfo")) {
    $("userInfo").textContent =
      currentUser.name;
  }

  navigate(
    pendingPage === "home"
      ? currentPage
      : pendingPage,
    true
  );

  status("Signed in as " + currentUser.name);
}

async function loginGoogle() {
  try {
    $("googleLoginBtn").disabled = true;

    const fb = await waitForFirebase();
    const user = await fb.loginWithGoogle();

    setUser(user);
  } catch (error) {
    notify(error.message, "error");
  } finally {
    $("googleLoginBtn").disabled = false;
  }
}

async function loginGuest() {
  const name = $("guestName").value.trim();

  if (!name) {
    return notify(
      "Enter your guest name",
      "error"
    );
  }

  $("guestContinueBtn").disabled = true;

  try {
    const fb = await waitForFirebase();
    const user = await fb.loginAsGuest();

    try {
      localStorage.setItem(
        "meetspace-guest-name-" + user.uid,
        name
      );
    } catch {}

    setUser(user, name);
  } catch (error) {
    notify(error.message, "error");
  } finally {
    $("guestContinueBtn").disabled = false;
  }
}

async function restoreSession() {
  try {
    const fb = await waitForFirebase();

    fb.onAuthStateChanged(
      fb.auth,
      user => {
        if (!user || currentUser) return;

        if (user.isAnonymous) {
          const name =
            savedGuestName(user.uid);

          if (name) {
            setUser(user, name);
          } else {
            $("guestNameSection").hidden = false;

            if (
              currentPage === "create" ||
              currentPage === "join"
            ) {
              showSection("loginSection");
            }
          }
        } else {
          setUser(user);
        }
      }
    );
  } catch (error) {
    console.error(error);
    status(error.message);
  }
}

/* ==========================================
   METERED TURN / SOCKET.IO CONNECTION
========================================== */

async function loadIceServers() {
  try {
    const fb = await waitForFirebase();
    const token = await fb.getUserToken();

    const result = await fetch(
      "/api/ice-servers",
      {
        headers: {
          Authorization: "Bearer " + token
        },
        cache: "no-store"
      }
    );

    if (!result.ok) {
      throw new Error(
        `ICE configuration: ${result.status}`
      );
    }

    const data = await result.json();

    if (
      !Array.isArray(data.iceServers) ||
      !data.iceServers.length
    ) {
      throw new Error(
        "No ICE servers provided"
      );
    }

    rtcConfig.iceServers =
      data.iceServers;

    console.info(
      "ICE source:",
      data.source
    );
  } catch (error) {
    console.warn(
      "TURN failed; using STUN:",
      error
    );
  }
}

async function connectSocket() {
  if (socket.connected) return;

  if (!currentUser) {
    throw new Error(
      "Sign in before joining"
    );
  }

  const fb = await waitForFirebase();

  socket.auth = {
    credential: await fb.getUserToken(),
    name: currentUser.name
  };

  await loadIceServers();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("connect", done);
      socket.off("connect_error", failed);

      reject(
        new Error(
          "Could not connect to server"
        )
      );
    }, 15000);

    function done() {
      clearTimeout(timer);
      socket.off("connect_error", failed);
      resolve();
    }

    function failed(error) {
      clearTimeout(timer);
      socket.off("connect", done);
      reject(error);
    }

    socket.once("connect", done);
    socket.once("connect_error", failed);

    socket.connect();
  });
}

/* ==========================================
   MEETING ROOM HELPERS
========================================== */

function meetingLink(roomId) {
  return (
    location.origin +
    "/?room=" +
    encodeURIComponent(roomId)
  );
}

function applyMeetingTiming(data) {
  if (
    Number.isFinite(Number(data?.startsAt)) &&
    Number(data.startsAt) > 0
  ) {
    meetingStartsAt =
      Number(data.startsAt);
  }

  if (
    Number.isFinite(Number(data?.endsAt)) &&
    Number(data.endsAt) > 0
  ) {
    meetingEndsAt =
      Number(data.endsAt);
  }

  renderMeetingClock();
}

function enterMeeting(roomId, role) {
  currentRoom = roomId;

  currentRole =
    role === "host"
      ? "host"
      : "participant";

  $("roomText").textContent = roomId;

  $("roleText").textContent =
    currentRole === "host"
      ? "Host"
      : "Participant";

  showSection("meetingSection");

  setVisible("features", false);
  setVisible("support", false);

  document.body.dataset.view =
    "meeting";

  closeSidebar();
  closeMoreMenu();

  syncHostActions();
  renderMeetingClock();
  updateControls();

  history.replaceState(
    {},
    "",
    meetingLink(roomId)
  );

  window.scrollTo(0, 0);
}

/* ==========================================
   MEETING SETTINGS VALIDATION
========================================== */

function readCreateSettings() {
  const settings = {};

  for (const key of KEYS) {
    settings[key] =
      Boolean(
        $("setting-" + key)?.checked
      );
  }

  return settings;
}

function createMeetingPayload(password) {
  const selected = $("meetingDuration");

  const isCustom =
    selected.selectedOptions[0]
      ?.dataset.custom === "true";

  const raw = isCustom
    ? $("meetingCustomDuration").value
    : selected.value;

  const durationMinutes = Number(raw);

  if (
    raw === "" ||
    !Number.isInteger(durationMinutes) ||
    durationMinutes < 5 ||
    durationMinutes > 1440
  ) {
    throw new Error(
      "Meeting duration must be 5–1440 whole minutes"
    );
  }

  const payload = {
    password,
    durationMinutes,
    settings: readCreateSettings()
  };

  if (
    $("meetingType").value === "scheduled"
  ) {
    const date = $("meetingDate").value;
    const time = $("meetingTime").value;

    if (!date || !time) {
      throw new Error(
        "Choose meeting date and start time"
      );
    }

    const startsAt = new Date(
      date + "T" + time
    ).getTime();

    if (
      !Number.isFinite(startsAt) ||
      startsAt <= Date.now()
    ) {
      throw new Error(
        "Choose a future start time"
      );
    }

    payload.startsAt = startsAt;
  }

  return payload;
}

/* ==========================================
   CREATE MEETING
========================================== */

async function createMeeting() {
  const password =
    $("createPassword").value;

  if (
    password.length < 4 ||
    password.length > 64
  ) {
    return notify(
      "Meeting password must be 4–64 characters",
      "error"
    );
  }

  const button = $("createBtn");
  button.disabled = true;

  try {
    const payload =
      createMeetingPayload(password);

    await connectSocket();

    const result = await request(
      "create-room",
      payload
    );

    if (!result.ok) {
      throw new Error(result.error);
    }

    currentSettings =
      result.settings || payload.settings;

    applyMeetingTiming(result);

    enterMeeting(
      result.roomId,
      "host"
    );

    renderParticipants(
      result.participants || []
    );

    await startMedia();

    notify(
      "Meeting created. Share your invite link and password separately.",
      "success"
    );
  } catch (error) {
    console.error(error);
    notify(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

/* ==========================================
   JOIN MEETING
========================================== */

async function joinMeeting() {
  const roomId =
    $("roomInput").value.trim();

  const password =
    $("joinPassword").value;

  if (!roomId || !password) {
    return notify(
      "Enter Meeting ID and password",
      "error"
    );
  }

  const button = $("joinBtn");
  button.disabled = true;

  try {
    await connectSocket();

    currentRoom = roomId;

    const result = await request(
      "request-join",
      { roomId, password }
    );

    if (!result.ok) {
      throw new Error(result.error);
    }

    if (result.status === "waiting") {
      showSection("waitingSection");

      status(
        "Waiting for host approval"
      );

      notify(
        "Join request sent to host",
        "success"
      );
    }

    // Direct Join:
    // Server also emits "join-approved".
  } catch (error) {
    console.error(error);
    currentRoom = null;
    notify(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

/* ==========================================
   SCREEN / CAMERA / WEBRTC MEDIA
========================================== */

function boxFor(id) {
  return $("video-" + id);
}

function screenBoxFor(id) {
  return $("share-" + id);
}

function makeVideoBox(
  id,
  name,
  stream,
  isLocal = false,
  isScreen = false
) {
  const domId =
    (isScreen ? "share-" : "video-") + id;

  let box = $(domId);

  if (!box) {
    box = document.createElement("div");

    box.id = domId;
    box.className = "video-box";
    box.dataset.personId = id;
    box.dataset.isScreen =
      isScreen ? "yes" : "no";

    const video =
      document.createElement("video");

    video.autoplay = true;
    video.playsInline = true;
    video.muted = isLocal;

    const avatar =
      document.createElement("div");

    avatar.className =
      "ms-video-avatar";

    const label =
      document.createElement("span");

    label.className = "video-label";

    box.append(video, avatar, label);

    if (isScreen) {
      $("mainVideoStage").appendChild(box);
    } else {
      $("videoGrid").appendChild(box);
    }

    if (!isScreen) {
      box.addEventListener("click", () => {
        if (activeScreenSharer) return;

        selectedMainVideo = id;
        renderVideoLayout();
      });
    }
  }

  box.dataset.name = name;

  box.querySelector(
    ".video-label"
  ).textContent = name;

  const video = box.querySelector("video");

  if (
    stream &&
    video.srcObject !== stream
  ) {
    video.srcObject = stream;
  }

  video.muted = isLocal;
  video.play().catch(() => {});

  return box;
}

function createVideo(
  id,
  name,
  stream,
  isLocal = false
) {
  const box = makeVideoBox(
    id,
    name,
    stream,
    isLocal,
    false
  );

  updateVideoPlaceholders();
  renderVideoLayout();

  return box;
}

function createScreenVideo(id, stream) {
  const person = participants.find(
    item => item.id === id
  );

  const name =
    id === "local"
      ? currentUser?.name || "You"
      : person?.name || "Participant";

  const box = makeVideoBox(
    id,
    name + " (Screen)",
    stream,
    id === "local",
    true
  );

  return box;
}

function updateVideoPlaceholders() {
  document.querySelectorAll(
    ".video-box"
  ).forEach(box => {
    const id = box.dataset.personId;
    const isScreen =
      box.dataset.isScreen === "yes";

    const video =
      box.querySelector("video");

    const person = participants.find(
      item => item.id === id
    );

    const enabled =
      id === "local"
        ? Boolean(
            localStream?.getVideoTracks()[0]
              ?.enabled
          )
        : person?.videoEnabled !== false;

    // Camera and Screen are different tracks.
    // Camera Off must not hide the shared screen.

    const cameraOff =
      !isScreen &&
      (
        !enabled ||
        !video?.srcObject?.getVideoTracks()
          .length
      );

    box.classList.toggle(
      "is-camera-off",
      cameraOff
    );

    const avatar =
      box.querySelector(".ms-video-avatar");

    if (avatar) {
      avatar.textContent =
        (box.dataset.name || "?")
          .replace(/\s*\(.*?\)/g, "")
          .trim()
          .charAt(0)
          .toUpperCase() || "?";
    }
  });
}

/* ==========================================
   GALLERY AND FILMSTRIP LAYOUT
========================================== */

function renderVideoLayout() {
  const stage = $("videoStage");
  const main = $("mainVideoStage");
  const grid = $("videoGrid");

  if (!stage || !main || !grid) return;

  const shareId = activeScreenSharer;

  const sharingBox = shareId
    ? screenBoxFor(shareId)
    : null;

  const isSharing =
    Boolean(sharingBox);

  stage.classList.toggle(
    "ms-sharing-view",
    isSharing
  );

  stage.classList.toggle(
    "ms-gallery-view",
    !isSharing
  );

  main.hidden = !isSharing;

  grid.classList.toggle(
    "ms-filmstrip",
    isSharing
  );

  grid.classList.toggle(
    "ms-gallery",
    !isSharing
  );

  grid.classList.remove("ms-odd");

  if (sharingBox) {
    main.appendChild(sharingBox);
  }

  main.querySelectorAll(
    ".video-box"
  ).forEach(box => {
    if (box !== sharingBox) {
      box.remove();
    }
  });

  const boxes = [
    ...grid.querySelectorAll(".video-box")
  ].filter(
    box => box.dataset.isScreen !== "yes"
  );

  for (const box of boxes) {
    box.classList.remove("ms-focused");
    grid.appendChild(box);
  }

  if (isSharing) {
    grid.style.removeProperty(
      "--ms-gallery-columns"
    );

    grid.style.removeProperty(
      "--ms-gallery-rows"
    );
  } else {
    const count = boxes.length;

    const odd =
      count > 1 && count % 2 === 1;

    const columns = odd
      ? 3
      : count <= 2
        ? Math.max(1, count)
        : count <= 4
          ? 2
          : count <= 6
            ? 3
            : count <= 8
              ? 4
              : 5;

    const rows = odd
      ? Math.ceil((count + 3) / 3)
      : Math.ceil(count / columns);

    grid.classList.toggle(
      "ms-odd",
      odd
    );

    grid.style.setProperty(
      "--ms-gallery-columns",
      String(columns)
    );

    grid.style.setProperty(
      "--ms-gallery-rows",
      String(Math.max(1, rows))
    );

    if (odd) {
      const focus = boxes.find(
        box =>
          box.dataset.personId ===
          selectedMainVideo
      ) || boxes[0];

      grid.prepend(focus);
      focus?.classList.add("ms-focused");
    }
  }

  if ($("galleryHeading")) {
    $("galleryHeading").textContent =
      isSharing
        ? "Screen sharing"
        : "Gallery view";
  }

  if ($("galleryHint")) {
    $("galleryHint").textContent =
      isSharing
        ? "Shared content is large. Camera thumbnails are below."
        : "Click a video to focus it when the participant count is odd.";
  }

  if ($("galleryParticipantBadge")) {
    $("galleryParticipantBadge").textContent =
      participants.length +
      "/" +
      MAX_PEOPLE +
      " people";
  }

  updateVideoPlaceholders();
}

function showScreenBanner(name) {
  $("screenShareBanner").hidden = !name;

  if (name) {
    $("screenShareName").textContent =
      name + " is sharing their screen";
  }
}

function refreshRemoteSharing() {
  if (!activeScreenSharer) {
    $("mainVideoStage").replaceChildren();

    showScreenBanner(null);
    renderVideoLayout();
    return;
  }

  if (activeScreenSharer === "local") {
    if (screenStream) {
      createScreenVideo(
        "local",
        screenStream
      );
    }

    showScreenBanner(
      currentUser?.name || "You"
    );
  } else {
    const record =
      peers.get(activeScreenSharer);

    createScreenVideo(
      activeScreenSharer,
      record?.screenStream ||
        new MediaStream()
    );

    showScreenBanner(
      participants.find(
        item =>
          item.id === activeScreenSharer
      )?.name || "Participant"
    );
  }

  renderVideoLayout();
}

/* ==========================================
   CAMERA AND MICROPHONE
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
  } catch {
    try {
      localStream =
        await navigator.mediaDevices.getUserMedia({
          video: true
        });
    } catch {
      try {
        localStream =
          await navigator.mediaDevices.getUserMedia({
            audio: true
          });
      } catch {
        localStream = new MediaStream();

        notify(
          "Camera and microphone unavailable. You can still watch and chat.",
          "error"
        );
      }
    }
  }

  if (currentRole !== "host") {
    if (!currentSettings.mic) {
      localStream
        .getAudioTracks()
        .forEach(track => {
          track.enabled = false;
        });
    }

    if (!currentSettings.camera) {
      localStream
        .getVideoTracks()
        .forEach(track => {
          track.enabled = false;
        });
    }
  }

  createVideo(
    "local",
    currentUser.name + " (You)",
    localStream,
    true
  );

  updateControls();
  emitMediaState();

  // Handle offers received while the browser
  // was asking for camera/microphone permission.

  for (const [id, offer] of [
    ...earlyOffers
  ]) {
    earlyOffers.delete(id);

    await handleSignal(id, offer);
  }

  for (const id of [
    ...pendingPeerReady
  ]) {
    pendingPeerReady.delete(id);

    await callPeer(id);
  }

  if (
    socket.connected &&
    currentRoom
  ) {
    socket.emit("media-ready");
  }
}

function emitMediaState() {
  if (
    !currentRoom ||
    !socket.connected
  ) return;

  socket.emit("media-state", {
    micEnabled: Boolean(
      localStream?.getAudioTracks()[0]
        ?.enabled
    ),
    videoEnabled: Boolean(
      localStream?.getVideoTracks()[0]
        ?.enabled
    )
  });
}

/* END OF PART 1
   CONTINUE WITH PART 2 BELOW THIS LINE */

/* ================================================
   MEETSPACE FINAL — SCRIPT.JS
   PART 2 / 3
   WEBRTC + SCREEN SHARE + PANEL + CHAT
================================================ */

/* ==========================================
   WEBRTC CONNECTION — THREE TRANSCEIVERS
   1. AUDIO
   2. CAMERA
   3. SCREEN SHARING
========================================== */

function createPeer(id) {
  if (peers.has(id)) {
    return peers.get(id);
  }

  const pc =
    new RTCPeerConnection(rtcConfig);

  const record = {
    pc,

    audio: pc.addTransceiver(
      "audio",
      { direction: "sendrecv" }
    ),

    camera: pc.addTransceiver(
      "video",
      { direction: "sendrecv" }
    ),

    screen: pc.addTransceiver(
      "video",
      { direction: "sendrecv" }
    ),

    cameraStream: new MediaStream(),
    screenStream: new MediaStream(),
    offering: false
  };

  peers.set(id, record);
  iceQueue.set(id, []);

  const putTrack = (
    transceiver,
    track
  ) => {
    transceiver.sender
      .replaceTrack(track || null)
      .catch(error => {
        console.error(
          "replaceTrack:",
          error
        );
      });
  };

  putTrack(
    record.audio,
    localStream?.getAudioTracks()[0]
  );

  putTrack(
    record.camera,
    localStream?.getVideoTracks()[0]
  );

  putTrack(
    record.screen,
    screenStream?.getVideoTracks()[0]
  );

  pc.ontrack = event => {
    const transceiver =
      event.transceiver;

    if (transceiver === record.audio) {
      const exists =
        record.cameraStream
          .getAudioTracks()
          .some(
            track =>
              track.id === event.track.id
          );

      if (!exists) {
        record.cameraStream.addTrack(
          event.track
        );
      }
    } else if (
      transceiver === record.camera
    ) {
      const exists =
        record.cameraStream
          .getVideoTracks()
          .some(
            track =>
              track.id === event.track.id
          );

      if (!exists) {
        record.cameraStream.addTrack(
          event.track
        );
      }
    } else if (
      transceiver === record.screen
    ) {
      const exists =
        record.screenStream
          .getVideoTracks()
          .some(
            track =>
              track.id === event.track.id
          );

      if (!exists) {
        record.screenStream.addTrack(
          event.track
        );
      }

      event.track.onunmute = () => {
        if (activeScreenSharer === id) {
          refreshRemoteSharing();
        }
      };
    }

    const name =
      participants.find(
        person => person.id === id
      )?.name || "Participant";

    createVideo(
      id,
      name,
      record.cameraStream
    );

    if (activeScreenSharer === id) {
      refreshRemoteSharing();
    }
  };

  pc.onicecandidate = event => {
    if (
      event.candidate &&
      socket.connected
    ) {
      socket.emit(
        "signal",
        {
          to: id,
          signal: {
            type: "candidate",
            candidate: event.candidate
          }
        }
      );
    }
  };

  pc.onconnectionstatechange = () => {
    if (
      pc.connectionState === "failed"
    ) {
      console.warn(
        "Peer connection failed:",
        id
      );
    }
  };

  createVideo(
    id,
    participants.find(
      person => person.id === id
    )?.name || "Participant",
    record.cameraStream
  );

  return record;
}

async function callPeer(id) {
  if (
    !id ||
    id === socket.id ||
    !currentRoom ||
    peers.has(id)
  ) {
    return;
  }

  if (!localStream) {
    pendingPeerReady.add(id);
    return;
  }

  const record = createPeer(id);

  try {
    record.offering = true;

    const offer =
      await record.pc.createOffer();

    await record.pc.setLocalDescription(
      offer
    );

    socket.emit(
      "signal",
      {
        to: id,
        signal: {
          type: "offer",
          sdp: record.pc.localDescription
        }
      }
    );
  } catch (error) {
    console.error(
      "Sending offer:",
      error
    );
  } finally {
    record.offering = false;
  }
}

async function flushCandidates(id) {
  const record = peers.get(id);

  if (
    !record?.pc.remoteDescription
  ) return;

  const queued =
    iceQueue.get(id) || [];

  iceQueue.set(id, []);

  for (const ice of queued) {
    try {
      await record.pc.addIceCandidate(
        ice
      );
    } catch (error) {
      console.warn(
        "ICE candidate:",
        error
      );
    }
  }
}

async function handleSignal(from, signal) {
  if (
    !signal ||
    !from ||
    !currentRoom
  ) return;

  if (
    !localStream &&
    signal.type === "offer"
  ) {
    earlyOffers.set(from, signal);
    return;
  }

  if (
    !localStream &&
    signal.type === "candidate"
  ) {
    const list =
      iceQueue.get(from) || [];

    list.push(signal.candidate);
    iceQueue.set(from, list);
    return;
  }

  const oldCandidates =
    iceQueue.get(from) || [];

  const record = createPeer(from);
  const pc = record.pc;

  if (
    oldCandidates.length &&
    !iceQueue.get(from)?.length
  ) {
    iceQueue.set(
      from,
      oldCandidates
    );
  }

  try {
    if (signal.type === "offer") {
      await pc.setRemoteDescription(
        signal.sdp
      );

      await flushCandidates(from);

      const answer =
        await pc.createAnswer();

      await pc.setLocalDescription(
        answer
      );

      socket.emit(
        "signal",
        {
          to: from,
          signal: {
            type: "answer",
            sdp: pc.localDescription
          }
        }
      );
    } else if (
      signal.type === "answer"
    ) {
      await pc.setRemoteDescription(
        signal.sdp
      );

      await flushCandidates(from);
    } else if (
      signal.type === "candidate"
    ) {
      if (pc.remoteDescription) {
        await pc.addIceCandidate(
          signal.candidate
        );
      } else {
        iceQueue.get(from).push(
          signal.candidate
        );
      }
    }
  } catch (error) {
    console.error(
      "WebRTC signal error:",
      error
    );

    status(
      "Video connection issue: " +
      error.message
    );
  }
}

function removePeer(id) {
  const record = peers.get(id);

  if (record) {
    record.pc.close();
  }

  peers.delete(id);
  iceQueue.delete(id);
  earlyOffers.delete(id);
  pendingPeerReady.delete(id);

  boxFor(id)?.remove();
  screenBoxFor(id)?.remove();

  if (selectedMainVideo === id) {
    selectedMainVideo = "local";
  }

  if (activeScreenSharer === id) {
    activeScreenSharer = null;
  }

  refreshRemoteSharing();
}

/* ==========================================
   SCREEN SHARE WITH CAMERA SEPARATE
========================================== */

async function startScreenShare() {
  if (
    !currentRoom ||
    screenStream
  ) return;

  if (
    !navigator.mediaDevices
      ?.getDisplayMedia
  ) {
    throw new Error(
      "This browser cannot share its screen. Use desktop Chrome or Edge."
    );
  }

  // Browser must receive this call from
  // a real user's click gesture.

  const captured =
    await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false
    });

  const track =
    captured.getVideoTracks()[0];

  if (!track) {
    captured.getTracks().forEach(
      item => item.stop()
    );

    throw new Error(
      "Screen capture did not supply a video track"
    );
  }

  try {
    const permission = await request(
      "screen-share-state",
      { sharing: true }
    );

    if (!permission.ok) {
      throw new Error(
        permission.error
      );
    }

    // Dedicated screen sender exists
    // even when camera track is OFF.

    await Promise.all(
      [...peers.values()].map(
        record =>
          record.screen.sender.replaceTrack(
            track
          )
      )
    );

    screenStream = captured;
    shareGrantUntil = 0;

    activeScreenSharer = "local";
    selectedMainVideo = "local";

    refreshRemoteSharing();

    track.onended = () => {
      stopScreenShare().catch(
        console.error
      );
    };

    updateControls();

    notify(
      "Screen sharing started",
      "success"
    );
  } catch (error) {
    captured.getTracks().forEach(
      item => item.stop()
    );

    await Promise.allSettled(
      [...peers.values()].map(
        record =>
          record.screen.sender.replaceTrack(
            null
          )
      )
    );

    if (socket.connected) {
      socket.emit(
        "screen-share-state",
        { sharing: false }
      );
    }

    throw error;
  }
}

async function stopScreenShare() {
  if (!screenStream) return;

  const captured = screenStream;
  screenStream = null;

  const track =
    captured.getVideoTracks()[0];

  if (track) {
    track.onended = null;
  }

  await Promise.allSettled(
    [...peers.values()].map(
      record =>
        record.screen.sender.replaceTrack(
          null
        )
    )
  );

  captured.getTracks().forEach(
    item => item.stop()
  );

  if (socket.connected) {
    socket.emit(
      "screen-share-state",
      { sharing: false }
    );
  }

  activeScreenSharer = null;

  refreshRemoteSharing();
  updateControls();

  notify(
    "Screen sharing stopped"
  );
}

async function toggleScreen() {
  if (!currentRoom) return;

  const button = $("screenBtn");
  button.disabled = true;

  try {
    if (screenStream) {
      return await stopScreenShare();
    }

    if (
      !navigator.mediaDevices
        ?.getDisplayMedia
    ) {
      throw new Error(
        "Screen sharing is not supported in this browser; viewing shares still works."
      );
    }

    const canShare =
      currentRole === "host" ||
      currentSettings.share ||
      shareGrantUntil > Date.now();

    if (canShare) {
      await startScreenShare();
    } else {
      const result = await request(
        "request-screen-share",
        {}
      );

      if (!result.ok) {
        throw new Error(result.error);
      }

      notify(
        "Host has received your screen sharing request",
        "success"
      );
    }
  } catch (error) {
    notify(error.message, "error");
  } finally {
    button.disabled = false;
    updateControls();
  }
}

/* ==========================================
   BUTTON ICONS AND STATES
========================================== */

function control(
  id,
  icon,
  label,
  off = false
) {
  const button = $(id);

  if (!button) return;

  const iconBox =
    button.querySelector(
      ".ms-control-icon"
    );

  const caption =
    button.querySelector(
      ".ms-control-label"
    );

  if (iconBox) {
    iconBox.innerHTML =
      icons[icon] || "";
  }

  if (caption) {
    caption.textContent = label;
  }

  button.classList.toggle(
    "is-off",
    off
  );

  button.setAttribute(
    "aria-label",
    label
  );
}

function updateControls() {
  const mic =
    localStream?.getAudioTracks()[0];

  const cam =
    localStream?.getVideoTracks()[0];

  const micAllowed =
    currentRole === "host" ||
    currentSettings.mic;

  const camAllowed =
    currentRole === "host" ||
    currentSettings.camera;

  control(
    "micBtn",
    mic?.enabled ? "mic" : "micOff",
    !mic
      ? "No mic"
      : mic.enabled
        ? "Mute"
        : "Unmute",
    !mic?.enabled
  );

  control(
    "cameraBtn",
    cam?.enabled ? "video" : "videoOff",
    !cam
      ? "No camera"
      : cam.enabled
        ? "Stop video"
        : "Start video",
    !cam?.enabled
  );

  control(
    "screenBtn",
    "screen",
    screenStream
      ? "Stop share"
      : currentRole === "participant" &&
        !currentSettings.share &&
        shareGrantUntil < Date.now()
        ? "Request share"
        : "Share screen"
  );

  control(
    "raiseHandBtn",
    "hand",
    myHandRaised
      ? "Lower hand"
      : "Raise hand"
  );

  control(
    "toggleChatBtn",
    "chat",
    "Chat"
  );

  control(
    "leaveBtn",
    "leave",
    "Leave"
  );

  $("micBtn").disabled =
    !mic || !micAllowed;

  $("cameraBtn").disabled =
    !cam || !camAllowed;

  $("raiseHandBtn").disabled =
    currentRole !== "host" &&
    !currentSettings.hand;

  $("screenBtn").classList.toggle(
    "is-active",
    Boolean(screenStream)
  );

  $("raiseHandBtn").classList.toggle(
    "is-active",
    myHandRaised
  );

  $("raiseHandBtn").setAttribute(
    "aria-pressed",
    String(myHandRaised)
  );

  const chatAllowed =
    currentRole === "host" ||
    currentSettings.chat;

  for (const id of [
    "chatInput",
    "chatSendBtn",
    "attachImageBtn"
  ]) {
    if ($(id)) {
      $(id).disabled = !chatAllowed;
    }
  }
}

/* ==========================================
   HOST-ONLY BUTTON VISIBILITY
========================================== */

function syncHostActions() {
  const host =
    currentRole === "host" &&
    Boolean(currentRoom);

  for (const id of [
    "roomSettingsBtn",
    "extendMeetingBtn",
    "roomRequestsBtn",
    "toggleRequestsBtn",
    "showRequestsTab",
    "moreRequestsBtn",
    "moreSettingsBtn",
    "moreAdjustTimeBtn"
  ]) {
    if ($(id)) {
      $(id).hidden = !host;
    }
  }

  if ($("hostPanel")) {
    $("hostPanel").hidden = !host;
  }

  if (
    !host &&
    sidebarTab === "requests"
  ) {
    closeSidebar();
  }

  updateRequestIndicator();
}

/* ==========================================
   ZOOM-STYLE OPEN / CLOSE SIDE PANEL
========================================== */

function openSidebar(tab) {
  if (!currentRoom) return;

  closeMoreMenu();

  if (
    sidebarTab === tab &&
    !$("meetingSidebar").hidden
  ) {
    return closeSidebar();
  }

  if (
    tab === "requests" &&
    currentRole !== "host"
  ) {
    return;
  }

  sidebarTab = tab;

  $("meetingSidebar").hidden = false;

  $("meetingLayout").classList.add(
    "sidebar-open"
  );

  for (const [name, panel] of [
    ["people", "participantsPanel"],
    ["chat", "chatPanel"],
    ["requests", "requestsPanel"]
  ]) {
    $(panel).hidden =
      name !== tab;
  }

  for (const [name, buttonId] of [
    ["people", "showParticipantsTab"],
    ["chat", "showChatTab"],
    ["requests", "showRequestsTab"]
  ]) {
    $(buttonId)?.classList.toggle(
      "is-active",
      name === tab
    );
  }

  for (const [name, buttonId] of [
    ["people", "toggleParticipantsBtn"],
    ["chat", "toggleChatBtn"],
    ["requests", "toggleRequestsBtn"]
  ]) {
    $(buttonId)?.classList.toggle(
      "is-active",
      name === tab
    );

    $(buttonId)?.setAttribute(
      "aria-expanded",
      String(name === tab)
    );
  }

  const titles = {
    people: [
      "Participants",
      "People in this meeting"
    ],
    chat: [
      "Meeting chat",
      "Public and private messages"
    ],
    requests: [
      "Meeting requests",
      "Join and screen-share approvals"
    ]
  };

  $("sidebarPanelTitle").textContent =
    titles[tab][0];

  $("sidebarPanelSubtitle").textContent =
    titles[tab][1];

  if (tab === "requests") {
    pausedRequestKey = null;
    $("requestPopup").hidden = true;
  }

  updateRequestIndicator();
}

function closeSidebar() {
  sidebarTab = null;

  $("meetingSidebar").hidden = true;

  $("meetingLayout").classList.remove(
    "sidebar-open"
  );

  for (const id of [
    "toggleParticipantsBtn",
    "toggleChatBtn",
    "toggleRequestsBtn"
  ]) {
    $(id)?.setAttribute(
      "aria-expanded",
      "false"
    );
  }

  for (const id of [
    "toggleParticipantsBtn",
    "toggleChatBtn",
    "toggleRequestsBtn"
  ]) {
    $(id)?.classList.remove(
      "is-active"
    );
  }
}

function closeMoreMenu() {
  $("meetingMoreMenu").hidden = true;

  $("moreBtn").setAttribute(
    "aria-expanded",
    "false"
  );
}

function toggleMoreMenu() {
  const open =
    $("meetingMoreMenu").hidden;

  if (open) {
    closeSidebar();
  }

  $("meetingMoreMenu").hidden = !open;

  $("moreBtn").setAttribute(
    "aria-expanded",
    String(open)
  );
}

/* ==========================================
   PARTICIPANT LIST
========================================== */

function renderParticipants(list) {
  participants =
    Array.isArray(list) ? list : [];

  $("participantCount").textContent =
    `(${participants.length}/${MAX_PEOPLE})`;

  const panel = $("participantList");
  panel.replaceChildren();

  for (const person of participants) {
    const row =
      document.createElement("div");

    row.className = "participant-item";

    const avatar =
      document.createElement("span");

    avatar.textContent =
      (person.name || "?")
        .slice(0, 1)
        .toUpperCase();

    avatar.style.cssText =
      "display:grid;place-items:center;" +
      "flex:0 0 31px;height:31px;" +
      "border-radius:9px;background:#3b4465;" +
      "color:#fff;font-weight:850";

    const details =
      document.createElement("div");

    details.className =
      "participant-details";

    const title =
      document.createElement("span");

    title.className =
      "participant-name";

    title.textContent =
      (person.name || "Guest") +
      (
        person.id === socket.id
          ? " (You)"
          : ""
      ) +
      (
        raisedHands.has(person.id)
          ? " ✋"
          : ""
      );

    const role =
      document.createElement("span");

    role.className =
      "participant-role";

    role.textContent =
      person.role === "host"
        ? "Host"
        : "Participant";

    details.append(title, role);
    row.append(avatar, details);

    if (
      currentRole === "host" &&
      person.id !== socket.id
    ) {
      const actions =
        document.createElement("div");

      actions.className =
        "participant-actions";

      const action = (text, event) => {
        const button =
          document.createElement("button");

        button.type = "button";
        button.textContent = text;

        button.addEventListener(
          "click",
          async () => {
            button.disabled = true;

            try {
              const reply = await request(
                event,
                person.id
              );

              if (!reply.ok) {
                throw new Error(
                  reply.error
                );
              }

              notify(
                text + " sent",
                "success"
              );
            } catch (error) {
              notify(
                error.message,
                "error"
              );
            } finally {
              button.disabled = false;
            }
          }
        );

        return button;
      };

      actions.append(
        action(
          person.micEnabled === false
            ? "Ask unmute"
            : "Mute",
          person.micEnabled === false
            ? "ask-participant-unmute"
            : "mute-participant"
        ),

        action(
          person.videoEnabled === false
            ? "Ask video"
            : "Stop video",
          person.videoEnabled === false
            ? "ask-participant-video"
            : "stop-participant-video"
        )
      );

      row.appendChild(actions);
    }

    panel.appendChild(row);

    const box = boxFor(person.id);

    if (box) {
      box.querySelector(
        ".video-label"
      ).textContent = person.name;
    }
  }

  updateChatRecipients();
  updateRaisedHandsUI();
  renderVideoLayout();
}

/* ==========================================
   HAND RAISE INDICATORS
========================================== */

function updateRaisedHandsUI() {
  $("raisedHandCount").textContent =
    raisedHands.size;

  $("raisedHandsBar").hidden =
    raisedHands.size === 0;

  $("raisedHandsNames").textContent =
    participants
      .filter(
        person =>
          raisedHands.has(person.id)
      )
      .map(
        person => person.name
      )
      .join(", ");

  document.querySelectorAll(
    "#videoGrid .video-box"
  ).forEach(box => {
    let icon =
      box.querySelector(
        ".hand-indicator"
      );

    const id =
      box.dataset.personId === "local"
        ? socket.id
        : box.dataset.personId;

    if (raisedHands.has(id)) {
      if (!icon) {
        icon =
          document.createElement("span");

        icon.className =
          "hand-indicator";

        icon.textContent = "✋";

        box.appendChild(icon);
      }
    } else {
      icon?.remove();
    }
  });
}

/* ==========================================
   CHAT RECIPIENTS
========================================== */

function updateChatRecipients() {
  const input = $("chatRecipient");
  const current = input.value;

  input.replaceChildren();

  const all =
    document.createElement("option");

  all.value = "everyone";
  all.textContent = "Everyone (Public)";

  input.appendChild(all);

  participants
    .filter(
      person =>
        person.id !== socket.id
    )
    .forEach(person => {
      const option =
        document.createElement("option");

      option.value = person.id;

      option.textContent =
        person.name + " (Private)";

      input.appendChild(option);
    });

  const exists = [...input.options].some(
    option =>
      option.value === current
  );

  input.value =
    exists ? current : "everyone";
}

/* ==========================================
   DISPLAY CHAT MESSAGE
========================================== */

function displayChatMessage(message) {
  if (!currentRoom) return;

  $("chatMessages").querySelector(
    ".chat-empty"
  )?.remove();

  const mine =
    message.from === socket.id;

  const bubble =
    document.createElement("div");

  bubble.className =
    "chat-message" +
    (mine ? " mine" : "") +
    (message.private ? " private" : "");

  const header =
    document.createElement("div");

  header.className =
    "chat-message-header";

  const sender =
    document.createElement("span");

  sender.className =
    "chat-message-name";

  sender.textContent = mine
    ? "You"
    : message.fromName ||
      "Participant";

  const recipient =
    document.createElement("span");

  recipient.className =
    "chat-message-type";

  recipient.textContent =
    message.private
      ? mine
        ? "🔒 Private to " +
          message.toName
        : "🔒 Private to you"
      : "Everyone";

  header.append(sender, recipient);
  bubble.appendChild(header);

  if (message.text) {
    const text =
      document.createElement("div");

    text.className =
      "chat-message-text";

    text.textContent =
      message.text;

    bubble.appendChild(text);
  }

  if (
    typeof message.image === "string" &&
    /^data:image\//.test(message.image)
  ) {
    const image =
      document.createElement("img");

    image.alt = "Chat attachment";
    image.src = message.image;
    image.loading = "lazy";

    bubble.appendChild(image);
  }

  const time =
    document.createElement("span");

  time.className =
    "chat-message-time";

  time.textContent = new Date(
    message.timestamp || Date.now()
  ).toLocaleTimeString(
    [],
    {
      hour: "2-digit",
      minute: "2-digit"
    }
  );

  bubble.appendChild(time);

  $("chatMessages").appendChild(
    bubble
  );

  $("chatMessages").scrollTop =
    $("chatMessages").scrollHeight;

  if (sidebarTab !== "chat") {
    $("toggleChatBtn")?.classList.add(
      "has-unread"
    );
  }
}

/* ==========================================
   CHAT IMAGE HANDLING
========================================== */

function clearSelectedImage() {
  selectedImage = null;

  $("chatImageInput").value = "";

  if (imagePreviewUrl) {
    URL.revokeObjectURL(
      imagePreviewUrl
    );
  }

  imagePreviewUrl = null;

  $("chatImageThumbnail")
    .removeAttribute("src");

  $("chatImagePreview").hidden = true;
}

async function sendChat(event) {
  event.preventDefault();

  const text =
    $("chatInput").value.trim();

  if (
    !text &&
    !selectedImage
  ) return;

  const button = $("chatSendBtn");
  button.disabled = true;

  try {
    const payload = {
      text,
      to: $("chatRecipient").value
    };

    if (selectedImage) {
      payload.image =
        await new Promise(
          (resolve, reject) => {
            const reader =
              new FileReader();

            reader.onload = () =>
              resolve(reader.result);

            reader.onerror = () =>
              reject(
                new Error(
                  "Could not read attached image"
                )
              );

            reader.readAsDataURL(
              selectedImage
            );
          }
        );
    }

    const result = await request(
      "chat-message",
      payload,
      selectedImage ? 30000 : 15000
    );

    if (!result.ok) {
      throw new Error(result.error);
    }

    $("chatInput").value = "";

    clearSelectedImage();
  } catch (error) {
    notify(error.message, "error");
  } finally {
    updateControls();
  }
}

function clearChat() {
  $("chatMessages").replaceChildren();

  const empty =
    document.createElement("div");

  empty.className = "chat-empty";

  empty.textContent =
    "No messages yet. Start a conversation!";

  $("chatMessages").appendChild(
    empty
  );

  $("chatInput").value = "";

  clearSelectedImage();
  updateChatRecipients();
}

/* ==========================================
   REQUEST BADGES
========================================== */

function updateRequestIndicator() {
  const count = [
    ...pendingRequests.values()
  ].filter(
    item => !item.consentKind
  ).length;

  for (const id of [
    "roomRequestCount",
    "roomRequestCountTop",
    "roomRequestCountToolbar"
  ]) {
    if ($(id)) {
      $(id).textContent =
        String(count);
    }
  }

  for (const id of [
    "roomRequestCountTop",
    "roomRequestCountToolbar"
  ]) {
    if ($(id)) {
      $(id).hidden =
        count === 0;
    }
  }

  $("requestEmptyMessage").hidden =
    count > 0;
}

function showNextRequest() {
  const item = [
    ...pendingRequests.values()
  ].find(
    item =>
      item.key !== pausedRequestKey
  );

  activeRequest = item || null;

  const popup = $("requestPopup");

  if (!item) {
    popup.hidden = true;
    updateRequestIndicator();
    return;
  }

  $("requestPopupTitle").textContent =
    item.title;

  $("requestPopupDescription").textContent =
    item.description;

  $("requestApproveBtn").textContent =
    item.consentKind
      ? "Allow"
      : "Approve";

  $("requestRejectBtn").textContent =
    item.consentKind
      ? "Decline"
      : "Reject";

  $("requestPopupCounter").textContent =
    pendingRequests.size +
    " pending";

  popup.hidden = false;

  updateRequestIndicator();
}

/* END OF PART 2
   CONTINUE WITH PART 3 BELOW THIS LINE */

/* ================================================
   MEETSPACE FINAL — SCRIPT.JS
   PART 3 / 3
   REQUESTS + TIME + SOCKET EVENTS + STARTUP
================================================ */

/* ==========================================
   JOIN / SCREEN SHARE REQUEST QUEUE
========================================== */

function syncRequestQueue(kind, list) {
  for (const key of [...pendingRequests.keys()]) {
    if (key.startsWith(kind + ":")) {
      pendingRequests.delete(key);
    }
  }

  if (
    Array.isArray(list) &&
    currentRole === "host"
  ) {
    for (const user of list) {
      if (!user?.id) continue;

      const key =
        kind + ":" + user.id;

      pendingRequests.set(key, {
        key,
        userId: user.id,

        title:
          user.name +
          (
            kind === "join"
              ? " wants to join"
              : " wants to share"
          ),

        description:
          kind === "join"
            ? "Allow this person to enter the meeting?"
            : "Allow screen sharing?",

        approveEvent:
          kind === "join"
            ? "approve-request"
            : "approve-screen-share",

        rejectEvent:
          kind === "join"
            ? "reject-request"
            : "reject-screen-share"
      });
    }
  }

  if (
    pausedRequestKey &&
    !pendingRequests.has(
      pausedRequestKey
    )
  ) {
    pausedRequestKey = null;
  }

  showNextRequest();
}

/* ==========================================
   HOST ASKS FOR MICROPHONE / CAMERA CONSENT
========================================== */

function askConsent(kind) {
  const key = "consent:" + kind;

  pendingRequests.set(key, {
    key,
    consentKind: kind,

    title:
      kind === "mic"
        ? "Host requests microphone"
        : "Host requests camera",

    description:
      kind === "mic"
        ? "Would you like to unmute?"
        : "Would you like to turn on your camera?"
  });

  showNextRequest();
}

async function replyToRequest(approve) {
  const item = activeRequest;

  if (!item) return;

  $("requestApproveBtn").disabled = true;
  $("requestRejectBtn").disabled = true;

  try {
    if (
      item.consentKind &&
      approve
    ) {
      const allowed =
        item.consentKind === "mic"
          ? currentSettings.mic
          : currentSettings.camera;

      const track =
        item.consentKind === "mic"
          ? localStream?.getAudioTracks()[0]
          : localStream?.getVideoTracks()[0];

      if (!allowed || !track) {
        throw new Error(
          "Permission or device track unavailable"
        );
      }

      track.enabled = true;

      emitMediaState();
      updateControls();
      updateVideoPlaceholders();
    } else if (!item.consentKind) {
      const result = await request(
        approve
          ? item.approveEvent
          : item.rejectEvent,
        item.userId
      );

      if (!result.ok) {
        throw new Error(result.error);
      }
    }

    pendingRequests.delete(item.key);
    pausedRequestKey = null;

    notify(
      approve
        ? "Request approved"
        : "Request declined",
      "success"
    );
  } catch (error) {
    notify(error.message, "error");
  } finally {
    $("requestApproveBtn").disabled = false;
    $("requestRejectBtn").disabled = false;

    showNextRequest();
  }
}

/* ==========================================
   WAITING ROOM AND SCREEN SHARE REQUEST LIST
========================================== */

function renderWaitingRequests() {
  const host = $("waitingList");

  host.replaceChildren();

  if (!waitingRoomUsers.length) {
    const message =
      document.createElement("p");

    message.textContent =
      "No pending requests";

    host.appendChild(message);
  }

  for (const person of waitingRoomUsers) {
    host.appendChild(
      makeRequestRow(
        person,
        "approve-request",
        "reject-request"
      )
    );
  }

  const sharing =
    $("screenShareRequests");

  sharing.replaceChildren();

  for (const person of screenRequests) {
    sharing.appendChild(
      makeRequestRow(
        person,
        "approve-screen-share",
        "reject-screen-share"
      )
    );
  }

  updateRequestIndicator();
}

function makeRequestRow(
  person,
  acceptEvent,
  declineEvent
) {
  const row =
    document.createElement("div");

  row.className = "waiting-item";

  const name =
    document.createElement("span");

  name.textContent = person.name;

  const buttons =
    document.createElement("div");

  buttons.className =
    "waiting-actions";

  for (const [label, eventName] of [
    ["Approve", acceptEvent],
    ["Reject", declineEvent]
  ]) {
    const button =
      document.createElement("button");

    button.type = "button";
    button.textContent = label;

    button.addEventListener(
      "click",
      async () => {
        button.disabled = true;

        try {
          const result = await request(
            eventName,
            person.id
          );

          if (!result.ok) {
            throw new Error(result.error);
          }

          notify(
            label + " sent",
            "success"
          );
        } catch (error) {
          notify(
            error.message,
            "error"
          );
        } finally {
          button.disabled = false;
        }
      }
    );

    buttons.appendChild(button);
  }

  row.append(name, buttons);

  return row;
}

/* ==========================================
   SETTINGS MODAL HELPERS
========================================== */

function toggleModal(id, show) {
  const dialog = $(id);

  if (!dialog) return;

  dialog.hidden = !show;

  document.body.classList.toggle(
    "ms-dialog-open",
    show
  );

  if (show) {
    dialog.querySelector(
      ".ms-room-dialog"
    )?.focus();
  }
}

function closeAllModals() {
  for (const id of [
    "createSettingsModal",
    "roomSettingsModal",
    "extendMeetingModal"
  ]) {
    toggleModal(id, false);
  }
}

function updateCreateSummary() {
  const duration =
    $("meetingDuration");

  const isCustom =
    duration.selectedOptions[0]
      ?.dataset.custom === "true";

  $("customDurationFields").hidden =
    !isCustom;

  $("scheduledMeetingFields").hidden =
    $("meetingType").value !==
    "scheduled";

  const minutes = isCustom
    ? $("meetingCustomDuration").value
    : duration.value;

  $("createSettingsSummary").textContent =
    `${minutes || "Custom"} minutes · Waiting room ` +
    (
      $("setting-approval").checked
        ? "on"
        : "off"
    );
}

function createSettingsTab(general) {
  $("createGeneralFields").hidden =
    !general;

  $("createPermissionFields").hidden =
    general;

  $("createGeneralTab").classList.toggle(
    "is-active",
    general
  );

  $("createPermissionsTab").classList.toggle(
    "is-active",
    !general
  );
}

/* ==========================================
   HOST SETTINGS
========================================== */

function populateHostSettings() {
  for (const key of KEYS) {
    $("room-setting-" + key).checked =
      Boolean(currentSettings[key]);
  }
}

async function saveHostSettings() {
  if (currentRole !== "host") return;

  const values = {};

  for (const key of KEYS) {
    values[key] =
      $("room-setting-" + key).checked;
  }

  const button =
    $("saveRoomSettingsBtn");

  button.disabled = true;

  try {
    const reply = await request(
      "update-meeting-settings",
      values
    );

    if (!reply.ok) {
      throw new Error(reply.error);
    }

    currentSettings =
      reply.settings || values;

    toggleModal(
      "roomSettingsModal",
      false
    );

    updateControls();

    notify(
      "Host permissions updated",
      "success"
    );
  } catch (error) {
    notify(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

/* ==========================================
   MEETING COUNTDOWN
========================================== */

function formatTime(seconds) {
  const number =
    Math.max(
      0,
      Math.floor(seconds)
    );

  return [
    Math.floor(number / 3600),
    Math.floor(
      number % 3600 / 60
    ),
    number % 60
  ].map(
    value =>
      String(value).padStart(2, "0")
  ).join(":");
}

function remainingSeconds() {
  return meetingEndsAt
    ? Math.max(
        0,
        Math.ceil(
          (meetingEndsAt - Date.now()) /
          1000
        )
      )
    : 0;
}

function renderMeetingClock() {
  $("meetingTimerBlock").hidden =
    !currentRoom || !meetingEndsAt;

  if (
    !currentRoom ||
    !meetingEndsAt
  ) return;

  $("meetingCountdown").textContent =
    formatTime(remainingSeconds());

  $("meetingEndInfo").textContent =
    "Ends " +
    new Date(
      meetingEndsAt
    ).toLocaleTimeString(
      [],
      {
        hour: "2-digit",
        minute: "2-digit"
      }
    );

  if (
    !$("extendMeetingModal").hidden
  ) {
    updateTimePreview();
  }
}

/* ==========================================
   ADD / REDUCE / CUSTOM TIME PREVIEW
========================================== */

function selectedAdjustment() {
  const raw =
    adjustmentPreset === "custom"
      ? $("customExtensionMinutes").value
      : adjustmentPreset;

  if (
    String(raw).trim() === ""
  ) {
    return NaN;
  }

  const value = Number(raw);

  return Number.isInteger(value)
    ? value
    : NaN;
}

function updateTimePreview() {
  const seconds =
    remainingSeconds();

  const minutes =
    selectedAdjustment();

  const signed =
    (
      adjustmentMode === "add"
        ? 1
        : -1
    ) * minutes;

  const next =
    seconds + signed * 60;

  const valid =
    Number.isInteger(minutes) &&
    minutes >= 1 &&
    minutes <= 1440 &&
    next >= 60 &&
    next <= 14 * 24 * 3600;

  $("timeCurrentValue").textContent =
    formatTime(seconds);

  $("timeBeforeValue").textContent =
    formatTime(seconds);

  $("timePreviewValue").textContent =
    valid
      ? formatTime(next)
      : "--:--:--";

  $("timeAdjustError").textContent =
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > 1440
      ? "Enter 1–1440 whole minutes"
      : next < 60
        ? "Keep at least 1 minute remaining"
        : next > 14 * 24 * 3600
          ? "Maximum remaining time: 14 days"
          : "";

  $("confirmExtendMeetingBtn").disabled =
    !valid;

  $("confirmExtendMeetingBtn").textContent =
    (
      adjustmentMode === "add"
        ? "＋ Add "
        : "− Reduce "
    ) +
    (
      Number.isInteger(minutes)
        ? minutes
        : "—"
    ) +
    " min";

  $("timeModeInput").value =
    adjustmentMode;

  $("extensionMinutes").value =
    adjustmentPreset;

  $("customExtensionFields").hidden =
    adjustmentPreset !== "custom";

  document.querySelectorAll(
    "[data-time-mode]"
  ).forEach(button => {
    const active =
      button.dataset.timeMode ===
      adjustmentMode;

    button.classList.toggle(
      "is-active",
      active
    );

    button.setAttribute(
      "aria-pressed",
      String(active)
    );
  });

  document.querySelectorAll(
    "[data-time-preset]"
  ).forEach(button => {
    button.classList.toggle(
      "is-active",
      button.dataset.timePreset ===
        adjustmentPreset
    );
  });
}

function openTimeModal() {
  if (currentRole !== "host") return;

  adjustmentMode = "add";
  adjustmentPreset = "15";

  $("customExtensionMinutes").value =
    "10";

  toggleModal(
    "extendMeetingModal",
    true
  );

  updateTimePreview();
}

/* ==========================================
   APPLY TIME CHANGE TO SERVER
========================================== */

async function applyTimeAdjustment() {
  if (currentRole !== "host") return;

  const minutes =
    selectedAdjustment();

  const signed =
    (
      adjustmentMode === "add"
        ? 1
        : -1
    ) * minutes;

  const next =
    remainingSeconds() +
    signed * 60;

  if (
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > 1440 ||
    next < 60 ||
    next > 14 * 24 * 3600
  ) {
    return notify(
      "Choose valid minutes. At least 1 minute must remain.",
      "error"
    );
  }

  const button =
    $("confirmExtendMeetingBtn");

  button.disabled = true;

  try {
    // This event will be implemented in
    // the updated server.js.

    const reply = await request(
      "adjust-meeting-time",
      { minutes: signed }
    );

    if (!reply.ok) {
      throw new Error(reply.error);
    }

    applyMeetingTiming(reply);

    toggleModal(
      "extendMeetingModal",
      false
    );

    notify(
      `Meeting time ${
        signed > 0
          ? "increased"
          : "reduced"
      } by ${minutes} minute(s)`,
      "success"
    );
  } catch (error) {
    notify(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

/* ==========================================
   INVITE LINK
========================================== */

async function copyInvite() {
  if (!currentRoom) return;

  try {
    await navigator.clipboard.writeText(
      meetingLink(currentRoom)
    );

    notify(
      "Invite link copied — share the password separately",
      "success"
    );
  } catch {
    notify(
      "Clipboard unavailable. Copy the URL from your browser.",
      "error"
    );
  }
}

/* ==========================================
   LEAVE / RESET MEETING
========================================== */

function resetMeeting() {
  const hadRoom =
    Boolean(currentRoom);

  currentRoom = null;
  currentRole = null;

  meetingEndsAt = null;
  meetingStartsAt = null;

  isLeaving = false;
  shareGrantUntil = 0;
  activeScreenSharer = null;

  selectedMainVideo = "local";
  myHandRaised = false;

  raisedHands.clear();

  participants = [];
  waitingRoomUsers = [];
  screenRequests = [];

  pendingRequests.clear();
  activeRequest = null;
  pausedRequestKey = null;

  $("requestPopup").hidden = true;

  if (screenStream) {
    screenStream.getTracks().forEach(
      track => track.stop()
    );
  }

  if (localStream) {
    localStream.getTracks().forEach(
      track => track.stop()
    );
  }

  screenStream = null;
  localStream = null;

  for (const record of peers.values()) {
    record.pc.close();
  }

  peers.clear();
  iceQueue.clear();
  earlyOffers.clear();
  pendingPeerReady.clear();

  $("videoGrid").replaceChildren();
  $("mainVideoStage").replaceChildren();

  $("roomText").textContent = "—";

  closeAllModals();
  closeSidebar();
  closeMoreMenu();

  showScreenBanner(null);
  clearChat();

  $("waitingList").replaceChildren();
  $("screenShareRequests").replaceChildren();

  $("hostPanel").hidden = true;

  if (socket.connected) {
    socket.disconnect();
  }

  currentSettings = {
    ...DEFAULT_SETTINGS
  };

  updateRequestIndicator();

  pendingPage = "home";
  navigate("home");

  if (hadRoom) {
    status("You left the meeting");
  }
}

function leaveMeeting() {
  if (isLeaving) return;

  isLeaving = true;

  if (socket.connected) {
    socket.emit("leave-room");
  }

  resetMeeting();
}

/* ==========================================
   SOCKET.IO EVENTS
========================================== */

socket.on(
  "join-approved",
  async data => {
    try {
      if (!data?.roomId) return;

      currentSettings =
        data.settings ||
        currentSettings;

      applyMeetingTiming(data);

      renderParticipants(
        data.participants || []
      );

      enterMeeting(
        data.roomId,
        data.role || "participant"
      );

      await startMedia();

      notify(
        "You joined the meeting!",
        "success"
      );
    } catch (error) {
      console.error(error);
      notify(error.message, "error");
    }
  }
);

socket.on("join-rejected", data => {
  resetMeeting();

  notify(
    data?.message ||
      "Host rejected your request",
    "error"
  );
});

socket.on("meeting-ended", data => {
  resetMeeting();

  notify(
    data?.reason || "Meeting ended",
    "info"
  );
});

socket.on("user-joined", () => {
  status("A participant joined");
});

socket.on("user-left", id => {
  removePeer(id);

  raisedHands.delete(id);
  updateRaisedHandsUI();
});

socket.on("participants-updated", data => {
  if (
    !currentRoom ||
    (
      data?.roomId &&
      data.roomId !== currentRoom
    )
  ) {
    return;
  }

  if (data.settings) {
    currentSettings = data.settings;
  }

  renderParticipants(
    data.participants || []
  );

  applyMeetingTiming(data);
  updateControls();
});

socket.on(
  "participant-media-updated",
  data => {
    const person = participants.find(
      item => item.id === data.id
    );

    if (!person) return;

    person.micEnabled =
      data.micEnabled;

    person.videoEnabled =
      data.videoEnabled;

    renderParticipants(participants);
  }
);

socket.on("peer-ready", ({ id } = {}) => {
  if (currentRoom && id) {
    callPeer(id).catch(console.error);
  }
});

socket.on(
  "signal",
  ({ from, signal } = {}) => {
    handleSignal(
      from,
      signal
    ).catch(error => {
      console.error(
        "Signal:",
        error
      );
    });
  }
);

socket.on("waiting-updated", list => {
  waitingRoomUsers =
    Array.isArray(list)
      ? list
      : [];

  syncRequestQueue(
    "join",
    waitingRoomUsers
  );

  renderWaitingRequests();
});

socket.on(
  "screen-share-requests-updated",
  list => {
    screenRequests =
      Array.isArray(list)
        ? list
        : [];

    syncRequestQueue(
      "share",
      screenRequests
    );

    renderWaitingRequests();
  }
);

socket.on(
  "screen-share-approved",
  () => {
    shareGrantUntil =
      Date.now() + 55000;

    updateControls();

    notify(
      "Approved! Click Share screen within 60 seconds.",
      "success"
    );
  }
);

socket.on(
  "screen-share-rejected",
  data => {
    notify(
      data?.message ||
        "Screen share request declined",
      "error"
    );
  }
);

socket.on(
  "screen-share-updated",
  data => {
    activeScreenSharer =
      !data?.sharing
        ? null
        : data.id === socket.id
          ? "local"
          : data.id;

    refreshRemoteSharing();
  }
);

socket.on("hands-updated", data => {
  raisedHands = new Set(
    Array.isArray(data?.ids)
      ? data.ids
      : []
  );

  myHandRaised =
    raisedHands.has(socket.id);

  updateRaisedHandsUI();
  updateControls();
});

socket.on(
  "chat-message",
  displayChatMessage
);

/* ==========================================
   HOST MEDIA CONTROLS
========================================== */

socket.on("force-mute", () => {
  const track =
    localStream?.getAudioTracks()[0];

  if (track) {
    track.enabled = false;

    emitMediaState();
    updateControls();
  }

  notify(
    "Host muted your microphone"
  );
});

socket.on("force-video-off", () => {
  const track =
    localStream?.getVideoTracks()[0];

  if (track) {
    track.enabled = false;

    emitMediaState();
    updateControls();
    updateVideoPlaceholders();
  }

  notify(
    "Host stopped your video"
  );
});

socket.on(
  "request-unmute",
  () => askConsent("mic")
);

socket.on(
  "request-video-on",
  () => askConsent("camera")
);

/* ==========================================
   SERVER SETTINGS / TIME BROADCAST
========================================== */

socket.on(
  "meeting-settings-updated",
  data => {
    applyMeetingTiming(data);

    if (data?.settings) {
      currentSettings = data.settings;
    }

    if (
      currentRole !== "host" &&
      localStream
    ) {
      if (!currentSettings.mic) {
        localStream
          .getAudioTracks()
          .forEach(track => {
            track.enabled = false;
          });
      }

      if (!currentSettings.camera) {
        localStream
          .getVideoTracks()
          .forEach(track => {
            track.enabled = false;
          });
      }

      emitMediaState();
    }

    updateControls();
    updateVideoPlaceholders();
  }
);

socket.on(
  "meeting-time-adjusted",
  data => {
    applyMeetingTiming(data);

    if (currentRole !== "host") {
      notify(
        "Host changed the meeting time",
        "success"
      );
    }
  }
);

socket.on(
  "meeting-extended",
  data => {
    applyMeetingTiming(data);
  }
);

socket.on("disconnect", () => {
  if (
    currentRoom &&
    !isLeaving
  ) {
    resetMeeting();

    notify(
      "Disconnected from meeting server",
      "error"
    );
  }
});

/* ==========================================
   BUTTON EVENT BINDING
========================================== */

function bind(id, eventName, callback) {
  $(id)?.addEventListener(
    eventName,
    callback
  );
}

function initializeControls() {
  // Website Navigation
  // No separate "Meeting" menu in header.

  document.querySelectorAll(
    "[data-page]"
  ).forEach(button => {
    button.addEventListener(
      "click",
      event => {
        event.preventDefault();

        navigate(
          button.dataset.page
        );
      }
    );
  });

  /* GOOGLE + GUEST LOGIN */

  bind(
    "googleLoginBtn",
    "click",
    loginGoogle
  );

  bind(
    "guestLoginBtn",
    "click",
    () => {
      $("guestNameSection").hidden = false;
      $("guestName").focus();
    }
  );

  bind(
    "guestContinueBtn",
    "click",
    loginGuest
  );

  bind(
    "guestName",
    "keydown",
    event => {
      if (event.key === "Enter") {
        loginGuest();
      }
    }
  );

  /* CREATE AND JOIN */

  bind(
    "createBtn",
    "click",
    createMeeting
  );

  bind(
    "joinBtn",
    "click",
    joinMeeting
  );

  /* LEAVE MEETING */

  bind(
    "cancelWaitingBtn",
    "click",
    leaveMeeting
  );

  bind(
    "leaveBtn",
    "click",
    leaveMeeting
  );

  bind(
    "roomMobileLeaveBtn",
    "click",
    leaveMeeting
  );

  bind(
    "moreLeaveBtn",
    "click",
    leaveMeeting
  );

  /* INVITE LINK */

  bind(
    "copyBtn",
    "click",
    copyInvite
  );

  bind(
    "moreInviteBtn",
    "click",
    () => {
      closeMoreMenu();
      copyInvite();
    }
  );

  /* MICROPHONE */

  bind(
    "micBtn",
    "click",
    () => {
      const track =
        localStream?.getAudioTracks()[0];

      if (!track) return;

      if (
        currentRole !== "host" &&
        !currentSettings.mic
      ) {
        return notify(
          "Host disabled microphone",
          "error"
        );
      }

      track.enabled = !track.enabled;

      emitMediaState();
      updateControls();
    }
  );

  /* CAMERA */

  bind(
    "cameraBtn",
    "click",
    () => {
      const track =
        localStream?.getVideoTracks()[0];

      if (!track) return;

      if (
        currentRole !== "host" &&
        !currentSettings.camera
      ) {
        return notify(
          "Host disabled camera",
          "error"
        );
      }

      track.enabled = !track.enabled;

      emitMediaState();
      updateControls();
      updateVideoPlaceholders();
    }
  );

  /* SCREEN SHARE */

  bind(
    "screenBtn",
    "click",
    toggleScreen
  );

  /* RAISE HAND */

  async function toggleHand() {
    if (!currentRoom) return;

    try {
      const reply = await request(
        "raise-hand",
        {
          raised: !myHandRaised
        }
      );

      if (!reply.ok) {
        throw new Error(reply.error);
      }

      myHandRaised = !myHandRaised;

      updateControls();
    } catch (error) {
      notify(error.message, "error");
    }
  }

  bind(
    "raiseHandBtn",
    "click",
    toggleHand
  );

  bind(
    "moreHandBtn",
    "click",
    () => {
      closeMoreMenu();
      toggleHand();
    }
  );

  /* PEOPLE, CHAT AND REQUESTS */

  bind(
    "toggleParticipantsBtn",
    "click",
    () => openSidebar("people")
  );

  bind(
    "toggleChatBtn",
    "click",
    () => {
      $("toggleChatBtn").classList.remove(
        "has-unread"
      );

      openSidebar("chat");
    }
  );

  bind(
    "toggleRequestsBtn",
    "click",
    () => openSidebar("requests")
  );

  bind(
    "roomRequestsBtn",
    "click",
    () => openSidebar("requests")
  );

  bind(
    "showParticipantsTab",
    "click",
    () => {
      sidebarTab = null;
      openSidebar("people");
    }
  );

  bind(
    "showChatTab",
    "click",
    () => {
      sidebarTab = null;
      openSidebar("chat");
    }
  );

  bind(
    "showRequestsTab",
    "click",
    () => {
      sidebarTab = null;
      openSidebar("requests");
    }
  );

  bind(
    "closeSidebarBtn",
    "click",
    closeSidebar
  );

  /* MORE MENU */

  bind(
    "moreBtn",
    "click",
    toggleMoreMenu
  );

  bind(
    "morePeopleBtn",
    "click",
    () => openSidebar("people")
  );

  bind(
    "moreRequestsBtn",
    "click",
    () => openSidebar("requests")
  );

  bind(
    "participantsToggle",
    "click",
    () => {
      const body = $("participantsBody");

      body.hidden = !body.hidden;

      $("participantsToggle").textContent =
        body.hidden ? "⌄" : "⌃";

      $("participantsToggle").setAttribute(
        "aria-expanded",
        String(!body.hidden)
      );
    }
  );

  /* CHAT IMAGE */

  bind(
    "attachImageBtn",
    "click",
    () => $("chatImageInput").click()
  );

  bind(
    "chatImageInput",
    "change",
    () => {
      const file =
        $("chatImageInput").files[0];

      if (!file) return;

      const allowed = [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif"
      ];

      if (
        !allowed.includes(file.type) ||
        file.size > 2 * 1024 * 1024
      ) {
        clearSelectedImage();

        notify(
          "Use JPG, PNG, WEBP or GIF under 2 MB",
          "error"
        );

        return;
      }

      selectedImage = file;

      if (imagePreviewUrl) {
        URL.revokeObjectURL(
          imagePreviewUrl
        );
      }

      imagePreviewUrl =
        URL.createObjectURL(file);

      $("chatImageThumbnail").src =
        imagePreviewUrl;

      $("chatImageFilename").textContent =
        file.name;

      $("chatImagePreview").hidden =
        false;
    }
  );

  bind(
    "removeChatImageBtn",
    "click",
    clearSelectedImage
  );

  bind(
    "chatForm",
    "submit",
    sendChat
  );

  /* REQUEST POPUP */

  bind(
    "requestApproveBtn",
    "click",
    () => replyToRequest(true)
  );

  bind(
    "requestRejectBtn",
    "click",
    () => replyToRequest(false)
  );

  bind(
    "requestLaterBtn",
    "click",
    () => {
      pausedRequestKey =
        activeRequest?.key || null;

      $("requestPopup").hidden = true;

      if (currentRole === "host") {
        openSidebar("requests");
      }
    }
  );

  /* CREATE SETTINGS */

  bind(
    "openCreateSettingsBtn",
    "click",
    () => {
      createSettingsTab(true);
      updateCreateSummary();

      toggleModal(
        "createSettingsModal",
        true
      );
    }
  );

  bind(
    "closeCreateSettingsBtn",
    "click",
    () => toggleModal(
      "createSettingsModal",
      false
    )
  );

  bind(
    "createGeneralTab",
    "click",
    () => createSettingsTab(true)
  );

  bind(
    "createPermissionsTab",
    "click",
    () => createSettingsTab(false)
  );

  bind(
    "meetingDuration",
    "change",
    updateCreateSummary
  );

  bind(
    "meetingCustomDuration",
    "input",
    updateCreateSummary
  );

  bind(
    "meetingType",
    "change",
    updateCreateSummary
  );

  bind(
    "setting-approval",
    "change",
    updateCreateSummary
  );

  bind(
    "saveCreateSettingsBtn",
    "click",
    () => {
      try {
        createMeetingPayload(
          "demo-password"
        );

        updateCreateSummary();

        toggleModal(
          "createSettingsModal",
          false
        );

        notify(
          "Meeting settings saved",
          "success"
        );
      } catch (error) {
        createSettingsTab(true);
        notify(error.message, "error");
      }
    }
  );

  /* HOST SETTINGS */

  bind(
    "roomSettingsBtn",
    "click",
    () => {
      populateHostSettings();

      toggleModal(
        "roomSettingsModal",
        true
      );
    }
  );

  bind(
    "moreSettingsBtn",
    "click",
    () => {
      closeMoreMenu();
      $("roomSettingsBtn").click();
    }
  );

  bind(
    "closeRoomSettingsBtn",
    "click",
    () => toggleModal(
      "roomSettingsModal",
      false
    )
  );

  bind(
    "saveRoomSettingsBtn",
    "click",
    saveHostSettings
  );

  /* ADJUST MEETING TIME */

  bind(
    "extendMeetingBtn",
    "click",
    openTimeModal
  );

  bind(
    "moreAdjustTimeBtn",
    "click",
    () => {
      closeMoreMenu();
      openTimeModal();
    }
  );

  bind(
    "closeExtendMeetingBtn",
    "click",
    () => toggleModal(
      "extendMeetingModal",
      false
    )
  );

  bind(
    "cancelTimeAdjustBtn",
    "click",
    () => toggleModal(
      "extendMeetingModal",
      false
    )
  );

  document.querySelectorAll(
    "[data-time-mode]"
  ).forEach(button => {
    button.addEventListener(
      "click",
      () => {
        adjustmentMode =
          button.dataset.timeMode;

        updateTimePreview();
      }
    );
  });

  document.querySelectorAll(
    "[data-time-preset]"
  ).forEach(button => {
    button.addEventListener(
      "click",
      () => {
        adjustmentPreset =
          button.dataset.timePreset;

        updateTimePreview();

        if (
          adjustmentPreset === "custom"
        ) {
          $("customExtensionMinutes").focus();
        }
      }
    );
  });

  bind(
    "customExtensionMinutes",
    "input",
    updateTimePreview
  );

  bind(
    "confirmExtendMeetingBtn",
    "click",
    applyTimeAdjustment
  );

  /* MODAL BACKDROP */

  for (const id of [
    "createSettingsModal",
    "roomSettingsModal",
    "extendMeetingModal"
  ]) {
    bind(
      id,
      "click",
      event => {
        if (event.target === $(id)) {
          toggleModal(id, false);
        }
      }
    );
  }

  document.addEventListener(
    "keydown",
    event => {
      if (event.key === "Escape") {
        closeAllModals();
        closeMoreMenu();
      }
    }
  );

  /* LIGHT / DARK THEME */

  bind(
    "themeToggle",
    "click",
    () => {
      const light =
        document.body.classList.toggle(
          "light-mode"
        );

      $("themeToggle").textContent =
        light ? "☾ Dark" : "☀ Light";

      try {
        localStorage.setItem(
          "meetspace-theme",
          light ? "light" : "dark"
        );
      } catch {}
    }
  );

  try {
    if (
      localStorage.getItem(
        "meetspace-theme"
      ) === "light"
    ) {
      document.body.classList.add(
        "light-mode"
      );

      $("themeToggle").textContent =
        "☾ Dark";
    }
  } catch {}

  /* INVITE URL HANDLING */

  const invite =
    new URLSearchParams(
      location.search
    ).get("room");

  if (
    invite &&
    /^[a-f0-9]{10}$/i.test(invite)
  ) {
    $("roomInput").value = invite;

    navigate(
      "join",
      true
    );
  } else {
    navigate(
      "home",
      true
    );
  }

  /* FINAL INITIALIZATION */

  updateCreateSummary();
  updateControls();
  syncHostActions();

  restoreSession();

  setInterval(
    renderMeetingClock,
    1000
  );

  status(
    "Welcome to MeetSpace"
  );
}

/* ==========================================
   START MEETSPACE
========================================== */

initializeControls();

/* ==========================================
   END OF COMPLETE MEETSPACE SCRIPT.JS
   PART 1 + PART 2 + PART 3
========================================== */
