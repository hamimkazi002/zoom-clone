
require("dotenv").config();

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;

if (!PROJECT_ID) {
  throw new Error(
    "Set FIREBASE_PROJECT_ID in .env / Render environment"
  );
}

// Firebase ID Token verification
const firebaseApp = getApps().length
  ? getApps()[0]
  : initializeApp({ projectId: PROJECT_ID });

const firebaseAuth = getAuth(firebaseApp);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT) || 3000;
const MAX_PARTICIPANTS = 10;
const MAX_MESSAGE_LENGTH = 2000;

const rooms = new Map();

app.use(express.static("public"));

app.get("/health", (req, res) => {
  res.json({
    status: "running",
    rooms: rooms.size
  });
});

function reply(callback, data) {
  if (typeof callback === "function") {
    callback(data);
  }
}

function getRoom(socket) {
  return rooms.get(socket.data.roomId);
}

function getMember(socket) {
  return getRoom(socket)?.members.get(socket.id);
}

function roomInfo(room) {
  return {
    roomId: room.id,
    participants: [...room.members.entries()].map(
      ([id, user]) => ({
        id,
        name: user.name,
        role: user.role
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
    if (
      member.role === "host" ||
      member.role === "admin"
    ) {
      io.to(id).emit("waiting-updated", waiting);
    }
  }
}

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

function leaveRoom(socket) {
  const room = getRoom(socket);

  if (!room) {
    socket.data.roomId = null;
    return;
  }

  const member = room.members.get(socket.id);

  // Host leaves: End the meeting for everyone
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
    rooms.delete(room.id);

    console.log("Meeting ended:", room.id);
    return;
  }

  // Participant or waiting user leaves
  const wasMember = room.members.delete(socket.id);

  room.waiting.delete(socket.id);

  socket.leave(room.id);
  socket.data.roomId = null;

  if (wasMember) {
    socket.to(room.id).emit(
      "user-left",
      socket.id
    );
  }

  updateParticipants(room);
  updateWaiting(room);
}

// Firebase Authentication Middleware
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

// Socket.IO Connection
io.on("connection", socket => {
  console.log(
    "Connected:",
    socket.data.user.name
  );

  // Create Meeting
  socket.on("create-room", (data = {}, callback) => {
    if (socket.data.roomId) {
      return reply(callback, {
        ok: false,
        error: "Leave your current meeting first"
      });
    }

    const password = String(
      data.password || ""
    );

    if (
      password.length < 4 ||
      password.length > 64
    ) {
      return reply(callback, {
        ok: false,
        error: "Password must be 4 to 64 characters"
      });
    }

    let roomId;

    do {
      roomId =
        crypto.randomBytes(5).toString("hex");
    } while (rooms.has(roomId));

    const salt = crypto.randomBytes(16);

    const room = {
      id: roomId,
      salt,
      passwordHash: hashPassword(password, salt),
      members: new Map(),
      waiting: new Map()
    };

    room.members.set(socket.id, {
      ...socket.data.user,
      role: "host"
    });

    rooms.set(roomId, room);

    socket.join(roomId);
    socket.data.roomId = roomId;

    reply(callback, {
      ok: true,
      roomId,
      role: "host",
      ...roomInfo(room)
    });

    updateParticipants(room);
  });

  // Request to Join Meeting
  socket.on("request-join", (data = {}, callback) => {
    if (socket.data.roomId) {
      return reply(callback, {
        ok: false,
        error: "Leave your current meeting first"
      });
    }

    const roomId = String(
      data.roomId || ""
    ).trim();

    const password = String(
      data.password || ""
    );

    const room = rooms.get(roomId);

    if (!room) {
      return reply(callback, {
        ok: false,
        error: "Meeting not found"
      });
    }

    if (!verifyPassword(password, room)) {
      return reply(callback, {
        ok: false,
        error: "Incorrect meeting password"
      });
    }

    if (
      room.members.size + room.waiting.size >=
      MAX_PARTICIPANTS
    ) {
      return reply(callback, {
        ok: false,
        error: "Meeting is full"
      });
    }

    room.waiting.set(socket.id, {
      ...socket.data.user
    });

    socket.data.roomId = roomId;

    reply(callback, {
      ok: true,
      status: "waiting"
    });

    updateWaiting(room);
  });

  // Approve Participant
  socket.on("approve-request", (targetId, callback) => {
    const room = getRoom(socket);
    const actor = getMember(socket);

    if (
      !room ||
      !actor ||
      !["host", "admin"].includes(actor.role)
    ) {
      return reply(callback, {
        ok: false,
        error: "Permission denied"
      });
    }

    const waitingUser =
      room.waiting.get(targetId);

    if (!waitingUser) {
      return reply(callback, {
        ok: false,
        error: "Request not found"
      });
    }

    if (room.members.size >= MAX_PARTICIPANTS) {
      return reply(callback, {
        ok: false,
        error: "Meeting is full"
      });
    }

    const existingPeers = [
      ...room.members.keys()
    ];

    room.waiting.delete(targetId);

    room.members.set(targetId, {
      ...waitingUser,
      role: "participant"
    });

    const targetSocket =
      io.sockets.sockets.get(targetId);

    if (!targetSocket) {
      room.members.delete(targetId);

      updateWaiting(room);

      return reply(callback, {
        ok: false,
        error: "User disconnected"
      });
    }

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

    reply(callback, { ok: true });
  });

  // Reject Participant
  socket.on("reject-request", (targetId, callback) => {
    const room = getRoom(socket);
    const actor = getMember(socket);

    if (
      !room ||
      !actor ||
      !["host", "admin"].includes(actor.role)
    ) {
      return reply(callback, {
        ok: false,
        error: "Permission denied"
      });
    }

    if (!room.waiting.has(targetId)) {
      return reply(callback, {
        ok: false,
        error: "Request not found"
      });
    }

    room.waiting.delete(targetId);

    const targetSocket =
      io.sockets.sockets.get(targetId);

    if (targetSocket) {
      targetSocket.data.roomId = null;
    }

    io.to(targetId).emit("join-rejected");

    updateWaiting(room);

    reply(callback, { ok: true });
  });

  // Assign Admin
  socket.on("assign-admin", (targetId, callback) => {
    const room = getRoom(socket);
    const actor = getMember(socket);

    const target =
      room?.members.get(targetId);

    if (
      !actor ||
      actor.role !== "host" ||
      !target ||
      target.role === "host"
    ) {
      return reply(callback, {
        ok: false,
        error: "Permission denied"
      });
    }

    target.role = "admin";

    io.to(targetId).emit(
      "role-updated",
      "admin"
    );

    updateParticipants(room);
    updateWaiting(room);

    reply(callback, { ok: true });
  });

  // Transfer Host
  socket.on("transfer-host", (targetId, callback) => {
    const room = getRoom(socket);
    const actor = getMember(socket);

    const target =
      room?.members.get(targetId);

    if (
      !actor ||
      actor.role !== "host" ||
      !target ||
      targetId === socket.id
    ) {
      return reply(callback, {
        ok: false,
        error: "Permission denied"
      });
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

    reply(callback, { ok: true });
  });

  // Public + Private Meeting Chat
  socket.on("chat-message", (data = {}, callback) => {
    const room = getRoom(socket);
    const sender = getMember(socket);

    if (!room || !sender) {
      return reply(callback, {
        ok: false,
        error: "Join a meeting first"
      });
    }

    const text =
      typeof data.text === "string"
        ? data.text.trim()
        : "";

    if (
      !text ||
      text.length > MAX_MESSAGE_LENGTH
    ) {
      return reply(callback, {
        ok: false,
        error: "Message must be 1 to 2000 characters"
      });
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
      return reply(callback, {
        ok: false,
        error: "Recipient is not in this meeting"
      });
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
      text,
      private: to !== "everyone",
      timestamp: Date.now()
    };

    if (to === "everyone") {
      // Public message: Everyone in meeting
      io.to(room.id).emit(
        "chat-message",
        message
      );

    } else {
      // Private message: Sender and Receiver only
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

    reply(callback, {
      ok: true,
      id: message.id
    });
  });

  // WebRTC Signaling
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

  // Leave Meeting
  socket.on("leave-room", () => {
    leaveRoom(socket);
  });

  // Disconnect
  socket.on("disconnect", () => {
    leaveRoom(socket);

    console.log(
      "Disconnected:",
      socket.id
    );
  });
});

// Start Server
server.listen(PORT, () => {
  console.log(
    "MeetSpace server running at http://localhost:" +
    PORT
  );

  console.log(
    "Login mode: Firebase Google + Anonymous"
  );
});
