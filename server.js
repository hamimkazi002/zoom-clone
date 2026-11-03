
/* ==========================================
   MEETSPACE FINAL SERVER
   PART 1 OF 3
   Firebase, Rooms, Password, Waiting Room
========================================== */

require("dotenv").config();

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");
const {
  initializeApp,
  getApps
} = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID;

if (!PROJECT_ID) {
  throw new Error(
    "FIREBASE_PROJECT_ID is required"
  );
}

const firebaseApp = getApps().length
  ? getApps()[0]
  : initializeApp({
      projectId: PROJECT_ID
    });

const firebaseAuth = getAuth(firebaseApp);

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 3.5 * 1024 * 1024
});

const PORT =
  Number(process.env.PORT) || 3000;

const MAX_PARTICIPANTS = 10;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const rooms = new Map();

app.use(express.static("public"));

app.get("/health", (req, res) => {
  res.json({
    status: "running",
    rooms: rooms.size,
    maxParticipants: MAX_PARTICIPANTS
  });
});

/* ==========================================
   SERVER RESPONSE HELPERS
========================================== */

function respond(callback, data) {
  if (typeof callback === "function") {
    callback(data);
  }
}

function success(callback, data = {}) {
  respond(callback, {
    ok: true,
    ...data
  });
}

function fail(callback, error) {
  respond(callback, {
    ok: false,
    error
  });
}

function getRoom(socket) {
  return rooms.get(
    socket.data.roomId
  );
}

function getMember(socket) {
  return getRoom(socket)
    ?.members.get(socket.id);
}

function isHost(member) {
  return member?.role === "host";
}

/* ==========================================
   MEETING PERMISSIONS
========================================== */

function defaultSettings() {
  return {
    mic: true,
    camera: true,
    share: false,
    chat: true,
    hand: true,
    approval: true,
    autoEnd: true
  };
}

function validateSettings(input = {}) {
  const defaults = defaultSettings();
  const settings = {};

  for (const key of Object.keys(defaults)) {
    settings[key] =
      typeof input[key] === "boolean"
        ? input[key]
        : defaults[key];
  }

  return settings;
}

/* ==========================================
   SECURE MEETING PASSWORD
========================================== */

function hashPassword(password, salt) {
  return crypto.scryptSync(
    password,
    salt,
    64
  );
}

function verifyPassword(password, room) {
  const actual = hashPassword(
    password,
    room.salt
  );

  return crypto.timingSafeEqual(
    actual,
    room.passwordHash
  );
}

/* ==========================================
   PARTICIPANTS AND ROOM DETAILS
========================================== */

function participantList(room) {
  return [
    ...room.members.entries()
  ].map(([id, member]) => ({
    id,
    name: member.name,
    role: member.role,
    micEnabled:
      member.micEnabled ?? true,
    videoEnabled:
      member.videoEnabled ?? true,
    raisedHand:
      room.raisedHands.has(id)
  }));
}

function roomInfo(room) {
  return {
    roomId: room.id,
    participants: participantList(room),
    settings: room.settings,
    startsAt: room.startsAt,
    endsAt: room.endsAt,
    maxParticipants: MAX_PARTICIPANTS
  };
}

function updateParticipants(room) {
  io.to(room.id).emit(
    "participants-updated",
    roomInfo(room)
  );
}

function updateWaiting(room) {
  const waiting = [
    ...room.waiting.entries()
  ].map(([id, user]) => ({
    id,
    name: user.name
  }));

  for (const [id, member] of room.members) {
    if (isHost(member)) {
      io.to(id).emit(
        "waiting-updated",
        waiting
      );
    }
  }
}

function updateHands(room) {
  io.to(room.id).emit(
    "hands-updated",
    {
      ids: [
        ...room.raisedHands
      ]
    }
  );
}

function updateScreenShare(room) {
  io.to(room.id).emit(
    "screen-share-updated",
    {
      id: room.activeSharer,
      sharing: Boolean(
        room.activeSharer
      )
    }
  );
}

function updateScreenRequests(room) {
  const requests = [
    ...room.shareRequests
  ].map(id => ({
    id,
    name:
      room.members.get(id)?.name ||
      "Participant"
  }));

  for (const [id, member] of room.members) {
    if (isHost(member)) {
      io.to(id).emit(
        "screen-share-requests-updated",
        requests
      );
    }
  }
}

function sendSettings(room) {
  io.to(room.id).emit(
    "meeting-settings-updated",
    {
      settings: room.settings,
      startsAt: room.startsAt,
      endsAt: room.endsAt
    }
  );
}

/* ==========================================
   MEETING END / AUTOMATIC TIMER
========================================== */

function endMeeting(
  room,
  reason = "Meeting ended"
) {
  if (!rooms.has(room.id)) return;

  if (room.endTimer) {
    clearTimeout(room.endTimer);
  }

  const users = [
    ...room.members.keys(),
    ...room.waiting.keys()
  ];

  for (const id of users) {
    io.to(id).emit(
      "meeting-ended",
      { reason }
    );

    const client =
      io.sockets.sockets.get(id);

    if (client) {
      client.leave(room.id);
      client.data.roomId = null;
    }
  }

  room.members.clear();
  room.waiting.clear();
  room.raisedHands.clear();
  room.shareRequests.clear();
  room.shareGrants.clear();

  rooms.delete(room.id);
}

function scheduleAutomaticEnd(room) {
  if (room.endTimer) {
    clearTimeout(room.endTimer);
    room.endTimer = null;
  }

  if (
    !room.settings.autoEnd ||
    !room.endsAt
  ) return;

  const remaining =
    room.endsAt - Date.now();

  if (remaining <= 0) {
    endMeeting(
      room,
      "Meeting time has expired"
    );

    return;
  }

  // Avoid overflowing Node.js timers.

  const safeDelay = Math.min(
    remaining,
    2147483647
  );

  room.endTimer = setTimeout(() => {
    scheduleAutomaticEnd(room);
  }, safeDelay);

  room.endTimer.unref?.();
}

/* ==========================================
   LEAVE ROOM / DISCONNECT CLEANUP
========================================== */

function leaveRoom(socket) {
  const room = getRoom(socket);

  if (!room) {
    socket.data.roomId = null;
    return;
  }

  const member =
    room.members.get(socket.id);

  if (isHost(member)) {
    endMeeting(
      room,
      "Host ended the meeting"
    );
    return;
  }

  const wasMember =
    room.members.delete(socket.id);

  room.waiting.delete(socket.id);
  room.raisedHands.delete(socket.id);
  room.shareRequests.delete(socket.id);
  room.shareGrants.delete(socket.id);

  if (
    room.activeSharer === socket.id
  ) {
    room.activeSharer = null;
    updateScreenShare(room);
  }

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
  updateHands(room);
  updateScreenRequests(room);
}

/* ==========================================
   VALIDATE CHAT IMAGE CONTENT
========================================== */

function validateImage(value) {
  if (
    value == null ||
    value === ""
  ) {
    return {
      ok: true,
      image: null
    };
  }

  if (typeof value !== "string") {
    return {
      ok: false,
      error: "Invalid image"
    };
  }

  const match = value.match(
    /^data:image\/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/
  );

  if (!match) {
    return {
      ok: false,
      error:
        "Only JPG, PNG, WEBP and GIF are supported"
    };
  }

  const buffer = Buffer.from(
    match[2],
    "base64"
  );

  if (
    buffer.length === 0 ||
    buffer.length > MAX_IMAGE_BYTES ||
    buffer.toString("base64") !== match[2]
  ) {
    return {
      ok: false,
      error:
        "Invalid image or image exceeds 2 MB"
    };
  }

  const type = match[1];

  const valid =
    type === "jpeg"
      ? buffer.length >= 3 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff
      : type === "png"
        ? buffer.subarray(0, 8).equals(
            Buffer.from(
              "89504e470d0a1a0a",
              "hex"
            )
          )
        : type === "gif"
          ? [
              "GIF87a",
              "GIF89a"
            ].includes(
              buffer
                .subarray(0, 6)
                .toString("ascii")
            )
          : buffer.length >= 12 &&
            buffer.toString(
              "ascii",
              0,
              4
            ) === "RIFF" &&
            buffer.toString(
              "ascii",
              8,
              12
            ) === "WEBP";

  return valid
    ? {
        ok: true,
        image: value
      }
    : {
        ok: false,
        error: "Image content is invalid"
      };
}

/* ==========================================
   FIREBASE SOCKET AUTHENTICATION
========================================== */

io.use(async (socket, next) => {
  try {
    const credential =
      socket.handshake.auth?.credential;

    if (
      !credential ||
      typeof credential !== "string"
    ) {
      return next(
        new Error(
          "Firebase login required"
        )
      );
    }

    const claims =
      await firebaseAuth.verifyIdToken(
        credential
      );

    if (!claims.uid) {
      return next(
        new Error(
          "Invalid Firebase account"
        )
      );
    }

    const isGuest =
      claims.firebase?.sign_in_provider ===
      "anonymous";

    const guestName =
      String(
        socket.handshake.auth?.name ||
        "Guest"
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
      new Error(
        "Firebase authentication failed"
      )
    );
  }
});

/* ==========================================
   ADMIT WAITING PARTICIPANT
========================================== */

function admitWaitingMember(
  room,
  targetId
) {
  const waitingUser =
    room.waiting.get(targetId);

  if (!waitingUser) {
    return {
      ok: false,
      error: "Request not found"
    };
  }

  if (
    room.members.size >= MAX_PARTICIPANTS
  ) {
    return {
      ok: false,
      error: "Meeting is full"
    };
  }

  const targetSocket =
    io.sockets.sockets.get(targetId);

  if (
    !targetSocket ||
    targetSocket.data.roomId !== room.id
  ) {
    room.waiting.delete(targetId);
    updateWaiting(room);

    return {
      ok: false,
      error: "Participant disconnected"
    };
  }

  const existingPeers = [
    ...room.members.keys()
  ];

  room.waiting.delete(targetId);

  room.members.set(targetId, {
    ...waitingUser,
    role: "participant",
    micEnabled: room.settings.mic,
    videoEnabled: room.settings.camera
  });

  targetSocket.join(room.id);

  io.to(targetId).emit(
    "join-approved",
    {
      ...roomInfo(room),
      role: "participant",
      peers: existingPeers
    }
  );

  targetSocket.to(room.id).emit(
    "user-joined",
    targetId
  );

  updateParticipants(room);
  updateWaiting(room);
  updateHands(room);
  updateScreenShare(room);

  return { ok: true };
}

/* END OF PART 1
   CONTINUE PART 2 IN THE SAME FILE */

/* ==========================================
   MEETSPACE FINAL SERVER
   PART 2 OF 3
   MEETING EVENTS AND HOST CONTROLS
========================================== */

io.on("connection", socket => {
  console.log(
    "Connected:",
    socket.data.user.name,
    socket.id
  );

  /* ========================================
     CREATE ROOM
  ======================================== */

  socket.on(
    "create-room",
    (data = {}, callback) => {
      if (socket.data.roomId) {
        return fail(
          callback,
          "Leave your current meeting first"
        );
      }

      const password =
        typeof data?.password === "string"
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

      const settings =
        validateSettings(data.settings);

      const now = Date.now();
      const requestedStart =
        Number(data.startsAt);

      const startsAt =
        Number.isFinite(requestedStart) &&
        requestedStart > now
          ? requestedStart
          : now;

      const duration =
        Number(data.durationMinutes || 60);

      if (
        !Number.isInteger(duration) ||
        duration < 5 ||
        duration > 1440
      ) {
        return fail(
          callback,
          "Duration must be 5 to 1440 minutes"
        );
      }

      const endsAt =
        startsAt +
        duration * 60 * 1000;

      let roomId;

      do {
        roomId = crypto
          .randomBytes(5)
          .toString("hex");
      } while (rooms.has(roomId));

      const salt = crypto.randomBytes(16);

      const room = {
        id: roomId,
        salt,
        passwordHash:
          hashPassword(password, salt),
        settings,
        startsAt,
        endsAt,
        endTimer: null,
        members: new Map(),
        waiting: new Map(),
        raisedHands: new Set(),
        shareRequests: new Set(),
        shareGrants: new Map(),
        activeSharer: null
      };

      room.members.set(socket.id, {
        ...socket.data.user,
        role: "host",
        micEnabled: true,
        videoEnabled: true
      });

      rooms.set(roomId, room);

      socket.join(roomId);
      socket.data.roomId = roomId;

      scheduleAutomaticEnd(room);

      success(callback, {
        ...roomInfo(room),
        role: "host"
      });

      updateParticipants(room);
      updateHands(room);
    }
  );

  /* ========================================
     REQUEST TO JOIN
  ======================================== */

  socket.on(
    "request-join",
    (data = {}, callback) => {
      if (socket.data.roomId) {
        return fail(
          callback,
          "Leave your current meeting first"
        );
      }

      const roomId =
        typeof data?.roomId === "string"
          ? data.roomId.trim()
          : "";

      const password =
        typeof data?.password === "string"
          ? data.password
          : "";

      const room = rooms.get(roomId);

      if (!room) {
        return fail(
          callback,
          "Meeting not found"
        );
      }

      if (!verifyPassword(password, room)) {
        return fail(
          callback,
          "Incorrect meeting password"
        );
      }

      if (Date.now() < room.startsAt) {
        return fail(
          callback,
          "Meeting has not started yet"
        );
      }

      if (
        Date.now() >= room.endsAt &&
        room.settings.autoEnd
      ) {
        endMeeting(
          room,
          "Meeting time has expired"
        );

        return fail(
          callback,
          "Meeting has ended"
        );
      }

      if (
        room.members.size +
          room.waiting.size >=
        MAX_PARTICIPANTS
      ) {
        return fail(
          callback,
          "Meeting is full (maximum 10)"
        );
      }

      room.waiting.set(socket.id, {
        ...socket.data.user
      });

      socket.data.roomId = roomId;

      // Waiting room OFF = Direct Join.

      if (!room.settings.approval) {
        const admitted =
          admitWaitingMember(
            room,
            socket.id
          );

        if (!admitted.ok) {
          return fail(
            callback,
            admitted.error
          );
        }

        return success(callback, {
          status: "approved"
        });
      }

      success(callback, {
        status: "waiting"
      });

      updateWaiting(room);
    }
  );

  /* ========================================
     HOST APPROVES JOIN REQUEST
  ======================================== */

  socket.on(
    "approve-request",
    (targetId, callback) => {
      const room = getRoom(socket);

      if (
        !room ||
        !isHost(getMember(socket))
      ) {
        return fail(
          callback,
          "Host permission required"
        );
      }

      const admitted =
        admitWaitingMember(
          room,
          targetId
        );

      if (!admitted.ok) {
        return fail(
          callback,
          admitted.error
        );
      }

      success(callback);
    }
  );

  /* ========================================
     HOST REJECTS JOIN REQUEST
  ======================================== */

  socket.on(
    "reject-request",
    (targetId, callback) => {
      const room = getRoom(socket);

      if (
        !room ||
        !isHost(getMember(socket))
      ) {
        return fail(
          callback,
          "Host permission required"
        );
      }

      if (!room.waiting.has(targetId)) {
        return fail(
          callback,
          "Request not found"
        );
      }

      room.waiting.delete(targetId);

      const targetSocket =
        io.sockets.sockets.get(targetId);

      if (targetSocket) {
        targetSocket.data.roomId = null;
      }

      io.to(targetId).emit(
        "join-rejected",
        {
          message:
            "The host declined your join request"
        }
      );

      updateWaiting(room);
      success(callback);
    }
  );

  /* ========================================
     CHANGE HOST SETTINGS LIVE
  ======================================== */

  socket.on(
    "update-meeting-settings",
    (data = {}, callback) => {
      const room = getRoom(socket);

      if (
        !room ||
        !isHost(getMember(socket))
      ) {
        return fail(
          callback,
          "Host permission required"
        );
      }

      room.settings =
        validateSettings({
          ...room.settings,
          ...data
        });

      scheduleAutomaticEnd(room);

      // When waiting room is disabled,
      // admit pending guests up to 10 people.

      if (!room.settings.approval) {
        for (const id of [
          ...room.waiting.keys()
        ]) {
          if (
            room.members.size >=
            MAX_PARTICIPANTS
          ) break;

          admitWaitingMember(room, id);
        }
      }

      sendSettings(room);

      success(callback, {
        settings: room.settings
      });
    }
  );

  /* ========================================
     ADD / REDUCE MEETING TIME
     SERVER TIME IS AUTHORITATIVE
  ======================================== */

  function adjustMeetingTime(
    data = {},
    callback,
    positiveOnly = false
  ) {
    const room = getRoom(socket);

    if (
      !room ||
      !isHost(getMember(socket))
    ) {
      return fail(
        callback,
        "Host permission required"
      );
    }

    const minutes = data?.minutes;

    // Positive number = Add minutes.
    // Negative number = Reduce minutes.

    if (
      !Number.isInteger(minutes) ||
      minutes === 0 ||
      Math.abs(minutes) > 1440 ||
      (positiveOnly && minutes < 0)
    ) {
      return fail(
        callback,
        "Choose 1–1440 whole minutes to add or reduce"
      );
    }

    const nextEnd =
      room.endsAt +
      minutes * 60000;

    const remainingMs =
      nextEnd - Date.now();

    // Prevent accidental immediate ending.

    if (remainingMs < 60000) {
      return fail(
        callback,
        "At least one minute must remain"
      );
    }

    if (
      remainingMs >
      14 * 24 * 60 * 60 * 1000
    ) {
      return fail(
        callback,
        "Maximum remaining time is 14 days"
      );
    }

    room.endsAt = nextEnd;

    scheduleAutomaticEnd(room);

    const payload = {
      minutes,
      startsAt: room.startsAt,
      endsAt: room.endsAt,
      by: socket.data.user.name
    };

    // Broadcast to all participants.

    io.to(room.id).emit(
      "meeting-time-adjusted",
      payload
    );

    sendSettings(room);

    // Backward-compatible old event.

    if (minutes > 0) {
      io.to(room.id).emit(
        "meeting-extended",
        payload
      );
    }

    // Required ACK — browser receives
    // { ok: true, endsAt: ... }

    success(callback, payload);

    console.log(
      `Meeting ${room.id}: ` +
      `${minutes > 0 ? "+" : ""}${minutes} minute(s)`
    );
  }

  socket.on(
    "adjust-meeting-time",
    (data = {}, callback) => {
      adjustMeetingTime(
        data,
        callback
      );
    }
  );

  // Support existing old JS clients.

  socket.on(
    "extend-meeting",
    (data = {}, callback) => {
      adjustMeetingTime(
        data,
        callback,
        true
      );
    }
  );

  /* ========================================
     RAISE / LOWER HAND
  ======================================== */

  socket.on(
    "raise-hand",
    (data = {}, callback) => {
      const room = getRoom(socket);
      const member = getMember(socket);

      if (!room || !member) {
        return fail(
          callback,
          "Join a meeting first"
        );
      }

      if (
        !isHost(member) &&
        !room.settings.hand
      ) {
        return fail(
          callback,
          "Raise hand disabled by host"
        );
      }

      if (
        typeof data.raised !== "boolean"
      ) {
        return fail(
          callback,
          "Invalid hand status"
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
        raised: data.raised
      });
    }
  );

  /* ========================================
     HOST MUTES PARTICIPANT
  ======================================== */

  socket.on(
    "mute-participant",
    (targetId, callback) => {
      const room = getRoom(socket);

      if (
        !room ||
        !isHost(getMember(socket)) ||
        !room.members.has(targetId) ||
        targetId === socket.id
      ) {
        return fail(
          callback,
          "Permission denied"
        );
      }

      const target =
        room.members.get(targetId);

      target.micEnabled = false;

      io.to(targetId).emit(
        "force-mute",
        {
          by: socket.data.user.name
        }
      );

      updateParticipants(room);
      success(callback);
    }
  );

  /* ========================================
     HOST STOPS PARTICIPANT CAMERA
  ======================================== */

  socket.on(
    "stop-participant-video",
    (targetId, callback) => {
      const room = getRoom(socket);

      if (
        !room ||
        !isHost(getMember(socket)) ||
        !room.members.has(targetId) ||
        targetId === socket.id
      ) {
        return fail(
          callback,
          "Permission denied"
        );
      }

      room.members.get(
        targetId
      ).videoEnabled = false;

      io.to(targetId).emit(
        "force-video-off",
        {
          by: socket.data.user.name
        }
      );

      updateParticipants(room);
      success(callback);
    }
  );

  /* ========================================
     ASK USER TO UNMUTE (WITH CONSENT)
  ======================================== */

  socket.on(
    "ask-participant-unmute",
    (targetId, callback) => {
      const room = getRoom(socket);

      if (
        !room ||
        !isHost(getMember(socket)) ||
        !room.members.has(targetId)
      ) {
        return fail(
          callback,
          "Permission denied"
        );
      }

      io.to(targetId).emit(
        "request-unmute"
      );

      success(callback);
    }
  );

  /* ========================================
     ASK USER TO START CAMERA
  ======================================== */

  socket.on(
    "ask-participant-video",
    (targetId, callback) => {
      const room = getRoom(socket);

      if (
        !room ||
        !isHost(getMember(socket)) ||
        !room.members.has(targetId)
      ) {
        return fail(
          callback,
          "Permission denied"
        );
      }

      io.to(targetId).emit(
        "request-video-on"
      );

      success(callback);
    }
  );

  /* ========================================
     PARTICIPANT MEDIA STATE
  ======================================== */

  socket.on(
    "media-state",
    data => {
      const room = getRoom(socket);
      const member = getMember(socket);

      if (!room || !member) return;

      if (
        typeof data.micEnabled !==
          "boolean" ||
        typeof data.videoEnabled !==
          "boolean"
      ) {
        return;
      }

      member.micEnabled =
        isHost(member) ||
        room.settings.mic
          ? data.micEnabled
          : false;

      member.videoEnabled =
        isHost(member) ||
        room.settings.camera
          ? data.videoEnabled
          : false;

      io.to(room.id).emit(
        "participant-media-updated",
        {
          id: socket.id,
          micEnabled: member.micEnabled,
          videoEnabled: member.videoEnabled
        }
      );

      updateParticipants(room);
    }
  );

  /* ========================================
     PARTICIPANT REQUESTS SCREEN SHARE
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

      if (
        isHost(member) ||
        room.settings.share
      ) {
        return fail(
          callback,
          "You can share directly"
        );
      }

      if (room.activeSharer) {
        return fail(
          callback,
          "Someone is already sharing"
        );
      }

      if (
        room.shareRequests.has(socket.id)
      ) {
        return fail(
          callback,
          "Request already pending"
        );
      }

      room.shareRequests.add(socket.id);

      updateScreenRequests(room);
      success(callback);
    }
  );

  /* ========================================
     HOST APPROVES SCREEN SHARE
  ======================================== */

  socket.on(
    "approve-screen-share",
    (targetId, callback) => {
      const room = getRoom(socket);

      if (
        !room ||
        !isHost(getMember(socket))
      ) {
        return fail(
          callback,
          "Host permission required"
        );
      }

      if (
        !room.shareRequests.has(targetId)
      ) {
        return fail(
          callback,
          "Screen share request not found"
        );
      }

      if (room.activeSharer) {
        return fail(
          callback,
          "Someone is already sharing"
        );
      }

      room.shareRequests.delete(targetId);

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

  /* END OF PART 2
     PART 3 CONTINUES INSIDE
     THE SAME io.on("connection") BLOCK */

/* ==========================================
   MEETSPACE FINAL SERVER
   PART 3 OF 3
   SCREEN SHARE, CHAT, WEBRTC, TURN
========================================== */

  /* ========================================
     REJECT SCREEN SHARE
  ======================================== */

  socket.on(
    "reject-screen-share",
    (targetId, callback) => {
      const room = getRoom(socket);

      if (
        !room ||
        !isHost(getMember(socket))
      ) {
        return fail(
          callback,
          "Host permission required"
        );
      }

      if (
        !room.shareRequests.has(targetId)
      ) {
        return fail(
          callback,
          "Request not found"
        );
      }

      room.shareRequests.delete(targetId);
      room.shareGrants.delete(targetId);

      io.to(targetId).emit(
        "screen-share-rejected",
        {
          message:
            "The host declined your screen sharing request"
        }
      );

      updateScreenRequests(room);
      success(callback);
    }
  );

  /* ========================================
     SCREEN SHARE STATE
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

      if (
        typeof data.sharing !== "boolean"
      ) {
        return fail(
          callback,
          "Invalid sharing state"
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

        const grantExpiry =
          room.shareGrants.get(
            socket.id
          ) || 0;

        if (
          !isHost(member) &&
          !room.settings.share &&
          grantExpiry < Date.now()
        ) {
          return fail(
            callback,
            "Screen sharing requires approval"
          );
        }

        room.activeSharer = socket.id;

        room.shareGrants.delete(
          socket.id
        );

        // Clear other pending share requests.

        for (
          const id of room.shareRequests
        ) {
          io.to(id).emit(
            "screen-share-rejected",
            {
              message:
                "Another participant started sharing"
            }
          );
        }

        room.shareRequests.clear();
        room.shareGrants.clear();

        updateScreenRequests(room);
        updateScreenShare(room);

        return success(callback);
      }

      // Stop sharing.

      if (
        room.activeSharer !== socket.id
      ) {
        return fail(
          callback,
          "You are not sharing"
        );
      }

      room.activeSharer = null;

      updateScreenShare(room);
      success(callback);
    }
  );

  /* ========================================
     PUBLIC / PRIVATE CHAT + IMAGES
  ======================================== */

  socket.on(
    "chat-message",
    (data = {}, callback) => {
      const room = getRoom(socket);
      const sender = getMember(socket);

      if (!room || !sender) {
        return fail(
          callback,
          "Join a meeting first"
        );
      }

      if (
        !isHost(sender) &&
        !room.settings.chat
      ) {
        return fail(
          callback,
          "Chat disabled by host"
        );
      }

      const text =
        typeof data.text === "string"
          ? data.text.trim()
          : "";

      if (
        text.length > MAX_MESSAGE_LENGTH
      ) {
        return fail(
          callback,
          "Message exceeds 2000 characters"
        );
      }

      const imageResult =
        validateImage(data.image);

      if (!imageResult.ok) {
        return fail(
          callback,
          imageResult.error
        );
      }

      if (
        !text &&
        !imageResult.image
      ) {
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
          "Recipient not found"
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
        text,
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
    }
  );

  /* ========================================
     WEBRTC SIGNALING
  ======================================== */

  socket.on(
    "signal",
    (data = {}) => {
      const room = getRoom(socket);

      if (
        !room ||
        !room.members.has(socket.id) ||
        !room.members.has(data.to) ||
        ![
          "offer",
          "answer",
          "candidate"
        ].includes(
          data.signal?.type
        )
      ) {
        return;
      }

      io.to(data.to).emit(
        "signal",
        {
          from: socket.id,
          signal: data.signal
        }
      );
    }
  );

  /* ========================================
     PARTICIPANT MEDIA READY
  ======================================== */

  socket.on(
    "media-ready",
    () => {
      const room = getRoom(socket);

      if (
        !room ||
        !room.members.has(socket.id)
      ) {
        return;
      }

      socket.to(room.id).emit(
        "peer-ready",
        {
          id: socket.id
        }
      );
    }
  );

  /* ========================================
     LEAVE ROOM
  ======================================== */

  socket.on(
    "leave-room",
    () => {
      leaveRoom(socket);
    }
  );

  /* ========================================
     DISCONNECT
  ======================================== */

  socket.on(
    "disconnect",
    () => {
      leaveRoom(socket);

      console.log(
        "Disconnected:",
        socket.id
      );
    }
  );

}); // END io.on("connection")

/* ==========================================
   METERED TURN CONFIGURATION
========================================== */

const DEFAULT_ICE_SERVERS = [
  {
    urls:
      "stun:stun.l.google.com:19302"
  },
  {
    urls:
      "stun:stun1.l.google.com:19302"
  }
];

let cachedIceServers = null;
let iceCacheExpiresAt = 0;
let pendingIceRequest = null;

async function getMeteredIceServers() {
  const domain = (
    process.env.METERED_DOMAIN || ""
  )
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  const apiKey =
    process.env.METERED_TURN_API_KEY;

  if (!domain || !apiKey) {
    return DEFAULT_ICE_SERVERS;
  }

  if (
    !/^[a-z0-9-]+\.metered\.live$/i
      .test(domain)
  ) {
    throw new Error(
      "Invalid Metered domain"
    );
  }

  if (
    cachedIceServers &&
    Date.now() < iceCacheExpiresAt
  ) {
    return cachedIceServers;
  }

  if (pendingIceRequest) {
    return pendingIceRequest;
  }

  pendingIceRequest = (async () => {
    const url = new URL(
      `https://${domain}/api/v1/turn/credentials`
    );

    url.searchParams.set(
      "apiKey",
      apiKey
    );

    const response = await fetch(url, {
      signal:
        AbortSignal.timeout(8000)
    });

    if (!response.ok) {
      throw new Error(
        `Metered returned HTTP ${response.status}`
      );
    }

    const servers =
      await response.json();

    if (
      !Array.isArray(servers) ||
      servers.length === 0 ||
      !servers.every(
        item =>
          item &&
          (
            typeof item.urls ===
            "string" ||
            (
              Array.isArray(item.urls) &&
              item.urls.every(
                url =>
                  typeof url ===
                  "string"
              )
            )
          )
      )
    ) {
      throw new Error(
        "Invalid ICE configuration"
      );
    }

    cachedIceServers = servers;

    iceCacheExpiresAt =
      Date.now() +
      5 * 60 * 1000;

    return servers;
  })();

  try {
    return await pendingIceRequest;
  } finally {
    pendingIceRequest = null;
  }
}

/* ==========================================
   TURN API — AUTHENTICATED USERS ONLY
========================================== */

app.get(
  "/api/ice-servers",
  async (req, res) => {
    res.set(
      "Cache-Control",
      "no-store"
    );

    const authorization =
      req.headers.authorization || "";

    const match =
      authorization.match(
        /^Bearer (.+)$/
      );

    if (!match) {
      return res.status(401).json({
        error:
          "Authentication required"
      });
    }

    try {
      await firebaseAuth.verifyIdToken(
        match[1]
      );
    } catch {
      return res.status(401).json({
        error:
          "Invalid Firebase token"
      });
    }

    try {
      const iceServers =
        await getMeteredIceServers();

      return res.json({
        iceServers,
        source: cachedIceServers
          ? "metered"
          : "stun"
      });
    } catch (error) {
      console.error(
        "TURN configuration failed:",
        error.message
      );

      return res.json({
        iceServers:
          DEFAULT_ICE_SERVERS,
        source: "stun-fallback"
      });
    }
  }
);

/* ==========================================
   START SERVER
========================================== */

server.listen(PORT, () => {
  console.log(
    `MeetSpace server running at http://localhost:${PORT}`
  );

  console.log(
    `Maximum participants: ${MAX_PARTICIPANTS}`
  );

  console.log(
    "Firebase Login, Meeting Settings, Chat and TURN enabled"
  );
});

/* ==========================================
   END OF COMPLETE MEETSPACE SERVER.JS
========================================== */
