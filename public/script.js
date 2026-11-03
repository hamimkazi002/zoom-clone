
/* ==========================================================
   MEETSPACE — STABLE VIDEO + VOICE REPAIR
   public/script.js — PART 1 OF 3
   Keep this part, followed by Part 2 and Part 3 in ONE file.
   Existing HTML/CSS IDs are preserved.
========================================================== */
"use strict";

const $ = id => document.getElementById(id);
const socket = io({ autoConnect: false, reconnection: false });
const MAX_PEOPLE = 10;
const SETTINGS_KEYS = ["mic", "camera", "share", "chat", "hand", "approval", "autoEnd"];
const DEFAULT_SETTINGS = { mic: true, camera: true, share: false, chat: true, hand: true, approval: true, autoEnd: true };
const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};
const ICONS = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 2l20 20M9 9v2a3 3 0 0 0 5 2M15 9V5a3 3 0 0 0-6 0M5 10a7 7 0 0 0 12 5M12 17v5M8 22h8"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="15" height="14" rx="2"/><path d="m17 10 5-3v10l-5-3"/></svg>',
  videoOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 2l20 20M10 5h5a2 2 0 0 1 2 2v3M17 14v3a2 2 0 0 0-2 2H4a2 2 0 0 1-2-2V7m15 3 5-3v10l-5-3"/></svg>',
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
let meetingStartsAt = null;
let meetingEndsAt = null;
let sidebarTab = null;
let selectedMainVideo = "local";
let activeScreenSharer = null;
let myHandRaised = false;
let raisedHands = new Set();
let shareGrantUntil = 0;
let currentPage = "home";
let pendingPage = "home";
let isLeaving = false;
let selectedImage = null;
let imagePreviewUrl = null;
let waitingRoomUsers = [];
let screenRequests = [];
let adjustmentMode = "add";
let adjustmentPreset = "15";
const pendingRequests = new Map();
let activeRequest = null;
let pausedRequestKey = null;

// One peer entry per remote Socket.IO ID.
const peers = new Map();
// Signals arriving while getUserMedia permission popup is open.
const earlySignals = new Map();
const readyPeers = new Set();
// A remote audio element has its own MediaStream; video tiles are muted.
const audioElements = new Map();
let audioEnableButton = null;

function status(message) {
  if ($("status")) $("status").textContent = message;
}
function notify(message, type = "info") {
  let root = $("meetspaceToastContainer");
  if (!root) {
    root = document.createElement("div");
    root.id = "meetspaceToastContainer";
    root.style.cssText = "position:fixed;right:14px;top:15px;z-index:99999;display:grid;gap:8px;width:min(350px,calc(100vw - 28px));pointer-events:none";
    document.body.appendChild(root);
  }
  const el = document.createElement("div");
  el.setAttribute("role", "status");
  el.style.cssText = "padding:12px 15px;background:#252b42;color:#fff;border-radius:11px;box-shadow:0 10px 30px #0006;border:1px solid " +
    (type === "error" ? "#e27d94" : type === "success" ? "#53d5ae" : "#9d91fb") + ";font:600 12px system-ui";
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}
function visible(id, yes) { if ($(id)) $(id).hidden = !yes; }
function hasAuth() { return Boolean(currentUser?.uid); }
function showSection(id) {
  for (const name of ["loginSection", "homeSection", "waitingSection", "meetingSection"]) visible(name, name === id);
  visible("home", id !== "waitingSection" && id !== "meetingSection");
  if (id === "meetingSection") document.body.dataset.view = "meeting";
  else if (id === "waitingSection") document.body.dataset.view = "waiting";
}
function navigate(page, retainUrl = false) {
  if (currentRoom && ["home", "join", "create"].includes(page)) {
    notify("Leave your current meeting first", "error");
    return;
  }
  currentPage = page;
  const formPage = page === "join" || page === "create";
  const needLogin = formPage && !hasAuth();
  pendingPage = needLogin ? page : "home";
  showSection(needLogin ? "loginSection" : "homeSection");
  visible("loginSection", needLogin);
  visible("homeSection", formPage && !needLogin);
  visible("landingSection", page === "home");
  visible("homeBenefits", page === "home");
  visible("createPage", page === "create" && !needLogin);
  visible("joinPage", page === "join" && !needLogin);
  visible("features", page === "features");
  visible("support", page === "support");
  document.body.dataset.view = page;
  for (const button of document.querySelectorAll("[data-page]")) {
    const on = button.dataset.page === page;
    button.classList.toggle("active", on);
    button.classList.toggle("is-active", on);
    if (button.closest(".mobile-bottom-nav")) {
      if (on) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  }
  if (!retainUrl) {
    const url = page === "join" && new URLSearchParams(location.search).has("room")
      ? location.pathname + location.search : location.pathname;
    history.replaceState({}, "", url);
  }
  window.scrollTo(0, 0);
}
function meetingLink(roomId) {
  return location.origin + "/?room=" + encodeURIComponent(roomId);
}
function request(eventName, data = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!socket.connected) return reject(new Error("Meeting server is disconnected"));
    socket.timeout(timeoutMs).emit(eventName, data, (error, result) => {
      if (error) return reject(new Error("Server did not respond to " + eventName));
      if (!result || typeof result.ok !== "boolean") return reject(new Error("Invalid server response: " + eventName));
      resolve(result);
    });
  });
}
async function waitForFirebase() {
  for (let n = 0; n < 100; n++) {
    if (window.meetspaceAuth) {
      await window.meetspaceAuth.authReady;
      return window.meetspaceAuth;
    }
    await new Promise(ok => setTimeout(ok, 100));
  }
  throw new Error("Firebase login could not load");
}
function savedGuestName(uid) {
  try { return localStorage.getItem("meetspace-guest-name-" + uid); }
  catch { return null; }
}
function setUser(user, displayName) {
  if (!user?.uid) return;
  currentUser = {
    uid: user.uid,
    name: displayName || user.displayName || user.email || "Guest",
    email: user.email || null,
    guest: Boolean(user.isAnonymous)
  };
  $("userInfo").textContent = currentUser.name;
  navigate(pendingPage === "home" ? currentPage : pendingPage, true);
  status("Signed in as " + currentUser.name);
}
async function loginGoogle() {
  $("googleLoginBtn").disabled = true;
  try {
    const fb = await waitForFirebase();
    setUser(await fb.loginWithGoogle());
  } catch (err) { notify(err.message, "error"); }
  finally { $("googleLoginBtn").disabled = false; }
}
async function loginGuest() {
  const name = $("guestName").value.trim();
  if (!name) return notify("Enter your guest name", "error");
  $("guestContinueBtn").disabled = true;
  try {
    const fb = await waitForFirebase();
    const user = await fb.loginAsGuest();
    try { localStorage.setItem("meetspace-guest-name-" + user.uid, name); } catch {}
    setUser(user, name);
  } catch (err) { notify(err.message, "error"); }
  finally { $("guestContinueBtn").disabled = false; }
}
async function restoreSession() {
  try {
    const fb = await waitForFirebase();
    fb.onAuthStateChanged(fb.auth, user => {
      if (!user || currentUser) return;
      if (!user.isAnonymous) return setUser(user);
      const name = savedGuestName(user.uid);
      if (name) setUser(user, name);
      else if (currentPage === "join" || currentPage === "create") {
        visible("guestNameSection", true);
        visible("loginSection", true);
      }
    });
  } catch (err) { console.error(err); status(err.message); }
}
async function loadIceServers() {
  try {
    const fb = await waitForFirebase();
    const token = await fb.getUserToken();
    const response = await fetch("/api/ice-servers", {
      headers: { Authorization: "Bearer " + token }, cache: "no-store"
    });
    if (!response.ok) throw new Error("TURN config HTTP " + response.status);
    const data = await response.json();
    if (!Array.isArray(data.iceServers) || !data.iceServers.length) throw new Error("No ICE servers");
    rtcConfig.iceServers = data.iceServers;
    console.info("MeetSpace ICE source:", data.source);
    if (data.source === "stun" || data.source === "stun-fallback") {
      console.warn("TURN not active. Different networks may fail to connect.");
    }
  } catch (err) {
    console.warn("TURN config failed; falling back to STUN", err);
  }
}
async function connectSocket() {
  if (socket.connected) return;
  if (!hasAuth()) throw new Error("Please sign in first");
  const fb = await waitForFirebase();
  socket.auth = { credential: await fb.getUserToken(), name: currentUser.name };
  await loadIceServers();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Server connection timed out")); }, 15000);
    function cleanup() { clearTimeout(timer); socket.off("connect", ok); socket.off("connect_error", bad); }
    function ok() { cleanup(); resolve(); }
    function bad(err) { cleanup(); reject(err); }
    socket.once("connect", ok);
    socket.once("connect_error", bad);
    socket.connect();
  });
}
function applyMeetingTiming(data) {
  const starts = Number(data?.startsAt);
  const ends = Number(data?.endsAt);
  if (Number.isFinite(starts) && starts > 0) meetingStartsAt = starts;
  if (Number.isFinite(ends) && ends > 0) meetingEndsAt = ends;
  renderMeetingClock();
}
function enterMeeting(roomId, role) {
  currentRoom = roomId;
  currentRole = role === "host" ? "host" : "participant";
  $("roomText").textContent = roomId;
  $("roleText").textContent = currentRole === "host" ? "Host" : "Participant";
  showSection("meetingSection");
  visible("features", false);
  visible("support", false);
  closeSidebar();
  closeMoreMenu();
  syncHostActions();
  renderMeetingClock();
  updateControls();
  history.replaceState({}, "", meetingLink(roomId));
  window.scrollTo(0, 0);
}
function readCreateSettings() {
  const result = {};
  for (const key of SETTINGS_KEYS) result[key] = Boolean($("setting-" + key)?.checked);
  return result;
}
function createMeetingPayload(password) {
  const selected = $("meetingDuration");
  const custom = selected.selectedOptions[0]?.dataset.custom === "true";
  const raw = custom ? $("meetingCustomDuration").value : selected.value;
  const minutes = Number(raw);
  if (!raw || !Number.isInteger(minutes) || minutes < 5 || minutes > 1440) {
    throw new Error("Meeting duration: 5–1440 whole minutes");
  }
  const data = { password, durationMinutes: minutes, settings: readCreateSettings() };
  if ($("meetingType").value === "scheduled") {
    const date = $("meetingDate").value;
    const time = $("meetingTime").value;
    if (!date || !time) throw new Error("Select a meeting date and start time");
    const startsAt = new Date(date + "T" + time).getTime();
    if (!Number.isFinite(startsAt) || startsAt <= Date.now()) throw new Error("Choose a future start time");
    data.startsAt = startsAt;
  }
  return data;
}
async function createMeeting() {
  const password = $("createPassword").value;
  if (password.length < 4 || password.length > 64) return notify("Password must be 4–64 characters", "error");
  const btn = $("createBtn"); btn.disabled = true;
  try {
    const payload = createMeetingPayload(password);
    await connectSocket();
    const response = await request("create-room", payload);
    if (!response.ok) throw new Error(response.error);
    currentSettings = response.settings || payload.settings;
    applyMeetingTiming(response);
    enterMeeting(response.roomId, "host");
    renderParticipants(response.participants || []);
    await startMedia();
    notify("Room created. Share invite link and password separately", "success");
  } catch (err) { console.error(err); notify(err.message, "error"); }
  finally { btn.disabled = false; }
}
async function joinMeeting() {
  const roomId = $("roomInput").value.trim();
  const password = $("joinPassword").value;
  if (!roomId || !password) return notify("Enter Meeting ID and password", "error");
  const btn = $("joinBtn"); btn.disabled = true;
  try {
    await connectSocket();
    const reply = await request("request-join", { roomId, password });
    if (!reply.ok) throw new Error(reply.error);
    currentRoom = roomId;
    if (reply.status === "waiting") {
      showSection("waitingSection");
      status("Waiting for host approval");
      notify("Join request sent", "success");
    }
    // For direct join the server sends a separate join-approved event.
  } catch (err) { console.error(err); notify(err.message, "error"); }
  finally { btn.disabled = false; }
}
/* ==========================================================
   public/script.js — PART 2 OF 3
   Stable camera / audio / screen WebRTC and meeting UI
========================================================== */
function videoBox(id, name, stream, screen = false) {
  const key = (screen ? "share-" : "video-") + id;
  let box = $(key);
  if (!box) {
    box = document.createElement("div");
    box.id = key;
    box.className = "video-box";
    box.dataset.personId = id;
    box.dataset.isScreen = screen ? "yes" : "no";
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    // Audio is intentionally NOT played through video tiles.
    // A separate <audio> element prevents muted camera/audio mixups.
    video.muted = true;
    const avatar = document.createElement("div");
    avatar.className = "ms-video-avatar";
    avatar.setAttribute("aria-hidden", "true");
    const caption = document.createElement("span");
    caption.className = "video-label";
    box.append(video, avatar, caption);
    (screen ? $("mainVideoStage") : $("videoGrid")).appendChild(box);
    if (!screen) box.addEventListener("click", () => {
      if (!activeScreenSharer) { selectedMainVideo = id; renderVideoLayout(); }
    });
  }
  box.dataset.name = name;
  box.querySelector(".video-label").textContent = name;
  const video = box.querySelector("video");
  if (stream && video.srcObject !== stream) video.srcObject = stream;
  video.play().catch(() => {});
  return box;
}
function createVideo(id, name, stream) {
  videoBox(id, name, stream, false);
  renderVideoLayout();
}
function createScreenVideo(id, stream) {
  const person = participants.find(p => p.id === id);
  const name = id === "local" ? currentUser?.name || "You" : person?.name || "Participant";
  videoBox(id, name + " (Screen)", stream, true);
}
function updateVideoPlaceholders() {
  for (const box of document.querySelectorAll(".video-box")) {
    const id = box.dataset.personId;
    const screen = box.dataset.isScreen === "yes";
    const person = participants.find(p => p.id === id);
    const enabled = id === "local"
      ? Boolean(localStream?.getVideoTracks()[0]?.enabled)
      : person?.videoEnabled !== false;
    const video = box.querySelector("video");
    const hasVideo = Boolean(video?.srcObject?.getVideoTracks().length);
    box.classList.toggle("is-camera-off", !screen && (!enabled || !hasVideo));
    const avatar = box.querySelector(".ms-video-avatar");
    if (avatar) avatar.textContent = (box.dataset.name || "?").replace(/\s*\(.*?\)/g, "").trim().charAt(0).toUpperCase() || "?";
  }
}
function renderVideoLayout() {
  const stage = $("videoStage");
  const main = $("mainVideoStage");
  const grid = $("videoGrid");
  if (!stage || !main || !grid) return;
  const sharingBox = activeScreenSharer ? $("share-" + activeScreenSharer) : null;
  const sharing = Boolean(sharingBox);
  stage.classList.toggle("ms-sharing-view", sharing);
  stage.classList.toggle("ms-gallery-view", !sharing);
  main.hidden = !sharing;
  grid.classList.toggle("ms-filmstrip", sharing);
  grid.classList.toggle("ms-gallery", !sharing);
  grid.classList.remove("ms-odd");
  if (sharingBox) main.appendChild(sharingBox);
  for (const box of [...main.querySelectorAll('.video-box[data-is-screen="yes"]')]) {
    if (box !== sharingBox) box.remove();
  }
  const boxes = [...grid.querySelectorAll('.video-box[data-is-screen="no"]')];
  for (const box of boxes) { box.classList.remove("ms-focused"); grid.appendChild(box); }
  if (sharing) {
    grid.style.removeProperty("--ms-gallery-columns");
    grid.style.removeProperty("--ms-gallery-rows");
  } else if (boxes.length) {
    const count = boxes.length;
    const odd = count > 1 && count % 2 === 1;
    const columns = odd ? 3 : count <= 2 ? count : count <= 4 ? 2 : count <= 6 ? 3 : count <= 8 ? 4 : 5;
    const rows = odd ? Math.ceil((count + 3) / 3) : Math.ceil(count / columns);
    grid.classList.toggle("ms-odd", odd);
    grid.style.setProperty("--ms-gallery-columns", String(columns));
    grid.style.setProperty("--ms-gallery-rows", String(Math.max(1, rows)));
    if (odd) {
      const focus = boxes.find(b => b.dataset.personId === selectedMainVideo) || boxes[0];
      grid.prepend(focus);
      focus.classList.add("ms-focused");
    }
  }
  $("galleryHeading").textContent = sharing ? "Screen sharing" : "Gallery view";
  $("galleryHint").textContent = sharing
    ? "Shared content is large. Camera thumbnails are below."
    : "Click a video to focus it when the participant count is odd.";
  $("galleryParticipantBadge").textContent = participants.length + "/" + MAX_PEOPLE + " people";
  updateVideoPlaceholders();
  updateRaisedHandsUI();
}
function showScreenBanner(name) {
  visible("screenShareBanner", Boolean(name));
  if (name) $("screenShareName").textContent = name + " is sharing their screen";
}
function refreshRemoteSharing() {
  if (!activeScreenSharer) {
    $("mainVideoStage").replaceChildren();
    showScreenBanner(null);
    renderVideoLayout();
    return;
  }
  const id = activeScreenSharer;
  const stream = id === "local" ? screenStream : peers.get(id)?.screenStream;
  if (stream) createScreenVideo(id, stream);
  const name = id === "local" ? currentUser?.name : participants.find(p => p.id === id)?.name;
  showScreenBanner(name || "Participant");
  renderVideoLayout();
}

/* ===== Separate remote audio + unblock button ===== */
function promptEnableAudio() {
  if (!currentRoom || audioEnableButton) return;
  const button = document.createElement("button");
  audioEnableButton = button;
  button.type = "button";
  button.id = "enableMeetingAudioBtn";
  button.textContent = "🔊 Tap to enable meeting sound";
  button.style.cssText = "position:fixed;z-index:180;left:50%;bottom:95px;transform:translateX(-50%);max-width:calc(100vw - 28px);padding:13px 19px;border:1px solid #c4baff;border-radius:12px;background:#7468eb;color:white;font:800 13px system-ui;box-shadow:0 12px 32px #0007";
  button.addEventListener("click", async () => {
    const results = await Promise.allSettled([...audioElements.values()].map(el => el.play()));
    const blocked = results.some(result => result.status === "rejected");
    if (!blocked) { button.remove(); audioEnableButton = null; notify("Meeting sound enabled", "success"); }
    else notify("Allow sound in your browser and tap again", "error");
  });
  document.body.appendChild(button);
}
function playRemoteAudio(id) {
  const audio = audioElements.get(id);
  if (!audio || !audio.srcObject?.getAudioTracks().length) return;
  audio.play().then(() => {
    // Playback was allowed; no prompt necessary.
    if (audioEnableButton) {
      const all = [...audioElements.values()];
      if (all.every(el => !el.paused)) {
        audioEnableButton.remove();
        audioEnableButton = null;
      }
    }
  }).catch(error => {
    if (error.name === "NotAllowedError") promptEnableAudio();
    else console.warn("Remote audio playback:", error);
  });
}
function attachRemoteAudio(id, stream) {
  let audio = audioElements.get(id);
  if (!audio) {
    audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    audio.muted = false;
    audio.style.display = "none";
    audio.dataset.peerId = id;
    document.body.appendChild(audio);
    audioElements.set(id, audio);
  }
  if (audio.srcObject !== stream) audio.srcObject = stream;
  playRemoteAudio(id);
}
function removeRemoteAudio(id) {
  const audio = audioElements.get(id);
  if (!audio) return;
  audio.pause();
  audio.srcObject = null;
  audio.remove();
  audioElements.delete(id);
}

function addRemoteTrack(stream, track) {
  for (const old of stream.getTracks()) {
    if (old.kind === track.kind && old.id !== track.id) stream.removeTrack(old);
  }
  if (!stream.getTracks().some(existing => existing.id === track.id)) stream.addTrack(track);
}
function createPeer(id) {
  if (peers.has(id)) return peers.get(id);
  const pc = new RTCPeerConnection(rtcConfig);
  const record = {
    id, pc, cameraStream: new MediaStream(), audioStream: new MediaStream(), screenStream: new MediaStream(),
    offered: false, isOfferer: false, makingOffer: false, restartCount: 0,
    lastRestart: 0, pendingIce: [], serial: Promise.resolve(),
    audioTx: null, cameraTx: null, screenTx: null,
    ready: Promise.resolve()
  };
  peers.set(id, record);
  pc.ontrack = event => {
    // MID 0 = audio, MID 1 = camera, MID 2 = screen.
    // On the answering side, the transceivers exist only AFTER
    // setRemoteDescription, so do not rely on locally precreated indexes.
    const mid = String(event.transceiver?.mid ?? '');
    if (event.track.kind === 'audio') {
      addRemoteTrack(record.audioStream, event.track);
      attachRemoteAudio(id, record.audioStream);
      event.track.onunmute = () => playRemoteAudio(id);
    } else if (mid === '2') {
      addRemoteTrack(record.screenStream, event.track);
      event.track.onunmute = () => {
        if (activeScreenSharer === id) refreshRemoteSharing();
      };
      if (activeScreenSharer === id) refreshRemoteSharing();
    } else {
      addRemoteTrack(record.cameraStream, event.track);
      const name = participants.find(p => p.id === id)?.name || 'Participant';
      createVideo(id, name, record.cameraStream);
      event.track.onunmute = () => {
        const el = $('video-' + id)?.querySelector('video');
        el?.play().catch(() => {});
        updateVideoPlaceholders();
      };
    }
  };
  pc.onicecandidate = event => {
    if (!event.candidate || !socket.connected) return;
    socket.emit('signal', {
      to: id, signal: { type: 'candidate', candidate: event.candidate }
    });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      record.restartCount = 0;
      console.info('MeetSpace peer connected:', id);
      playRemoteAudio(id);
    }
    if (pc.connectionState === 'failed') recoverPeer(id);
    if (pc.connectionState === 'disconnected') {
      setTimeout(() => {
        if (peers.get(id) === record && pc.connectionState === 'disconnected') recoverPeer(id);
      }, 7000);
    }
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') recoverPeer(id);
  };
  const person = participants.find(p => p.id === id);
  createVideo(id, person?.name || 'Participant', record.cameraStream);
  return record;
}

function prepareLocalOffer(record) {
  if (record.audioTx && record.cameraTx && record.screenTx) return record.ready;
  const pc = record.pc;
  record.audioTx = pc.addTransceiver('audio', { direction: 'sendrecv' });
  record.cameraTx = pc.addTransceiver('video', { direction: 'sendrecv' });
  record.screenTx = pc.addTransceiver('video', { direction: 'sendrecv' });
  record.ready = Promise.all([
    record.audioTx.sender.replaceTrack(localStream?.getAudioTracks()[0] || null),
    record.cameraTx.sender.replaceTrack(localStream?.getVideoTracks()[0] || null),
    record.screenTx.sender.replaceTrack(screenStream?.getVideoTracks()[0] || null)
  ]);
  return record.ready;
}

async function prepareLocalAnswer(record) {
  // setRemoteDescription(offer) creates and associates transceivers
  // with offered MIDs. Reuse them; do NOT add another three.
  const tx = record.pc.getTransceivers();
  record.audioTx = tx.find(t => t.mid === '0' && t.receiver.track.kind === 'audio');
  record.cameraTx = tx.find(t => t.mid === '1' && t.receiver.track.kind === 'video');
  record.screenTx = tx.find(t => t.mid === '2' && t.receiver.track.kind === 'video');
  if (!record.audioTx || !record.cameraTx || !record.screenTx) {
    throw new Error('WebRTC media layout mismatch; expected 3 media sections');
  }
  // Crucial: not recvonly. Both users must SEND and RECEIVE media.
  for (const transceiver of [record.audioTx, record.cameraTx, record.screenTx]) {
    transceiver.direction = 'sendrecv';
  }
  record.ready = Promise.all([
    record.audioTx.sender.replaceTrack(localStream?.getAudioTracks()[0] || null),
    record.cameraTx.sender.replaceTrack(localStream?.getVideoTracks()[0] || null),
    record.screenTx.sender.replaceTrack(screenStream?.getVideoTracks()[0] || null)
  ]);
  return record.ready;
}

function peerJob(record, job) {
  record.serial = record.serial.catch(() => {}).then(job);
  return record.serial;
}
async function flushPeerCandidates(record) {
  if (!record.pc.remoteDescription) return;
  const candidates = record.pendingIce.splice(0);
  for (const candidate of candidates) {
    try { await record.pc.addIceCandidate(candidate); }
    catch (err) { console.warn('ICE candidate rejected', err); }
  }
}
async function callPeer(id, iceRestart = false) {
  if (!currentRoom || !localStream || !id || id === socket.id) return;
  const record = createPeer(id);
  if (record.offered && !iceRestart) return;
  if (iceRestart && !record.isOfferer) return;
  return peerJob(record, async () => {
    if (record.pc.signalingState === 'closed') return;
    if (record.pc.signalingState !== 'stable') return;
    await prepareLocalOffer(record);
    record.makingOffer = true;
    try {
      const offer = await record.pc.createOffer(iceRestart ? { iceRestart: true } : {});
      await record.pc.setLocalDescription(offer);
      record.offered = true;
      record.isOfferer = true;
      socket.emit('signal', { to: id, signal: { type: 'offer', sdp: record.pc.localDescription } });
    } finally { record.makingOffer = false; }
  });
}
function recoverPeer(id) {
  const record = peers.get(id);
  if (!record || !currentRoom) return;
  const now = Date.now();
  if (now - record.lastRestart < 8000 || record.restartCount >= 3) return;
  record.lastRestart = now;
  record.restartCount++;
  if (record.isOfferer) {
    setTimeout(() => callPeer(id, true).catch(console.error), 1500);
  } else if (socket.connected) {
    socket.emit('media-ready');
  }
}
async function handleSignal(from, signal) {
  if (!from || !signal || !currentRoom) return;
  if (!localStream) {
    const pending = earlySignals.get(from) || [];
    pending.push(signal);
    earlySignals.set(from, pending);
    return;
  }
  const record = createPeer(from);
  if (signal.type === 'candidate') {
    if (record.pc.remoteDescription) {
      try { await record.pc.addIceCandidate(signal.candidate); }
      catch (err) { console.warn('ICE candidate', err); }
    } else record.pendingIce.push(signal.candidate);
    return;
  }
  return peerJob(record, async () => {
    const pc = record.pc;
    if (pc.signalingState === 'closed') return;
    if (signal.type === 'offer') {
      if (pc.signalingState !== 'stable') {
        // If rare simultaneous offers occur, deterministically pick a winner.
        if (socket.id > from) return;
        await pc.setLocalDescription({ type: 'rollback' });
      }
      await pc.setRemoteDescription(signal.sdp);
      await prepareLocalAnswer(record);
      await flushPeerCandidates(record);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      record.offered = true;
      record.isOfferer = false;
      socket.emit('signal', { to: from, signal: { type: 'answer', sdp: pc.localDescription } });
    } else if (signal.type === 'answer') {
      if (pc.signalingState !== 'have-local-offer') return;
      await pc.setRemoteDescription(signal.sdp);
      await flushPeerCandidates(record);
    }
  });
}
function removePeer(id) {
  const rec = peers.get(id);
  if (rec) rec.pc.close();
  peers.delete(id);
  earlySignals.delete(id);
  readyPeers.delete(id);
  removeRemoteAudio(id);
  $("video-" + id)?.remove();
  $("share-" + id)?.remove();
  if (selectedMainVideo === id) selectedMainVideo = "local";
  if (activeScreenSharer === id) activeScreenSharer = null;
  refreshRemoteSharing();
}
async function startMedia(existingPeers = []) {
  if (localStream) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (err) {
    console.warn("Camera and mic together unavailable; trying independently:", err);
    // IMPORTANT: a video-only fallback must NOT silently discard microphone.
    // Try both devices independently and keep every track that works.
    localStream = new MediaStream();
    const audioResult = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true
    }, video: false }).catch(() => null);
    const videoResult = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }).catch(() => null);
    for (const stream of [audioResult, videoResult]) {
      if (!stream) continue;
      for (const track of stream.getTracks()) localStream.addTrack(track);
    }
    if (!localStream.getTracks().length) {
      notify("Camera/microphone permission not granted", "error");
    } else if (!localStream.getAudioTracks().length) {
      notify("Microphone unavailable. Allow microphone permission to use voice.", "error");
    }
  }
  if (currentRole !== "host") {
    if (!currentSettings.mic) localStream.getAudioTracks().forEach(t => { t.enabled = false; });
    if (!currentSettings.camera) localStream.getVideoTracks().forEach(t => { t.enabled = false; });
  }
  createVideo("local", currentUser.name + " (You)", localStream);
  updateControls();
  emitMediaState();
  // The joining participant answers the offer(s) queued during permission prompt.
  for (const [id, signals] of [...earlySignals]) {
    earlySignals.delete(id);
    // Offer MUST be applied before candidates regardless of network ordering.
    for (const signal of signals.filter(s => s.type !== "candidate")) await handleSignal(id, signal);
    for (const signal of signals.filter(s => s.type === "candidate")) await handleSignal(id, signal);
  }
  // Most reliable: the newly admitted guest directly dials ALL existing
  // members using the "peers" array from the server's join-approved event.
  // This avoids relying on a lost peer-ready notification and prevents
  // both sides making offers at once.
  for (const id of existingPeers) {
    if (id && id !== socket.id && !peers.has(id)) await callPeer(id);
  }
  for (const id of [...readyPeers]) {
    readyPeers.delete(id);
    if (id && id !== socket.id && !peers.has(id)) await callPeer(id);
  }
  // Backwards compatibility when a server doesn't supply peer IDs.
  if (!existingPeers.length && currentRole !== "host" && socket.connected && currentRoom) {
    socket.emit("media-ready");
  }
}
function emitMediaState() {
  if (!socket.connected || !currentRoom) return;
  socket.emit("media-state", {
    micEnabled: Boolean(localStream?.getAudioTracks()[0]?.enabled),
    videoEnabled: Boolean(localStream?.getVideoTracks()[0]?.enabled)
  });
}

/* ===== Screen sharing does NOT replace the camera sender ===== */
async function startScreenShare() {
  if (!currentRoom || screenStream) return;
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Screen sharing needs supported desktop Chrome/Edge or compatible browser");
  // getDisplayMedia is called before any await (browser user gesture preserved).
  const captured = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const track = captured.getVideoTracks()[0];
  if (!track) { captured.getTracks().forEach(t => t.stop()); throw new Error("No screen track returned"); }
  let serverGranted = false;
  try {
    const response = await request("screen-share-state", { sharing: true });
    if (!response.ok) throw new Error(response.error);
    serverGranted = true;
    screenStream = captured;
    const replaced = await Promise.allSettled([...peers.values()].map(rec => rec.screenTx.sender.replaceTrack(track)));
    if (replaced.some(result => result.status === "rejected")) console.warn("Some peers could not receive screen track");
    shareGrantUntil = 0;
    activeScreenSharer = "local";
    refreshRemoteSharing();
    track.onended = () => stopScreenShare().catch(console.error);
    updateControls();
    notify("Screen sharing started", "success");
  } catch (err) {
    captured.getTracks().forEach(t => t.stop());
    screenStream = null;
    await Promise.allSettled([...peers.values()].map(rec => rec.screenTx.sender.replaceTrack(null)));
    if (serverGranted && socket.connected) socket.emit("screen-share-state", { sharing: false });
    throw err;
  }
}
async function stopScreenShare() {
  if (!screenStream) return;
  const old = screenStream;
  screenStream = null;
  const track = old.getVideoTracks()[0];
  if (track) track.onended = null;
  await Promise.allSettled([...peers.values()].map(rec => rec.screenTx.sender.replaceTrack(null)));
  old.getTracks().forEach(t => t.stop());
  if (socket.connected) socket.emit("screen-share-state", { sharing: false });
  activeScreenSharer = null;
  refreshRemoteSharing();
  updateControls();
  notify("Screen sharing stopped");
}
async function toggleScreen() {
  const button = $("screenBtn");
  button.disabled = true;
  try {
    if (screenStream) await stopScreenShare();
    else if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("This browser cannot share a screen. You can still watch other screens.");
    else if (currentRole === "host" || currentSettings.share || shareGrantUntil > Date.now()) await startScreenShare();
    else {
      const result = await request("request-screen-share", {});
      if (!result.ok) throw new Error(result.error);
      notify("Screen share request sent to host", "success");
    }
  } catch (err) { notify(err.message, "error"); }
  finally { button.disabled = false; updateControls(); }
}

/* ===== Controls + gallery side panel ===== */
function control(id, icon, text, off = false) {
  const el = $(id); if (!el) return;
  const image = el.querySelector(".ms-control-icon");
  const caption = el.querySelector(".ms-control-label");
  if (image && ICONS[icon]) image.innerHTML = ICONS[icon];
  if (caption) caption.textContent = text;
  el.classList.toggle("is-off", off);
  el.setAttribute("aria-label", text);
}
function updateControls() {
  const mic = localStream?.getAudioTracks()[0];
  const cam = localStream?.getVideoTracks()[0];
  control("micBtn", mic?.enabled ? "mic" : "micOff", !mic ? "No mic" : mic.enabled ? "Mute" : "Unmute", !mic?.enabled);
  control("cameraBtn", cam?.enabled ? "video" : "videoOff", !cam ? "No camera" : cam.enabled ? "Stop video" : "Start video", !cam?.enabled);
  control("screenBtn", "screen", screenStream ? "Stop share" : currentRole === "participant" && !currentSettings.share && shareGrantUntil <= Date.now() ? "Request share" : "Share screen");
  control("raiseHandBtn", "hand", myHandRaised ? "Lower hand" : "Raise hand");
  control("toggleChatBtn", "chat", "Chat");
  control("leaveBtn", "leave", "Leave");
  $("micBtn").disabled = !mic || (currentRole !== "host" && !currentSettings.mic);
  $("cameraBtn").disabled = !cam || (currentRole !== "host" && !currentSettings.camera);
  $("raiseHandBtn").disabled = currentRole !== "host" && !currentSettings.hand;
  $("screenBtn").classList.toggle("is-active", Boolean(screenStream));
  $("raiseHandBtn").classList.toggle("is-active", myHandRaised);
  $("raiseHandBtn").setAttribute("aria-pressed", String(myHandRaised));
  const chatAllowed = currentRole === "host" || currentSettings.chat;
  for (const id of ["chatInput", "chatSendBtn", "attachImageBtn"]) if ($(id)) $(id).disabled = !chatAllowed;
}
function syncHostActions() {
  const host = currentRole === "host" && Boolean(currentRoom);
  for (const id of ["roomSettingsBtn", "extendMeetingBtn", "roomRequestsBtn", "toggleRequestsBtn", "showRequestsTab", "moreRequestsBtn", "moreSettingsBtn", "moreAdjustTimeBtn"]) visible(id, host);
  visible("hostPanel", host);
  if (!host && sidebarTab === "requests") closeSidebar();
  updateRequestIndicator();
}
function closeMoreMenu() {
  visible("meetingMoreMenu", false);
  $("moreBtn").setAttribute("aria-expanded", "false");
}
function openSidebar(tab) {
  if (!currentRoom || (tab === "requests" && currentRole !== "host")) return;
  closeMoreMenu();
  if (sidebarTab === tab && !$("meetingSidebar").hidden) return closeSidebar();
  sidebarTab = tab;
  visible("meetingSidebar", true);
  $("meetingLayout").classList.add("sidebar-open");
  for (const [name, id] of [["people", "participantsPanel"], ["chat", "chatPanel"], ["requests", "requestsPanel"]]) visible(id, name === tab);
  for (const [name, id] of [["people", "showParticipantsTab"], ["chat", "showChatTab"], ["requests", "showRequestsTab"]]) $(id)?.classList.toggle("is-active", name === tab);
  for (const [name, id] of [["people", "toggleParticipantsBtn"], ["chat", "toggleChatBtn"], ["requests", "toggleRequestsBtn"]]) {
    $(id)?.classList.toggle("is-active", name === tab);
    $(id)?.setAttribute("aria-expanded", String(name === tab));
  }
  const labels = { people: ["Participants", "People in this meeting"], chat: ["Meeting chat", "Public and private messages"], requests: ["Meeting requests", "Join and screen-share approvals"] };
  $("sidebarPanelTitle").textContent = labels[tab][0];
  $("sidebarPanelSubtitle").textContent = labels[tab][1];
  if (tab === "chat") $("toggleChatBtn").classList.remove("has-unread");
  if (tab === "requests") $("requestPopup").hidden = true;
  updateRequestIndicator();
}
function closeSidebar() {
  sidebarTab = null;
  visible("meetingSidebar", false);
  $("meetingLayout").classList.remove("sidebar-open");
  for (const id of ["toggleParticipantsBtn", "toggleChatBtn", "toggleRequestsBtn"]) {
    $(id)?.setAttribute("aria-expanded", "false");
    $(id)?.classList.remove("is-active");
  }
}
function toggleMoreMenu() {
  const opening = $("meetingMoreMenu").hidden;
  if (opening) closeSidebar();
  visible("meetingMoreMenu", opening);
  $("moreBtn").setAttribute("aria-expanded", String(opening));
}
function actionButton(text, eventName, peerId) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const result = await request(eventName, peerId);
      if (!result.ok) throw new Error(result.error);
      notify(text + " sent", "success");
    } catch (err) { notify(err.message, "error"); }
    finally { button.disabled = false; }
  });
  return button;
}
function renderParticipants(list) {
  participants = Array.isArray(list) ? list : [];
  $("participantCount").textContent = "(" + participants.length + "/" + MAX_PEOPLE + ")";
  const root = $("participantList"); root.replaceChildren();
  for (const person of participants) {
    const row = document.createElement("div"); row.className = "participant-item";
    const avatar = document.createElement("span"); avatar.textContent = (person.name || "?")[0].toUpperCase();
    avatar.style.cssText = "display:grid;place-items:center;flex:0 0 31px;height:31px;border-radius:9px;background:#3b4465;color:#fff;font-weight:850";
    const details = document.createElement("div"); details.className = "participant-details";
    const name = document.createElement("span"); name.className = "participant-name";
    name.textContent = (person.name || "Guest") + (person.id === socket.id ? " (You)" : "") + (raisedHands.has(person.id) ? " ✋" : "");
    const role = document.createElement("span"); role.className = "participant-role"; role.textContent = person.role === "host" ? "Host" : "Participant";
    details.append(name, role); row.append(avatar, details);
    if (currentRole === "host" && person.id !== socket.id) {
      const actions = document.createElement("div"); actions.className = "participant-actions";
      actions.append(
        actionButton(person.micEnabled === false ? "Ask unmute" : "Mute", person.micEnabled === false ? "ask-participant-unmute" : "mute-participant", person.id),
        actionButton(person.videoEnabled === false ? "Ask video" : "Stop video", person.videoEnabled === false ? "ask-participant-video" : "stop-participant-video", person.id)
      );
      row.appendChild(actions);
    }
    root.appendChild(row);
    const video = $("video-" + person.id);
    if (video) video.querySelector(".video-label").textContent = person.name;
  }
  updateChatRecipients();
  renderVideoLayout();
}
function updateRaisedHandsUI() {
  $("raisedHandCount").textContent = String(raisedHands.size);
  visible("raisedHandsBar", raisedHands.size > 0);
  $("raisedHandsNames").textContent = participants.filter(p => raisedHands.has(p.id)).map(p => p.name).join(", ");
  for (const box of document.querySelectorAll('#videoGrid .video-box[data-is-screen="no"]')) {
    const socketId = box.dataset.personId === "local" ? socket.id : box.dataset.personId;
    let icon = box.querySelector(".hand-indicator");
    if (raisedHands.has(socketId) && !icon) {
      icon = document.createElement("span"); icon.className = "hand-indicator"; icon.textContent = "✋"; box.appendChild(icon);
    } else if (!raisedHands.has(socketId)) icon?.remove();
  }
}
function updateChatRecipients() {
  const el = $("chatRecipient"); const old = el.value; el.replaceChildren();
  const everyone = document.createElement("option"); everyone.value = "everyone"; everyone.textContent = "Everyone (Public)"; el.appendChild(everyone);
  for (const person of participants.filter(p => p.id !== socket.id)) {
    const choice = document.createElement("option"); choice.value = person.id; choice.textContent = person.name + " (Private)"; el.appendChild(choice);
  }
  el.value = [...el.options].some(o => o.value === old) ? old : "everyone";
}
function displayChatMessage(msg) {
  if (!currentRoom || !msg) return;
  $("chatMessages").querySelector(".chat-empty")?.remove();
  const mine = msg.from === socket.id;
  const bubble = document.createElement("div"); bubble.className = "chat-message" + (mine ? " mine" : "") + (msg.private ? " private" : "");
  const head = document.createElement("div"); head.className = "chat-message-header";
  const name = document.createElement("span"); name.className = "chat-message-name"; name.textContent = mine ? "You" : msg.fromName || "Participant";
  const type = document.createElement("span"); type.className = "chat-message-type"; type.textContent = msg.private ? (mine ? "🔒 Private to " + msg.toName : "🔒 Private to you") : "Everyone";
  head.append(name, type); bubble.appendChild(head);
  if (msg.text) { const text = document.createElement("div"); text.className = "chat-message-text"; text.textContent = msg.text; bubble.appendChild(text); }
  if (typeof msg.image === "string" && /^data:image\//.test(msg.image)) {
    const image = document.createElement("img"); image.src = msg.image; image.alt = "Chat attachment"; image.loading = "lazy"; bubble.appendChild(image);
  }
  const when = document.createElement("span"); when.className = "chat-message-time";
  when.textContent = new Date(msg.timestamp || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  bubble.appendChild(when); $("chatMessages").appendChild(bubble);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
  if (sidebarTab !== "chat") $("toggleChatBtn").classList.add("has-unread");
}
function clearSelectedImage() {
  selectedImage = null; $("chatImageInput").value = "";
  if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
  imagePreviewUrl = null; $("chatImageThumbnail").removeAttribute("src"); visible("chatImagePreview", false);
}
async function sendChat(event) {
  event.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text && !selectedImage) return;
  const btn = $("chatSendBtn"); btn.disabled = true;
  try {
    const payload = { text, to: $("chatRecipient").value };
    if (selectedImage) {
      payload.image = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Could not read image"));
        reader.readAsDataURL(selectedImage);
      });
    }
    const result = await request("chat-message", payload, selectedImage ? 30000 : 15000);
    if (!result.ok) throw new Error(result.error);
    $("chatInput").value = ""; clearSelectedImage();
  } catch (err) { notify(err.message, "error"); }
  finally { updateControls(); }
}
function clearChat() {
  $("chatMessages").replaceChildren();
  const empty = document.createElement("div"); empty.className = "chat-empty"; empty.textContent = "No messages yet. Start a conversation!";
  $("chatMessages").appendChild(empty);
  $("chatInput").value = ""; clearSelectedImage(); updateChatRecipients();
}

function updateRequestIndicator() {
  const count = [...pendingRequests.values()].filter(item => !item.consentKind).length;
  for (const id of ["roomRequestCount", "roomRequestCountTop", "roomRequestCountToolbar"]) {
    if ($(id)) $(id).textContent = String(count);
  }
  visible("roomRequestCountTop", count > 0);
  visible("roomRequestCountToolbar", count > 0);
  visible("requestEmptyMessage", count === 0);
}
function showNextRequest() {
  const item = [...pendingRequests.values()].find(r => r.key !== pausedRequestKey);
  activeRequest = item || null;
  if (!item) { visible("requestPopup", false); updateRequestIndicator(); return; }
  $("requestPopupTitle").textContent = item.title;
  $("requestPopupDescription").textContent = item.description;
  $("requestApproveBtn").textContent = item.consentKind ? "Allow" : "Approve";
  $("requestRejectBtn").textContent = item.consentKind ? "Decline" : "Reject";
  $("requestPopupCounter").textContent = pendingRequests.size + " pending";
  visible("requestPopup", true);
  updateRequestIndicator();
}
function syncRequestQueue(kind, list) {
  for (const key of [...pendingRequests.keys()]) if (key.startsWith(kind + ":")) pendingRequests.delete(key);
  if (Array.isArray(list) && currentRole === "host") {
    for (const user of list) {
      if (!user?.id) continue;
      const key = kind + ":" + user.id;
      pendingRequests.set(key, {
        key, userId: user.id,
        title: (user.name || "Participant") + (kind === "join" ? " wants to join" : " wants to share screen"),
        description: kind === "join" ? "Allow this person into the meeting?" : "Allow this participant to share a screen?",
        approveEvent: kind === "join" ? "approve-request" : "approve-screen-share",
        rejectEvent: kind === "join" ? "reject-request" : "reject-screen-share"
      });
    }
  }
  if (pausedRequestKey && !pendingRequests.has(pausedRequestKey)) pausedRequestKey = null;
  showNextRequest();
}
function askConsent(kind) {
  const key = "consent:" + kind;
  pendingRequests.set(key, {
    key, consentKind: kind,
    title: kind === "mic" ? "Host requests microphone" : "Host requests camera",
    description: kind === "mic" ? "Unmute your microphone?" : "Turn on your camera?"
  });
  showNextRequest();
}
async function respondToRequest(approve) {
  const item = activeRequest;
  if (!item) return;
  $("requestApproveBtn").disabled = true;
  $("requestRejectBtn").disabled = true;
  try {
    if (item.consentKind) {
      if (approve) {
        const key = item.consentKind === "mic" ? "mic" : "camera";
        const track = item.consentKind === "mic" ? localStream?.getAudioTracks()[0] : localStream?.getVideoTracks()[0];
        if (!currentSettings[key] || !track) throw new Error("Permission or device unavailable");
        track.enabled = true;
        emitMediaState();
        updateControls();
        updateVideoPlaceholders();
      }
    } else {
      const result = await request(approve ? item.approveEvent : item.rejectEvent, item.userId);
      if (!result.ok) throw new Error(result.error);
    }
    pendingRequests.delete(item.key);
    pausedRequestKey = null;
    notify(approve ? "Approved" : "Declined", "success");
  } catch (err) { notify(err.message, "error"); }
  finally {
    $("requestApproveBtn").disabled = false;
    $("requestRejectBtn").disabled = false;
    showNextRequest();
  }
}
function requestRow(user, yesEvent, noEvent) {
  const row = document.createElement("div"); row.className = "waiting-item";
  const name = document.createElement("span"); name.textContent = user.name || "Participant";
  const buttons = document.createElement("div"); buttons.className = "waiting-actions";
  buttons.append(actionButton("Approve", yesEvent, user.id), actionButton("Reject", noEvent, user.id));
  row.append(name, buttons); return row;
}
function renderWaitingRequests() {
  $("waitingList").replaceChildren();
  if (!waitingRoomUsers.length) {
    const msg = document.createElement("p"); msg.textContent = "No pending requests"; $("waitingList").appendChild(msg);
  }
  for (const p of waitingRoomUsers) $("waitingList").appendChild(requestRow(p, "approve-request", "reject-request"));
  $("screenShareRequests").replaceChildren();
  for (const p of screenRequests) $("screenShareRequests").appendChild(requestRow(p, "approve-screen-share", "reject-screen-share"));
  updateRequestIndicator();
}
function toggleModal(id, show) {
  visible(id, show);
  if (show) $(id).querySelector(".ms-room-dialog")?.focus();
}
function closeAllModals() {
  for (const id of ["createSettingsModal", "roomSettingsModal", "extendMeetingModal"]) toggleModal(id, false);
}
function updateCreateSummary() {
  const duration = $("meetingDuration");
  const custom = duration.selectedOptions[0]?.dataset.custom === "true";
  visible("customDurationFields", custom);
  visible("scheduledMeetingFields", $("meetingType").value === "scheduled");
  const minutes = custom ? $("meetingCustomDuration").value : duration.value;
  $("createSettingsSummary").textContent = (minutes || "Custom") + " minutes · Waiting room " + ($("setting-approval").checked ? "on" : "off");
}
function createSettingsTab(general) {
  visible("createGeneralFields", general);
  visible("createPermissionFields", !general);
  $("createGeneralTab").classList.toggle("is-active", general);
  $("createPermissionsTab").classList.toggle("is-active", !general);
}
function populateHostSettings() {
  for (const key of SETTINGS_KEYS) $("room-setting-" + key).checked = Boolean(currentSettings[key]);
}
async function saveHostSettings() {
  if (currentRole !== "host") return;
  const values = {};
  for (const key of SETTINGS_KEYS) values[key] = $("room-setting-" + key).checked;
  const button = $("saveRoomSettingsBtn"); button.disabled = true;
  try {
    const result = await request("update-meeting-settings", values);
    if (!result.ok) throw new Error(result.error);
    currentSettings = result.settings || values;
    toggleModal("roomSettingsModal", false);
    updateControls();
    notify("Host permissions saved", "success");
  } catch (err) { notify(err.message, "error"); }
  finally { button.disabled = false; }
}
function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map(n => String(n).padStart(2, "0")).join(":");
}
function remainingSeconds() { return meetingEndsAt ? Math.max(0, Math.ceil((meetingEndsAt - Date.now()) / 1000)) : 0; }
function renderMeetingClock() {
  visible("meetingTimerBlock", Boolean(currentRoom && meetingEndsAt));
  if (!currentRoom || !meetingEndsAt) return;
  $("meetingCountdown").textContent = formatTime(remainingSeconds());
  $("meetingEndInfo").textContent = "Ends " + new Date(meetingEndsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (!$("extendMeetingModal").hidden) updateTimePreview();
}
function adjustmentMinutes() {
  const raw = adjustmentPreset === "custom" ? $("customExtensionMinutes").value : adjustmentPreset;
  if (String(raw).trim() === "") return NaN;
  const n = Number(raw); return Number.isInteger(n) ? n : NaN;
}
function updateTimePreview() {
  const seconds = remainingSeconds();
  const minutes = adjustmentMinutes();
  const changed = seconds + (adjustmentMode === "add" ? 1 : -1) * minutes * 60;
  const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 && changed >= 60 && changed <= 14 * 86400;
  $("timeCurrentValue").textContent = formatTime(seconds);
  $("timeBeforeValue").textContent = formatTime(seconds);
  $("timePreviewValue").textContent = valid ? formatTime(changed) : "--:--:--";
  $("timeAdjustError").textContent = !Number.isInteger(minutes) || minutes < 1 || minutes > 1440
    ? "Enter 1–1440 whole minutes" : changed < 60 ? "At least one minute must remain" : changed > 14 * 86400 ? "Maximum 14 days remaining" : "";
  $("confirmExtendMeetingBtn").disabled = !valid;
  $("confirmExtendMeetingBtn").textContent = (adjustmentMode === "add" ? "＋ Add " : "− Reduce ") + (Number.isInteger(minutes) ? minutes : "—") + " min";
  $("timeModeInput").value = adjustmentMode;
  $("extensionMinutes").value = adjustmentPreset;
  visible("customExtensionFields", adjustmentPreset === "custom");
  for (const b of document.querySelectorAll("[data-time-mode]")) {
    const on = b.dataset.timeMode === adjustmentMode;
    b.classList.toggle("is-active", on); b.setAttribute("aria-pressed", String(on));
  }
  for (const b of document.querySelectorAll("[data-time-preset]")) b.classList.toggle("is-active", b.dataset.timePreset === adjustmentPreset);
}
function openTimeModal() {
  if (currentRole !== "host") return;
  adjustmentMode = "add"; adjustmentPreset = "15"; $("customExtensionMinutes").value = "10";
  toggleModal("extendMeetingModal", true);
  updateTimePreview();
}
async function applyTimeAdjustment() {
  if (currentRole !== "host") return;
  const minutes = adjustmentMinutes();
  const signed = (adjustmentMode === "add" ? 1 : -1) * minutes;
  const changed = remainingSeconds() + signed * 60;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440 || changed < 60 || changed > 14 * 86400) {
    return notify("Invalid minutes or remaining time", "error");
  }
  const button = $("confirmExtendMeetingBtn"); button.disabled = true;
  try {
    const result = await request("adjust-meeting-time", { minutes: signed });
    if (!result.ok) throw new Error(result.error);
    applyMeetingTiming(result);
    toggleModal("extendMeetingModal", false);
    notify("Meeting time " + (signed > 0 ? "increased" : "reduced") + " by " + minutes + " minute(s)", "success");
  } catch (err) { notify(err.message, "error"); }
  finally { button.disabled = false; }
}
async function copyInvite() {
  if (!currentRoom) return;
  try { await navigator.clipboard.writeText(meetingLink(currentRoom)); notify("Invite link copied. Send the password separately", "success"); }
  catch { notify("Copy URL from address bar instead", "error"); }
}
function resetMeeting() {
  const hadRoom = Boolean(currentRoom);
  // Disconnect FIRST so the disconnect callback cannot interfere with reset.
  currentRoom = null;
  currentRole = null;
  meetingEndsAt = null;
  meetingStartsAt = null;
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
  visible("requestPopup", false);
  for (const record of peers.values()) record.pc.close();
  peers.clear(); earlySignals.clear(); readyPeers.clear();
  for (const id of [...audioElements.keys()]) removeRemoteAudio(id);
  audioEnableButton?.remove(); audioEnableButton = null;
  if (screenStream) screenStream.getTracks().forEach(t => t.stop());
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  screenStream = null; localStream = null;
  $("videoGrid").replaceChildren();
  $("mainVideoStage").replaceChildren();
  $("roomText").textContent = "—";
  closeAllModals(); closeSidebar(); closeMoreMenu();
  showScreenBanner(null); clearChat();
  $("waitingList").replaceChildren();
  $("screenShareRequests").replaceChildren();
  visible("hostPanel", false);
  if (socket.connected) socket.disconnect();
  currentSettings = { ...DEFAULT_SETTINGS };
  updateRequestIndicator();
  isLeaving = false;
  pendingPage = "home";
  navigate("home");
  if (hadRoom) status("You left the meeting");
}
function leaveMeeting() {
  if (isLeaving) return;
  isLeaving = true;
  if (socket.connected) socket.emit("leave-room");
  resetMeeting();
}

/* ===== Socket.IO event handlers ===== */
socket.on("join-approved", async data => {
  if (!data?.roomId) return;
  try {
    currentSettings = data.settings || currentSettings;
    applyMeetingTiming(data);
    enterMeeting(data.roomId, data.role || "participant");
    renderParticipants(data.participants || []);
    await startMedia(Array.isArray(data.peers) ? data.peers : []);
    notify("You joined the meeting", "success");
  } catch (err) { console.error(err); notify(err.message, "error"); }
});
socket.on("join-rejected", data => { resetMeeting(); notify(data?.message || "Host rejected join request", "error"); });
socket.on("meeting-ended", data => { resetMeeting(); notify(data?.reason || "Meeting ended"); });
socket.on("user-joined", () => status("Someone joined the meeting"));
socket.on("user-left", id => { removePeer(id); raisedHands.delete(id); updateRaisedHandsUI(); });
socket.on("participants-updated", data => {
  if (!currentRoom || (data?.roomId && data.roomId !== currentRoom)) return;
  if (data.settings) currentSettings = data.settings;
  renderParticipants(data.participants || []);
  applyMeetingTiming(data); updateControls();
});
socket.on("participant-media-updated", data => {
  const person = participants.find(p => p.id === data?.id);
  if (!person) return;
  person.micEnabled = data.micEnabled;
  person.videoEnabled = data.videoEnabled;
  renderParticipants(participants);
});
socket.on("signal", ({ from, signal } = {}) => { handleSignal(from, signal).catch(err => { console.error("WebRTC signaling", err); status(err.message); }); });
socket.on("peer-ready", ({ id } = {}) => {
  if (!id || !currentRoom) return;
  if (!localStream) { readyPeers.add(id); return; }
  const record = peers.get(id);
  const restart = Boolean(record?.isOfferer && ["failed", "disconnected"].includes(record.pc.connectionState));
  callPeer(id, restart).catch(console.error);
});
socket.on("waiting-updated", list => {
  waitingRoomUsers = Array.isArray(list) ? list : [];
  syncRequestQueue("join", waitingRoomUsers);
  renderWaitingRequests();
});
socket.on("screen-share-requests-updated", list => {
  screenRequests = Array.isArray(list) ? list : [];
  syncRequestQueue("share", screenRequests);
  renderWaitingRequests();
});
socket.on("screen-share-approved", () => {
  shareGrantUntil = Date.now() + 55000;
  updateControls();
  notify("Approved. Click Share screen within 60 seconds", "success");
});
socket.on("screen-share-rejected", data => notify(data?.message || "Screen sharing request rejected", "error"));
socket.on("screen-share-updated", data => {
  activeScreenSharer = !data?.sharing ? null : data.id === socket.id ? "local" : data.id;
  refreshRemoteSharing();
});
socket.on("hands-updated", data => {
  raisedHands = new Set(Array.isArray(data?.ids) ? data.ids : []);
  myHandRaised = raisedHands.has(socket.id);
  updateRaisedHandsUI(); updateControls();
});
socket.on("chat-message", displayChatMessage);
socket.on("force-mute", () => {
  const track = localStream?.getAudioTracks()[0];
  if (track) { track.enabled = false; emitMediaState(); updateControls(); }
  notify("Host muted your microphone");
});
socket.on("force-video-off", () => {
  const track = localStream?.getVideoTracks()[0];
  if (track) { track.enabled = false; emitMediaState(); updateControls(); updateVideoPlaceholders(); }
  notify("Host stopped your camera");
});
socket.on("request-unmute", () => askConsent("mic"));
socket.on("request-video-on", () => askConsent("camera"));
socket.on("meeting-settings-updated", data => {
  applyMeetingTiming(data);
  if (data?.settings) currentSettings = data.settings;
  if (currentRole !== "host" && localStream) {
    if (!currentSettings.mic) localStream.getAudioTracks().forEach(t => { t.enabled = false; });
    if (!currentSettings.camera) localStream.getVideoTracks().forEach(t => { t.enabled = false; });
    emitMediaState();
  }
  updateControls(); updateVideoPlaceholders();
});
socket.on("meeting-time-adjusted", data => { applyMeetingTiming(data); if (currentRole !== "host") notify("Host adjusted meeting time", "success"); });
socket.on("meeting-extended", applyMeetingTiming);
socket.on("disconnect", () => {
  if (currentRoom && !isLeaving) { resetMeeting(); notify("Disconnected from meeting server", "error"); }
});

/* ===== Bind all buttons from current approved HTML ===== */
function bind(id, event, handler) { $(id)?.addEventListener(event, handler); }
function initializeControls() {
  document.querySelectorAll("[data-page]").forEach(el => {
    el.addEventListener("click", e => { e.preventDefault(); navigate(el.dataset.page); });
  });
  bind("googleLoginBtn", "click", loginGoogle);
  bind("guestLoginBtn", "click", () => { visible("guestNameSection", true); $("guestName").focus(); });
  bind("guestContinueBtn", "click", loginGuest);
  bind("guestName", "keydown", e => { if (e.key === "Enter") loginGuest(); });
  bind("createBtn", "click", createMeeting);
  bind("joinBtn", "click", joinMeeting);
  for (const id of ["cancelWaitingBtn", "leaveBtn", "roomMobileLeaveBtn", "moreLeaveBtn"]) bind(id, "click", leaveMeeting);
  bind("copyBtn", "click", copyInvite);
  bind("moreInviteBtn", "click", () => { closeMoreMenu(); copyInvite(); });
  bind("micBtn", "click", () => {
    const t = localStream?.getAudioTracks()[0]; if (!t) return;
    if (currentRole !== "host" && !currentSettings.mic) return notify("Host disabled microphone", "error");
    t.enabled = !t.enabled; emitMediaState(); updateControls();
  });
  bind("cameraBtn", "click", () => {
    const t = localStream?.getVideoTracks()[0]; if (!t) return;
    if (currentRole !== "host" && !currentSettings.camera) return notify("Host disabled camera", "error");
    t.enabled = !t.enabled; emitMediaState(); updateControls(); updateVideoPlaceholders();
  });
  bind("screenBtn", "click", toggleScreen);
  async function toggleHand() {
    if (!currentRoom) return;
    try {
      const response = await request("raise-hand", { raised: !myHandRaised });
      if (!response.ok) throw new Error(response.error);
      myHandRaised = !myHandRaised; updateControls();
    } catch (err) { notify(err.message, "error"); }
  }
  bind("raiseHandBtn", "click", toggleHand);
  bind("moreHandBtn", "click", () => { closeMoreMenu(); toggleHand(); });
  bind("toggleParticipantsBtn", "click", () => openSidebar("people"));
  bind("toggleChatBtn", "click", () => openSidebar("chat"));
  bind("toggleRequestsBtn", "click", () => openSidebar("requests"));
  bind("roomRequestsBtn", "click", () => openSidebar("requests"));
  // Tabs switch, not close (toolbar buttons are the close toggles).
  for (const [id, tab] of [["showParticipantsTab", "people"], ["showChatTab", "chat"], ["showRequestsTab", "requests"]]) {
    bind(id, "click", () => { sidebarTab = null; openSidebar(tab); });
  }
  bind("closeSidebarBtn", "click", closeSidebar);
  bind("moreBtn", "click", toggleMoreMenu);
  bind("morePeopleBtn", "click", () => openSidebar("people"));
  bind("moreRequestsBtn", "click", () => openSidebar("requests"));
  bind("participantsToggle", "click", () => {
    const body = $("participantsBody"); body.hidden = !body.hidden;
    $("participantsToggle").textContent = body.hidden ? "⌄" : "⌃";
    $("participantsToggle").setAttribute("aria-expanded", String(!body.hidden));
  });
  bind("attachImageBtn", "click", () => $("chatImageInput").click());
  bind("chatImageInput", "change", () => {
    const file = $("chatImageInput").files[0]; if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type) || file.size > 2 * 1024 * 1024) {
      clearSelectedImage(); return notify("Image must be JPG, PNG, WEBP or GIF under 2 MB", "error");
    }
    selectedImage = file;
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    imagePreviewUrl = URL.createObjectURL(file);
    $("chatImageThumbnail").src = imagePreviewUrl;
    $("chatImageFilename").textContent = file.name;
    visible("chatImagePreview", true);
  });
  bind("removeChatImageBtn", "click", clearSelectedImage);
  bind("chatForm", "submit", sendChat);
  bind("requestApproveBtn", "click", () => respondToRequest(true));
  bind("requestRejectBtn", "click", () => respondToRequest(false));
  bind("requestLaterBtn", "click", () => {
    pausedRequestKey = activeRequest?.key || null;
    visible("requestPopup", false);
    if (currentRole === "host") openSidebar("requests");
  });
  bind("openCreateSettingsBtn", "click", () => { createSettingsTab(true); updateCreateSummary(); toggleModal("createSettingsModal", true); });
  bind("closeCreateSettingsBtn", "click", () => toggleModal("createSettingsModal", false));
  bind("createGeneralTab", "click", () => createSettingsTab(true));
  bind("createPermissionsTab", "click", () => createSettingsTab(false));
  for (const id of ["meetingDuration", "meetingCustomDuration", "meetingType", "setting-approval"]) {
    bind(id, id === "meetingCustomDuration" ? "input" : "change", updateCreateSummary);
  }
  bind("saveCreateSettingsBtn", "click", () => {
    try { createMeetingPayload("safe-placeholder"); updateCreateSummary(); toggleModal("createSettingsModal", false); notify("Settings saved", "success"); }
    catch (err) { createSettingsTab(true); notify(err.message, "error"); }
  });
  bind("roomSettingsBtn", "click", () => { populateHostSettings(); toggleModal("roomSettingsModal", true); });
  bind("moreSettingsBtn", "click", () => { closeMoreMenu(); $("roomSettingsBtn").click(); });
  bind("closeRoomSettingsBtn", "click", () => toggleModal("roomSettingsModal", false));
  bind("saveRoomSettingsBtn", "click", saveHostSettings);
  bind("extendMeetingBtn", "click", openTimeModal);
  bind("moreAdjustTimeBtn", "click", () => { closeMoreMenu(); openTimeModal(); });
  bind("closeExtendMeetingBtn", "click", () => toggleModal("extendMeetingModal", false));
  bind("cancelTimeAdjustBtn", "click", () => toggleModal("extendMeetingModal", false));
  document.querySelectorAll("[data-time-mode]").forEach(b => b.addEventListener("click", () => { adjustmentMode = b.dataset.timeMode; updateTimePreview(); }));
  document.querySelectorAll("[data-time-preset]").forEach(b => b.addEventListener("click", () => {
    adjustmentPreset = b.dataset.timePreset; updateTimePreview();
    if (adjustmentPreset === "custom") $("customExtensionMinutes").focus();
  }));
  bind("customExtensionMinutes", "input", updateTimePreview);
  bind("confirmExtendMeetingBtn", "click", applyTimeAdjustment);
  for (const id of ["createSettingsModal", "roomSettingsModal", "extendMeetingModal"]) {
    bind(id, "click", e => { if (e.target === $(id)) toggleModal(id, false); });
  }
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { closeAllModals(); closeMoreMenu(); }
  });
  bind("themeToggle", "click", () => {
    const light = document.body.classList.toggle("light-mode");
    $("themeToggle").textContent = light ? "☾ Dark" : "☀ Light";
    try { localStorage.setItem("meetspace-theme", light ? "light" : "dark"); } catch {}
  });
  try {
    if (localStorage.getItem("meetspace-theme") === "light") {
      document.body.classList.add("light-mode"); $("themeToggle").textContent = "☾ Dark";
    }
  } catch {}
  const invite = new URLSearchParams(location.search).get("room");
  if (invite && /^[a-f0-9]{10}$/i.test(invite)) {
    $("roomInput").value = invite;
    navigate("join", true);
  } else navigate("home", true);
  updateCreateSummary(); updateControls(); syncHostActions(); restoreSession();
  setInterval(renderMeetingClock, 1000);
  status("Welcome to MeetSpace");
}
initializeControls();
