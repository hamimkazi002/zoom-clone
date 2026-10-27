
require("dotenv").config();

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { OAuth2Client } = require("google-auth-library");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const googleClient = new OAuth2Client();

const PORT = Number(process.env.PORT) || 3000;
const DEV_LOGIN = process.env.DEV_LOGIN === "true";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const MAX_PARTICIPANTS = 10;
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
    if (member.role === "host" || member.role === "admin") {
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

  const wasMember = room.members.has(socket.id);

  room.members.delete(socket.id);
  room.waiting.delete(socket.id);

  socket.leave(room.id);
  socket.data.roomId = null;

  if (wasMember) {
    socket.to(room.id).emit(
      "user-left",
      socket.id
    );
  }

  if (room.members.size === 0) {
    for (const id of room.waiting.keys()) {
      io.to(id).emit("meeting-ended");
    }

    rooms.delete(room.id);
    return;
  }

  const hasHost = [...room.members.values()].some(
    user => user.role === "host"
  );

  if (!hasHost) {
    const nextHost =
      [...room.members.entries()].find(
        ([id, user]) => user.role === "admin"
      ) || room.members.entries().next().value;

    if (nextHost) {
      nextHost[1].role = "host";
      io.to(nextHost[0]).emit("role-updated", "host");
    }
  }

  updateParticipants(room);
  updateWaiting(room);
}

io.use(async (socket, next) => {
  try {
    const auth = socket.handshake.auth || {};

    if (DEV_LOGIN) {
      const name = String(
        auth.name || "Test User"
      ).trim().slice(0, 60);

      socket.data.user = {
        id: "dev-" + socket.id,
        name,
        email: null
      };

      return next();
    }

    if (!GOOGLE_CLIENT_ID || !auth.credential) {
      return next(
        new Error("Google login required")
      );
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: auth.credential,
      audience: GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();

    if (!payload?.sub || !payload?.email_verified) {
      return next(new Error("Invalid Google account"));
    }

    socket.data.user = {
      id: payload.sub,
      name: payload.name || payload.email,
      email: payload.email
    };

    next();

  } catch (error) {
    next(new Error("Authentication failed"));
  }
});

io.on("connection", socket => {
  console.log("Connected:", socket.data.user.name);

  socket.on("create-room", (data = {}, callback) => {
    if (socket.data.roomId) {
      return reply(callback, {
        ok: false,
        error: "Leave your current meeting first"
      });
    }

    const password = String(data.password || "");

    if (password.length < 4 || password.length > 64) {
      return reply(callback, {
        ok: false,
        error: "Password must be 4 to 64 characters"
      });
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

  socket.on("request-join", (data = {}, callback) => {
    if (socket.data.roomId) {
      return reply(callback, {
        ok: false,
        error: "Leave your current meeting first"
      });
    }

    const roomId = String(data.roomId || "").trim();
    const password = String(data.password || "");
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
      room.members.size + room.waiting.size >= MAX_PARTICIPANTS
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

    const waitingUser = room.waiting.get(targetId);

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

    const existingPeers = [...room.members.keys()];

    room.waiting.delete(targetId);

    room.members.set(targetId, {
      ...waitingUser,
      role: "participant"
    });

    const targetSocket = io.sockets.sockets.get(targetId);

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

    const targetSocket = io.sockets.sockets.get(targetId);

    if (targetSocket) {
      targetSocket.data.roomId = null;
    }

    io.to(targetId).emit("join-rejected");

    updateWaiting(room);

    reply(callback, { ok: true });
  });

  socket.on("assign-admin", (targetId, callback) => {
    const room = getRoom(socket);
    const actor = getMember(socket);
    const target = room?.members.get(targetId);

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

    io.to(targetId).emit("role-updated", "admin");

    updateParticipants(room);
    updateWaiting(room);

    reply(callback, { ok: true });
  });

  socket.on("transfer-host", (targetId, callback) => {
    const room = getRoom(socket);
    const actor = getMember(socket);
    const target = room?.members.get(targetId);

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

    io.to(socket.id).emit("role-updated", "admin");
    io.to(targetId).emit("role-updated", "host");

    updateParticipants(room);
    updateWaiting(room);

    reply(callback, { ok: true });
  });

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

  socket.on("leave-room", () => {
    leaveRoom(socket);
  });

  socket.on("disconnect", () => {
    leaveRoom(socket);

    console.log("Disconnected:", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(
    "Zoom Clone server running at http://localhost:" + PORT
  );
  console.log(
    "Login mode:",
    DEV_LOGIN ? "Development" : "Google"
  );
});
