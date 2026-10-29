
require("dotenv").config();

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

/* ==========================================
   MEETSPACE SERVER CONFIGURATION
========================================== */

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;

if (!PROJECT_ID) {
  throw new Error(
    "Set FIREBASE_PROJECT_ID in .env or Render environment"
  );
}

const firebaseApp = getApps().length
  ? getApps()[0]
  : initializeApp({ projectId: PROJECT_ID });

const firebaseAuth = getAuth(firebaseApp);

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 3.5 * 1024 * 1024
});

const PORT = Number(process.env.PORT) || 3000;

const MAX_PARTICIPANTS = 10;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const rooms = new Map();

app.use(express.static("public"));

app.get("/health", (req, res) => {
  res.json({
    status: "running",
    rooms: rooms.size
  });
});

/* ==========================================
   HELPERS
========================================== */

function reply(callback, data) {
  if (typeof callback === "function") {
    callback(data);
  }
}

function success(callback, data = {}) {
  reply(callback, { ok: true, ...data });
}

function fail(callback, message) {
  reply(callback, {
    ok: false,
    error: message
  });
}

function getRoom(socket) {
  return rooms.get(socket.data.roomId);
}

function getMember(socket) {
  return getRoom(socket)?.members.get(socket.id);
}

function isModerator(member) {
  return (
    member?.role === "host" ||
    member?.role === "admin"
  );
}

function roomInfo(room) {
  return {
    roomId: room.id,
    participants: [...room.members.entries()].map(
      ([id, user]) => ({
        id,
        name: user.name,
        role: user.role,
        raisedHand: room.raisedHands.has(id)
      })
    )
  };
}

function updateParticipants(room) {
  io.to(room.id).emit(
    "participants-updated",
    roomInfo(room)
  );
}

function updateWaiting(room) {
  const waiting = [...room.waiting.entries()].map(
    ([id, user]) => ({
      id,
      name: user.name
    })
  );

  for (const [id, member] of room.members) {
    if (isModerator(member)) {
      io.to(id).emit("waiting-updated", waiting);
    }
  }
}

function updateHands(room) {
  io.to(room.id).emit("hands-updated", {
    ids: [...room.raisedHands]
  });
}

function updateScreenShare(room) {
  io.to(room.id).emit("screen-share-updated", {
    id: room.activeSharer,
    sharing: !!room.activeSharer
  });
}

function updateScreenRequests(room) {
  const requests = [...room.shareRequests].map(
    (id) => ({
      id,
      name: room.members.get(id)?.name || "Participant"
    })
  );

  for (const [id, member] of room.members) {
    if (isModerator(member)) {
      io.to(id).emit(
        "screen-share-requests-updated",
        requests
      );
    }
  }
}

/* ==========================================
   PASSWORD SECURITY
========================================== */

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64);
}

function verifyPassword(password, room) {
  const hash = hashPassword(password, room.salt);

  return crypto.timingSafeEqual(
    hash,
    room.passwordHash
  );
}

/* ==========================================
   IMAGE VALIDATION
========================================== */

function validateImage(value) {
  if (value === undefined || value === null || value === "") {
    return { ok: true, image: null };
  }

  if (typeof value !== "string") {
    return { ok: false, error: "Invalid image." };
  }

  const match = value.match(
    /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/
  );

  if (!match) {
    return {
      ok: false,
      error: "Only JPG, PNG, WEBP and GIF are supported."
    };
  }

  const encoded = match[2];

  if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) {
    return {
      ok: false,
      error: "Image must be 2 MB or smaller."
    };
  }

  const buffer = Buffer.from(encoded, "base64");

  if (
    buffer.length === 0 ||
    buffer.length > MAX_IMAGE_BYTES ||
    buffer.toString("base64") !== encoded
  ) {
    return {
      ok: false,
      error: "Invalid or oversized image."
    };
  }

  const type = match[1];

  const validSignature =
    type === "jpeg"
      ? buffer.length >= 3 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff
      : type === "png"
        ? buffer.subarray(0, 8).equals(
            Buffer.from("89504e470d0a1a0a", "hex")
          )
        : type === "gif"
          ? ["GIF87a", "GIF89a"].includes(
              buffer.subarray(0, 6).toString("ascii")
            )
          : buffer.length >= 12 &&
            buffer.toString("ascii", 0, 4) === "RIFF" &&
            buffer.toString("ascii", 8, 12) === "WEBP";

  if (!validSignature) {
    return {
      ok: false,
      error: "Image content does not match its type."
    };
  }

  return { ok: true, image: value };
}

/* ==========================================
   CLEANUP ON LEAVE
========================================== */

function leaveRoom(socket) {
  const room = getRoom(socket);

  if (!room) {
    socket.data.roomId = null;
    return;
  }

  const member = room.members.get(socket.id);

  // Host leaving ends the whole meeting.
  if (member?.role === "host") {
    const allUsers = [
      ...room.members.keys(),
      ...room.waiting.keys()
    ];

    for (const id of allUsers) {
      const target = io.sockets.sockets.get(id);

      if (!target) continue;

      target.data.roomId = null;
      target.leave(room.id);

      if (id !== socket.id) {
        io.to(id).emit("meeting-ended");
      }
    }

    room.members.clear();
    room.waiting.clear();
    room.raisedHands.clear();
    room.shareRequests.clear();
    room.shareGrants.clear();

    rooms.delete(room.id);

    console.log("Meeting ended:", room.id);
    return;
  }

  const wasMember = room.members.delete(socket.id);

  room.waiting.delete(socket.id);
  room.raisedHands.delete(socket.id);
  room.shareRequests.delete(socket.id);
  room.shareGrants.delete(socket.id);

  socket.leave(room.id);
  socket.data.roomId = null;

  if (room.activeSharer === socket.id) {
    room.activeSharer = null;
    updateScreenShare(room);
  }

  if (wasMember) {
    socket.to(room.id).emit("user-left", socket.id);
  }

  updateParticipants(room);
  updateWaiting(room);
  updateHands(room);
  updateScreenRequests(room);
}

/* ==========================================
   FIREBASE AUTHENTICATION
========================================== */

io.use(async (socket, next) => {
  try {
    const credential =
      socket.handshake.auth?.credential;

    if (
      typeof credential !== "string" ||
      !credential
    ) {
      return next(
        new Error("Firebase login required")
      );
    }

    const claims =
      await firebaseAuth.verifyIdToken(credential);

    if (!claims.uid) {
      return next(
        new Error("Invalid Firebase account")
      );
    }

    const isGuest =
      claims.firebase?.sign_in_provider === "anonymous";

    const guestName = String(
      socket.handshake.auth?.name || "Guest"
    ).trim().slice(0, 60) || "Guest";

    socket.data.user = {
      id: claims.uid,
      name: isGuest
        ? guestName
        : (
            claims.name ||
            claims.email ||
            "Google User"
          ),
      email: claims.email || null,
      isGuest
    };

    next();

  } catch (error) {
    console.warn(
      "Authentication rejected:",
      error.code || error.message
    );

    next(
      new Error("Firebase authentication failed")
    );
  }
});

/* ==========================================
   SOCKET.IO CONNECTION
========================================== */

io.on("connection", (socket) => {
  console.log(
    "Connected:",
    socket.data.user.name,
    socket.id
  );

  /* ========================================
     CREATE ROOM
  ======================================== */

  socket.on("create-room", (data = {}, callback) => {
    if (socket.data.roomId) {
      return fail(
        callback,
        "Leave your current meeting first"
      );
    }

    const password =
      typeof data.password === "string"
        ? data.password
        : "";

    if (
      password.length < 4 ||
      password.length > 64
    ) {
      return fail(
        callback,
        "Password must be 4 to 64 characters"
      );
    }

    let roomId;

    do {
      roomId = crypto.randomBytes(5).toString("hex");
    } while (rooms.has(roomId));

    const salt = crypto.randomBytes(16);

    const room = {
      id: roomId,
      salt,
      passwordHash: hashPassword(password, salt),
      members: new Map(),
      waiting: new Map(),
      raisedHands: new Set(),
      shareRequests: new Set(),
      shareGrants: new Map(),
      activeSharer: null
    };

    room.members.set(socket.id, {
      ...socket.data.user,
      role: "host"
    });

    rooms.set(roomId, room);

    socket.join(roomId);
    socket.data.roomId = roomId;

    success(callback, {
      roomId,
      role: "host",
      ...roomInfo(room)
    });

    updateParticipants(room);
    updateHands(room);
  });

  /* ========================================
     REQUEST JOIN
  ======================================== */

  socket.on("request-join", (data = {}, callback) => {
    if (socket.data.roomId) {
      return fail(
        callback,
        "Leave your current meeting first"
      );
    }

    const roomId = String(
      data.roomId || ""
    ).trim();

    const password =
      typeof data.password === "string"
        ? data.password
        : "";

    const room = rooms.get(roomId);

    if (!room) {
      return fail(callback, "Meeting not found");
    }

    if (!verifyPassword(password, room)) {
      return fail(
        callback,
        "Incorrect meeting password"
      );
    }

    if (
      room.members.size + room.waiting.size >=
      MAX_PARTICIPANTS
    ) {
      return fail(callback, "Meeting is full");
    }

    room.waiting.set(socket.id, {
      ...socket.data.user
    });

    socket.data.roomId = roomId;

    success(callback, { status: "waiting" });

    updateWaiting(room);
  });

  /* ========================================
     APPROVE JOIN
  ======================================== */

  socket.on("approve-request", (targetId, callback) => {
    const room = getRoom(socket);
    const actor = getMember(socket);

    if (!room || !isModerator(actor)) {
      return fail(callback, "Permission denied");
    }

    const waitingUser = room.waiting.get(targetId);

    if (!waitingUser) {
      return fail(callback, "Request not found");
    }

    if (room.members.size >= MAX_PARTICIPANTS) {
      return fail(callback, "Meeting is full");
    }

    const targetSocket =
      io.sockets.sockets.get(targetId);

    if (!targetSocket) {
      room.waiting.delete(targetId);
      updateWaiting(room);

      return fail(
        callback,
        "User disconnected"
      );
    }

    const existingPeers = [
      ...room.members.keys()
    ];

    room.waiting.delete(targetId);

    room.members.set(targetId, {
      ...waitingUser,
      role: "participant"
    });

    targetSocket.join(room.id);

    io.to(targetId).emit("join-approved", {
      roomId: room.id,
      role: "participant",
      peers: existingPeers
    });

    socket.to(room.id).emit(
      "user-joined",
      targetId
    );

    updateParticipants(room);
    updateWaiting(room);
    updateHands(room);
    updateScreenShare(room);

    success(callback);
  });

  /* ========================================
     REJECT JOIN
  ======================================== */

  socket.on("reject-request", (targetId, callback) => {
    const room = getRoom(socket);
    const actor = getMember(socket);

    if (!room || !isModerator(actor)) {
      return fail(callback, "Permission denied");
    }

    if (!room.waiting.has(targetId)) {
      return fail(callback, "Request not found");
    }

    room.waiting.delete(targetId);

    const targetSocket =
      io.sockets.sockets.get(targetId);

    if (targetSocket) {
      targetSocket.data.roomId = null;
    }

    io.to(targetId).emit("join-rejected");

    updateWaiting(room);
    success(callback);
  });

  /* ========================================
     ASSIGN ADMIN
  ======================================== */

  socket.on("assign-admin", (targetId, callback) => {
    const room = getRoom(socket);
    const actor = getMember(socket);
    const target = room?.members.get(targetId);

    if (
      actor?.role !== "host" ||
      !target ||
      target.role === "host"
    ) {
      return fail(callback, "Permission denied");
    }

    target.role = "admin";

    io.to(targetId).emit(
      "role-updated",
      "admin"
    );

    updateParticipants(room);
    updateWaiting(room);
    updateScreenRequests(room);

    success(callback);
  });

  /* ========================================
     TRANSFER HOST
  ======================================== */

  socket.on("transfer-host", (targetId, callback) => {
    const room = getRoom(socket);
    const actor = getMember(socket);
    const target = room?.members.get(targetId);

    if (
      actor?.role !== "host" ||
      !target ||
      targetId === socket.id
    ) {
      return fail(callback, "Permission denied");
    }

    actor.role = "admin";
    target.role = "host";

    io.to(socket.id).emit(
      "role-updated",
      "admin"
    );

    io.to(targetId).emit(
      "role-updated",
      "host"
    );

    updateParticipants(room);
    updateWaiting(room);
    updateScreenRequests(room);

    success(callback);
  });

  /* ========================================
     RAISE / LOWER HAND
  ======================================== */

  socket.on("raise-hand", (data = {}, callback) => {
    const room = getRoom(socket);
    const member = getMember(socket);

    if (!room || !member) {
      return fail(
        callback,
        "Join a meeting first"
      );
    }

    if (typeof data.raised !== "boolean") {
      return fail(
        callback,
        "Invalid hand raise status"
      );
    }

    if (data.raised) {
      room.raisedHands.add(socket.id);
    } else {
      room.raisedHands.delete(socket.id);
    }

    updateHands(room);
    updateParticipants(room);

    success(callback, {
      raised: data.raised,
      count: room.raisedHands.size
    });
  });

  /* ========================================
     HOST / ADMIN MUTE
  ======================================== */

  socket.on(
    "mute-participant",
    (targetId, callback) => {
      const room = getRoom(socket);
      const actor = getMember(socket);
      const target = room?.members.get(targetId);

      if (
        !room ||
        !isModerator(actor) ||
        !target ||
        targetId === socket.id
      ) {
        return fail(
          callback,
          "Permission denied"
        );
      }

      // A moderator can request muting.
      // Only the participant can unmute themselves.
      io.to(targetId).emit("force-mute", {
        by: socket.data.user.name
      });

      success(callback);
    }
  );

  /* ========================================
     SCREEN SHARE REQUEST
  ======================================== */

  socket.on(
    "request-screen-share",
    (data = {}, callback) => {
      const room = getRoom(socket);
      const member = getMember(socket);

      if (!room || !member) {
        return fail(
          callback,
          "Join a meeting first"
        );
      }

      if (isModerator(member)) {
        return fail(
          callback,
          "Host/Admin can share directly"
        );
      }

      if (room.activeSharer) {
        return fail(
          callback,
          "Someone is already sharing"
        );
      }

      if (room.shareRequests.has(socket.id)) {
        return fail(
          callback,
          "Request already pending"
        );
      }

      room.shareRequests.add(socket.id);

      for (const [id, user] of room.members) {
        if (isModerator(user)) {
          io.to(id).emit(
            "screen-share-request",
            {
              id: socket.id,
              name: member.name
            }
          );
        }
      }

      updateScreenRequests(room);
      success(callback);
    }
  );

  /* ========================================
     APPROVE SCREEN SHARE
  ======================================== */

  socket.on(
    "approve-screen-share",
    (targetId, callback) => {
      const room = getRoom(socket);
      const actor = getMember(socket);

      if (!room || !isModerator(actor)) {
        return fail(
          callback,
          "Permission denied"
        );
      }

      if (!room.shareRequests.has(targetId)) {
        return fail(
          callback,
          "Screen share request not found"
        );
      }

      if (
        room.activeSharer &&
        room.activeSharer !== targetId
      ) {
        return fail(
          callback,
          "Someone is already sharing"
        );
      }

      room.shareRequests.delete(targetId);

      // Approval is temporary and specific
      // to this participant and this room.
      room.shareGrants.set(
        targetId,
        Date.now() + 60000
      );

      io.to(targetId).emit(
        "screen-share-approved"
      );

      updateScreenRequests(room);
      success(callback);
    }
  );

  /* ========================================
     REJECT SCREEN SHARE
  ======================================== */

  socket.on(
    "reject-screen-share",
    (targetId, callback) => {
      const room = getRoom(socket);
      const actor = getMember(socket);

      if (!room || !isModerator(actor)) {
        return fail(
          callback,
          "Permission denied"
        );
      }

      if (!room.shareRequests.has(targetId)) {
        return fail(
          callback,
          "Request not found"
        );
      }

      room.shareRequests.delete(targetId);
      room.shareGrants.delete(targetId);

      io.to(targetId).emit(
        "screen-share-rejected"
      );

      updateScreenRequests(room);
      success(callback);
    }
  );

  /* ========================================
     SCREEN SHARING STATE
  ======================================== */

  socket.on(
    "screen-share-state",
    (data = {}, callback) => {
      const room = getRoom(socket);
      const member = getMember(socket);

      if (!room || !member) {
        return fail(
          callback,
          "Join a meeting first"
        );
      }

      if (typeof data.sharing !== "boolean") {
        return fail(
          callback,
          "Invalid screen share state"
        );
      }

      if (data.sharing) {
        if (
          room.activeSharer &&
          room.activeSharer !== socket.id
        ) {
          return fail(
            callback,
            "Someone is already sharing"
          );
        }

        const grantExpires =
          room.shareGrants.get(socket.id) || 0;

        if (
          !isModerator(member) &&
          grantExpires < Date.now() &&
          room.activeSharer !== socket.id
        ) {
          return fail(
            callback,
            "Screen sharing requires approval"
          );
        }

        room.activeSharer = socket.id;
        room.shareGrants.delete(socket.id);

        // All other requests are cleared
        // when someone begins sharing.
        for (const id of room.shareRequests) {
          io.to(id).emit("screen-share-rejected");
        }

        room.shareRequests.clear();
        room.shareGrants.clear();

        updateScreenRequests(room);
        updateScreenShare(room);

        return success(callback);
      }

      if (room.activeSharer !== socket.id) {
        return fail(
          callback,
          "You are not the screen sharer"
        );
      }

      room.activeSharer = null;

      updateScreenShare(room);
      success(callback);
    }
  );

  /* ========================================
     PUBLIC / PRIVATE CHAT + IMAGE
  ======================================== */

  socket.on("chat-message", (data = {}, callback) => {
    const room = getRoom(socket);
    const sender = getMember(socket);

    if (!room || !sender) {
      return fail(
        callback,
        "Join a meeting first"
      );
    }

    const messageText =
      typeof data.text === "string"
        ? data.text.trim()
        : "";

    if (messageText.length > MAX_MESSAGE_LENGTH) {
      return fail(
        callback,
        "Message cannot exceed 2000 characters"
      );
    }

    const imageResult = validateImage(data.image);

    if (!imageResult.ok) {
      return fail(callback, imageResult.error);
    }

    if (!messageText && !imageResult.image) {
      return fail(
        callback,
        "Message or image required"
      );
    }

    const to =
      data.to === "everyone"
        ? "everyone"
        : data.to;

    if (
      to !== "everyone" &&
      (
        typeof to !== "string" ||
        !room.members.has(to)
      )
    ) {
      return fail(
        callback,
        "Recipient is not in this meeting"
      );
    }

    const message = {
      id: crypto.randomUUID(),
      from: socket.id,
      fromName: sender.name,
      to,
      toName:
        to === "everyone"
          ? "Everyone"
          : room.members.get(to).name,
      text: messageText,
      image: imageResult.image,
      private: to !== "everyone",
      timestamp: Date.now()
    };

    if (to === "everyone") {
      io.to(room.id).emit(
        "chat-message",
        message
      );
    } else {
      io.to(socket.id).emit(
        "chat-message",
        message
      );

      if (to !== socket.id) {
        io.to(to).emit(
          "chat-message",
          message
        );
      }
    }

    success(callback, {
      id: message.id
    });
  });

  /* ========================================
     WEBRTC SIGNALING
  ======================================== */

  socket.on("signal", (data = {}) => {
    const room = getRoom(socket);

    if (
      !room ||
      !room.members.has(socket.id) ||
      !room.members.has(data.to) ||
      !["offer", "answer", "candidate"].includes(
        data.signal?.type
      )
    ) {
      return;
    }

    io.to(data.to).emit("signal", {
      from: socket.id,
      signal: data.signal
    });
  });

  /* ========================================
     PARTICIPANT MEDIA READY
  ======================================== */

  socket.on("media-ready", () => {
    const room = getRoom(socket);

    if (
      !room ||
      !room.members.has(socket.id)
    ) {
      return;
    }

    socket.to(room.id).emit(
      "peer-ready",
      { id: socket.id }
    );
  });

  /* ========================================
     LEAVE ROOM
  ======================================== */

  socket.on("leave-room", () => {
    leaveRoom(socket);
  });

  /* ========================================
     DISCONNECT
  ======================================== */

  socket.on("disconnect", () => {
    leaveRoom(socket);

    console.log(
      "Disconnected:",
      socket.id
    );
  });
});

/* ==========================================
   START SERVER
========================================== */

server.listen(PORT, () => {
  console.log(
    "MeetSpace server running at http://localhost:" +
    PORT
  );

  console.log(
    "Login: Firebase Google + Anonymous"
  );

  console.log(
    "Maximum participants:",
    MAX_PARTICIPANTS
  );

  console.log(
    "Meeting moderation and image chat enabled"
  );
});


/* ==========================================
   MEETSPACE - METERED TURN CONFIGURATION
========================================== */

const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];

let cachedIceServers = null;
let iceCacheExpiresAt = 0;
let pendingIceRequest = null;

async function getMeteredIceServers() {
  const domain = (process.env.METERED_DOMAIN || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  const apiKey = process.env.METERED_TURN_API_KEY;

  if (!domain || !apiKey) {
    return DEFAULT_ICE_SERVERS;
  }

  if (!/^[a-z0-9-]+\.metered\.live$/i.test(domain)) {
    throw new Error("Invalid Metered domain configuration");
  }

  if (cachedIceServers && Date.now() < iceCacheExpiresAt) {
    return cachedIceServers;
  }

  if (pendingIceRequest) {
    return pendingIceRequest;
  }

  pendingIceRequest = (async () => {
    const url = new URL(
      `https://${domain}/api/v1/turn/credentials`
    );

    url.searchParams.set("apiKey", apiKey);

    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
      throw new Error(
        `Metered returned HTTP ${response.status}`
      );
    }

    const servers = await response.json();

    if (
      !Array.isArray(servers) ||
      servers.length === 0 ||
      !servers.every(
        (server) =>
          server &&
          (typeof server.urls === "string" ||
            (Array.isArray(server.urls) &&
              server.urls.every(
                (url) => typeof url === "string"
              )))
      )
    ) {
      throw new Error("Invalid ICE server response");
    }

    cachedIceServers = servers;
    iceCacheExpiresAt = Date.now() + 5 * 60 * 1000;

    return servers;
  })();

  try {
    return await pendingIceRequest;
  } finally {
    pendingIceRequest = null;
  }
}

// Requires Firebase ID token.
// TURN API Key remains on the backend.
app.get("/api/ice-servers", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer (.+)$/);

  if (!match) {
    return res.status(401).json({
      error: "Authentication required"
    });
  }

  try {
    await firebaseAuth.verifyIdToken(match[1]);
  } catch {
    return res.status(401).json({
      error: "Invalid Firebase token"
    });
  }

  try {
    const iceServers = await getMeteredIceServers();

    return res.json({
      iceServers,
      source: cachedIceServers ? "metered" : "stun"
    });
  } catch (error) {
    console.error(
      "TURN configuration failed:",
      error.message
    );

    return res.json({
      iceServers: DEFAULT_ICE_SERVERS,
      source: "stun-fallback"
    });
  }
});

