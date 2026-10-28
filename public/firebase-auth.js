
import { initializeApp } from
  "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";

import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInAnonymously,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  signOut
} from
  "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";

// Firebase Web App configuration
const app = initializeApp(firebaseConfig);

// Initialize Authentication
const auth = getAuth(app);

// Google Login Provider
const googleProvider = new GoogleAuthProvider();

// Keep users signed in across browser sessions
const authReady = setPersistence(
  auth,
  browserLocalPersistence
);

// Google Sign In
async function loginWithGoogle() {
  await authReady;

  const result = await signInWithPopup(
    auth,
    googleProvider
  );

  return result.user;
}

// Anonymous Guest Sign In
async function loginAsGuest() {
  await authReady;

  const result = await signInAnonymously(auth);

  return result.user;
}

// Get Firebase ID Token for backend verification
async function getUserToken() {
  await authReady;

  const user = auth.currentUser;

  if (!user) {
    throw new Error("User not signed in");
  }

  return await user.getIdToken();
}

// Sign Out
async function logoutUser() {
  await signOut(auth);
}

// Expose authentication functions to script.js
window.meetspaceAuth = {
  auth,
  authReady,
  loginWithGoogle,
  loginAsGuest,
  getUserToken,
  logoutUser,
  onAuthStateChanged
};

console.log("MeetSpace Firebase Auth loaded");
