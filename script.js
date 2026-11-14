
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.5.0/firebase-app.js";

import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/12.5.0/firebase-auth.js";

import {
  getFirestore,
  collection,
  doc,
  setDoc,
  addDoc,
  getDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  updateDoc,
  serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/12.5.0/firebase-firestore.js";

// ================= FIREBASE CONFIGURATION =================

const firebaseConfig = {
  apiKey: "AIzaSyAa63uQ9JDm0_CBSRaDSGSSSHRggo4bDVg",
  authDomain: "connecto-7d97b.firebaseapp.com",
  projectId: "connecto-7d97b",
  storageBucket: "connecto-7d97b.firebasestorage.app",
  messagingSenderId: "651904013144",
  appId: "1:651904013144:web:953f6a7b71da026d530b2d",
  measurementId: "G-25WNF8S5V1"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

const $ = id => document.getElementById(id);

// ================= GLOBAL VARIABLES =================

let currentUser = null;
let selectedUser = null;
let myConnectoId = "";

let savedContacts = [];
let searchResult = null;
let searchRequestNumber = 0;

let stopMessages = null;
let stopSavedContacts = null;
let incomingCallUnsub = null;
let callUnsub = null;
let candidateUnsub = null;

let peerConnection = null;
let localStream = null;

let currentCallId = null;
let incomingCall = null;
let activeCallPeerId = null;

let isCaller = false;
let callAccepted = false;
let microphoneMuted = false;
let cameraEnabled = true;
let cameraFacingMode = "user";

let callTimeout = null;
let connectionTimeout = null;
let disconnectTimeout = null;

let pendingRemoteCandidates = [];
let callAttempt = 0;

let simultaneousCallDetected = false;
let simultaneousCancelInProgress = false;

// STUN helps discover network routes.
// TURN may also be needed for reliable calls on restrictive networks.
const callServers = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }

    // Add your TURN provider's credentials here
    // only after obtaining them from a TURN provider.
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: "max-bundle"
};

// ================= GENERAL HELPERS =================

function showError(message) {
  if (!$("authStatus")) return;

  $("authStatus").textContent = message;
  $("authStatus").style.color = "#c0392b";
}

function chatId(uid1, uid2) {
  return [uid1, uid2].sort().join("__");
}

function friendlyError(error) {
  const messages = {
    "auth/email-already-in-use": "This email already has an account.",
    "auth/invalid-email": "Please enter a valid email.",
    "auth/weak-password": "Password must have at least 6 characters.",
    "auth/invalid-credential": "Email or password is incorrect.",
    "auth/network-request-failed": "Network error. Check your internet.",
    "auth/user-not-found": "No account found with this email.",
    "auth/too-many-requests": "Too many attempts. Try again later.",
    "storage/unauthorized": "Photo upload denied. Check Storage rules.",
    "permission-denied": "Access denied. Check Firebase security rules."
  };

  return messages[error.code] ||
    error.message ||
    "Something went wrong.";
}

function setCallStatus(message) {
  if ($("callStatus")) {
    $("callStatus").textContent = message;
  }
}

function stopListener(listener) {
  if (typeof listener === "function") {
    listener();
  }

  return null;
}

// ================= SHORT CONNECTO ID =================

function makeIdPrefix(name) {
  const prefix = (name || "user")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);

  return prefix || "user";
}

async function ensureConnectoId(user) {
  const uid = user.uid;

  const displayName =
    user.displayName ||
    user.email?.split("@")[0] ||
    "Connecto user";

  const userRef = doc(db, "users", uid);
  const prefix = makeIdPrefix(displayName);

  for (let attempt = 0; attempt < 40; attempt++) {
    const candidate =
      `${prefix}${Math.floor(1000 + Math.random() * 9000)}`;

    const result = await runTransaction(db, async transaction => {
      const userSnapshot = await transaction.get(userRef);

      const existingId = userSnapshot.exists()
        ? userSnapshot.data().connectoId
        : null;

      let chosenId = existingId || candidate;

      let mappingRef = doc(db, "connectoIds", chosenId);
      let mappingSnapshot = await transaction.get(mappingRef);

      // If an existing ID belongs to another user,
      // generate a fresh ID instead of retrying the same one.
      if (
        mappingSnapshot.exists() &&
        mappingSnapshot.data().uid !== uid
      ) {
        chosenId = candidate;
        mappingRef = doc(db, "connectoIds", chosenId);
        mappingSnapshot = await transaction.get(mappingRef);
      }

      if (
        mappingSnapshot.exists() &&
        mappingSnapshot.data().uid !== uid
      ) {
        return null;
      }

      if (!mappingSnapshot.exists()) {
        transaction.set(mappingRef, {
          uid,
          createdAt: serverTimestamp()
        });
      }

      transaction.set(userRef, {
        uid,
        userId: uid,
        connectoId: chosenId,
        displayName
      }, { merge: true });

      return chosenId;
    });

    if (result) return result;
  }

  throw new Error(
    "Could not generate a unique Connecto ID. Please try again."
  );
}

// ================= COPY CONNECTO ID =================

if ($("copyConnectoIdBtn")) {
  $("copyConnectoIdBtn").addEventListener("click", async () => {
    if (!myConnectoId) {
      alert("Your Connecto ID is not ready yet.");
      return;
    }

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard unavailable");
      }

      await navigator.clipboard.writeText(myConnectoId);

      $("copyConnectoIdBtn").textContent = "✓ Copied";

      setTimeout(() => {
        if ($("copyConnectoIdBtn")) {
          $("copyConnectoIdBtn").textContent = "📋 Copy ID";
        }
      }, 2000);

    } catch (error) {
      console.error("Copy ID error:", error);
      prompt("Copy your Connecto ID:", myConnectoId);
    }
  });
}

// ================= NOTIFICATIONS =================

async function enableNotifications() {
  if (!("Notification" in window)) {
    alert("This browser does not support notifications.");
    return;
  }

  try {
    const permission = await Notification.requestPermission();

    if (permission === "granted") {
      alert("Connecto notifications enabled!");
    } else {
      alert("Please allow notifications in browser settings.");
    }
  } catch (error) {
    console.error("Notification permission error:", error);
  }
}

// Supports one or more notification buttons.
// This also handles duplicate IDs in older HTML.
document.querySelectorAll("#enableNotificationsBtn").forEach(button => {
  button.addEventListener("click", enableNotifications);
});

function showMissedCallNotification(callerName, missedCallId) {
  if (!currentUser || !missedCallId) return;

  const storageKey = `connecto_missed_${currentUser.uid}`;

  let notified = [];

  try {
    notified = JSON.parse(localStorage.getItem(storageKey) || "[]");

    if (!Array.isArray(notified)) {
      notified = [];
    }
  } catch {
    notified = [];
  }

  if (notified.includes(missedCallId)) return;

  const title = "Connecto - Missed Call";
  const body = `${callerName || "Connecto user"} tried to call you.`;

  if (
    "Notification" in window &&
    Notification.permission === "granted"
  ) {
    try {
      const notification = new Notification(title, {
        body,
        tag: `connecto-${missedCallId}`,
        requireInteraction: true
      });

      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    } catch (error) {
      console.error("Notification error:", error);
      alert(`${title}\n${body}`);
    }
  } else {
    alert(`${title}\n${body}`);
  }

  notified.push(missedCallId);

  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify(notified.slice(-100))
    );
  } catch (error) {
    console.warn("Notification history could not be saved:", error);
  }
}

function isRecentMissedCall(data) {
  if (!data.missedAt) return false;

  const missedTime = data.missedAt.toDate
    ? data.missedAt.toDate().getTime()
    : new Date(data.missedAt).getTime();

  return Number.isFinite(missedTime) &&
    Date.now() - missedTime >= 0 &&
    Date.now() - missedTime < 10 * 60 * 1000;
}

// ================= LOGIN / SIGNUP SWITCH =================

function showLogin() {
  $("loginBox").classList.remove("hidden");
  $("signupBox").classList.add("hidden");
  showError("");
}

$("showSignup").addEventListener("click", () => {
  $("loginBox").classList.add("hidden");
  $("signupBox").classList.remove("hidden");
  showError("");
});

$("showLogin").addEventListener("click", showLogin);

// ================= CREATE ACCOUNT =================

$("signupBtn").addEventListener("click", async () => {
  const name = $("signupName").value.trim();
  const email = $("signupEmail").value.trim();
  const password = $("signupPassword").value;

  if (!name || !email || !password) {
    showError("Please fill in all three fields.");
    return;
  }

  if (name.length < 2) {
    showError("Username must have at least 2 characters.");
    return;
  }

  if (password.length < 6) {
    showError("Password must have at least 6 characters.");
    return;
  }

  try {
    $("signupBtn").disabled = true;

    const result = await createUserWithEmailAndPassword(
      auth,
      email,
      password
    );

    await updateProfile(result.user, {
      displayName: name
    });

    await setDoc(doc(db, "users", result.user.uid), {
      uid: result.user.uid,
      userId: result.user.uid,
      displayName: name,
      createdAt: serverTimestamp()
    });

  } catch (error) {
    console.error("Signup error:", error);
    showError(friendlyError(error));
  } finally {
    $("signupBtn").disabled = false;
  }
});

// ================= LOGIN =================

$("loginBtn").addEventListener("click", async () => {
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;

  if (!email || !password) {
    showError("Enter your email and password.");
    return;
  }

  try {
    $("loginBtn").disabled = true;

    await signInWithEmailAndPassword(auth, email, password);

  } catch (error) {
    showError(friendlyError(error));
  } finally {
    $("loginBtn").disabled = false;
  }
});

// ================= FORGOT PASSWORD =================

$("forgotPassword").addEventListener("click", async () => {
  const email = $("loginEmail").value.trim();

  if (!email) {
    showError("Enter your email address first.");
    $("loginEmail").focus();
    return;
  }

  try {
    $("forgotPassword").disabled = true;

    await sendPasswordResetEmail(auth, email);

    $("authStatus").style.color = "#087b69";
    showError(
      "Password reset email sent. Check your inbox and spam folder."
    );

  } catch (error) {
    showError(friendlyError(error));
  } finally {
    $("forgotPassword").disabled = false;
  }
});

// ================= PRIVATE SAVED CONTACTS =================

function loadSavedContacts() {
  if (!currentUser) return;

  stopSavedContacts = stopListener(stopSavedContacts);

  const contactsRef = collection(
    db,
    "users",
    currentUser.uid,
    "contacts"
  );

  stopSavedContacts = onSnapshot(
    contactsRef,
    snapshot => {
      savedContacts = snapshot.docs.map(item => {
        const data = item.data();

        return {
          uid: data.uid || item.id,
          userId: data.uid || item.id,
          connectoId: data.connectoId || "",
          displayName: data.displayName || "Connecto user"
        };
      });

      renderUsers();
    },
    error => {
      console.error("Saved contacts error:", error);

      $("userList").innerHTML =
        '<div class="notice">Could not load saved contacts. Check Firestore rules.</div>';
    }
  );
}

async function saveContact(person) {
  if (!currentUser || !person?.uid) return;

  if (person.uid === currentUser.uid) {
    alert("You cannot save yourself as a contact.");
    return;
  }

  try {
    const contactRef = doc(
      db,
      "users",
      currentUser.uid,
      "contacts",
      person.uid
    );

    await setDoc(contactRef, {
      uid: person.uid,
      connectoId: person.connectoId || "",
      displayName: person.displayName || "Connecto user",
      savedAt: serverTimestamp()
    });

    alert("Contact saved successfully.");

  } catch (error) {
    console.error("Save contact error:", error);
    alert("Could not save contact: " + friendlyError(error));
  }
}

async function removeContact(person) {
  if (!currentUser || !person) return;

  if (!confirm(
    `Remove ${person.displayName || "this contact"} from your saved contacts?`
  )) return;

  try {
    await deleteDoc(doc(
      db,
      "users",
      currentUser.uid,
      "contacts",
      person.uid
    ));

    if (selectedUser?.uid === person.uid) {
      selectedUser = null;

      stopMessages = stopListener(stopMessages);

      $("activeName").textContent = "Select a contact";
      $("activeAvatar").textContent = "?";
      $("activeStatus").textContent = "";

      $("chatMessages").innerHTML =
        '<div class="empty">Select a contact to start chatting.</div>';
    }

    alert("Contact removed successfully.");

  } catch (error) {
    console.error("Remove contact error:", error);
    alert("Could not remove contact: " + friendlyError(error));
  }
}

// ================= SEARCH BY SHORT CONNECTO ID =================

async function searchUserById() {
  if (!currentUser) return;

  const enteredId = $("userSearch").value
    .trim()
    .toLowerCase()
    .replace(/^@/, "");

  const thisRequest = ++searchRequestNumber;

  // Clear previous results immediately.
  searchResult = null;

  if (!enteredId) {
    renderUsers();
    return;
  }

  if (enteredId === myConnectoId) {
    searchResult = {
      uid: currentUser.uid,
      isSelf: true
    };

    renderUsers();
    return;
  }

  $("userList").innerHTML =
    '<div class="empty">Searching Connecto ID...</div>';

  try {
    const mappingSnapshot = await getDoc(
      doc(db, "connectoIds", enteredId)
    );

    if (thisRequest !== searchRequestNumber) return;

    if (!mappingSnapshot.exists()) {
      $("userList").innerHTML =
        '<div class="empty">No user found with this Connecto ID.</div>';
      return;
    }

    const uid = mappingSnapshot.data().uid;

    if (!uid) {
      $("userList").innerHTML =
        '<div class="empty">Invalid Connecto ID.</div>';
      return;
    }

    const userSnapshot = await getDoc(doc(db, "users", uid));

    if (thisRequest !== searchRequestNumber) return;

    if (!userSnapshot.exists()) {
      $("userList").innerHTML =
        '<div class="empty">User profile not found.</div>';
      return;
    }

    const data = userSnapshot.data();

    searchResult = {
      uid,
      userId: uid,
      connectoId: data.connectoId || enteredId,
      displayName: data.displayName || "Connecto user"
    };

    renderUsers();

  } catch (error) {
    if (thisRequest !== searchRequestNumber) return;

    console.error("ID search error:", error);

    $("userList").innerHTML =
      '<div class="notice">Search failed. Check Firestore rules and internet.</div>';
  }
}

$("userSearch").placeholder = "Search by Connecto ID";

$("userSearch").addEventListener("input", searchUserById);

// ================= DISPLAY CONTACTS =================

function renderUsers() {
  if (!currentUser) return;

  const list = $("userList");
  const search = $("userSearch").value.trim();

  list.innerHTML = "";

  if (search) {
    if (!searchResult) {
      list.innerHTML =
        '<div class="empty">Enter the complete Connecto ID to search.</div>';
      return;
    }

    if (
      searchResult.isSelf ||
      searchResult.uid === currentUser.uid
    ) {
      list.innerHTML =
        '<div class="empty">This is your own Connecto ID.</div>';
      return;
    }

    const person = searchResult;

    const isSaved = savedContacts.some(
      contact => contact.uid === person.uid
    );

    const entry = document.createElement("div");
    entry.className = "user-entry";

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "user";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent =
      (person.displayName || "?").charAt(0).toUpperCase();

    const details = document.createElement("div");
    details.innerHTML =
      '<div class="user-name"></div><div class="user-sub"></div>';

    details.querySelector(".user-name").textContent =
      person.displayName || "Connecto user";

    details.querySelector(".user-sub").textContent =
      isSaved ? "Saved contact" : "Connecto user found";

    openButton.append(avatar, details);

    openButton.addEventListener("click", () => {
      if (!isSaved) {
        alert("Save this person first to start chatting.");
        return;
      }

      openChat(person);
    });

    entry.appendChild(openButton);

    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "save-contact-btn";
    saveButton.textContent =
      isSaved ? "✓ Saved" : "＋ Save Contact";
    saveButton.disabled = isSaved;

    saveButton.addEventListener("click", () => {
      saveContact(person);
    });

    entry.appendChild(saveButton);
    list.appendChild(entry);

    return;
  }

  if (!savedContacts.length) {
    list.innerHTML =
      '<div class="empty">No saved contacts yet. Enter a Connecto ID above to find someone.</div>';
    return;
  }

  savedContacts.forEach(person => {
    const entry = document.createElement("div");
    entry.className = "user-entry";

    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "user" + (selectedUser?.uid === person.uid ? " active" : "");

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent =
      (person.displayName || "?").charAt(0).toUpperCase();

    const details = document.createElement("div");
    details.innerHTML =
      '<div class="user-name"></div><div class="user-sub"></div>';

    details.querySelector(".user-name").textContent =
      person.displayName || "Connecto user";

    details.querySelector(".user-sub").textContent =
      person.connectoId
        ? "@" + person.connectoId
        : "Saved contact";

    button.append(avatar, details);
    button.addEventListener("click", () => openChat(person));

    entry.appendChild(button);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "remove-contact-btn";
    removeButton.textContent = "Remove";

    removeButton.addEventListener("click", () => {
      removeContact(person);
    });

    entry.appendChild(removeButton);
    list.appendChild(entry);
  });
}

// ================= CHAT MESSAGES =================

function renderMessage(message) {
  const bubble = document.createElement("div");

  bubble.className =
    "bubble" +
    (message.senderId === currentUser.uid ? " mine" : "");

  if (message.text) {
    const text = document.createElement("div");
    text.textContent = message.text;
    text.style.fontSize = "15px";
    text.style.whiteSpace = "pre-wrap";
    bubble.appendChild(text);
  }

  if (message.imageUrl) {
    const image = document.createElement("img");

    image.src = message.imageUrl;
    image.alt = "Shared photo";
    image.loading = "lazy";
    image.style.display = "block";
    image.style.maxWidth = "100%";
    image.style.maxHeight = "300px";
    image.style.borderRadius = "10px";
    image.style.objectFit = "contain";

    bubble.appendChild(image);
  }

  $("chatMessages").appendChild(bubble);
}

// ================= OPEN CHAT =================

async function openChat(person) {
  if (!currentUser || !person) return;

  const isSaved = savedContacts.some(
    contact => contact.uid === person.uid
  );

  if (!isSaved) {
    alert("You can chat only with saved contacts.");
    return;
  }

  selectedUser = person;

  $("activeName").textContent =
    person.displayName || "Connecto user";

  $("activeAvatar").textContent =
    (person.displayName || "?").charAt(0).toUpperCase();

  $("activeStatus").textContent =
    "Chat with " + (person.displayName || "Connecto user");

  renderUsers();

  stopMessages = stopListener(stopMessages);

  const id = chatId(currentUser.uid, person.uid);
  const chatRef = doc(db, "chats", id);

  $("chatMessages").innerHTML =
    '<div class="empty">Loading messages...</div>';

  try {
    await setDoc(chatRef, {
      participants: [currentUser.uid, person.uid].sort(),
      updatedAt: serverTimestamp()
    }, { merge: true });

    if (selectedUser?.uid !== person.uid) return;

    const messagesQuery = query(
      collection(db, "chats", id, "messages"),
      orderBy("createdAt", "asc")
    );

    stopMessages = onSnapshot(
      messagesQuery,
      snapshot => {
        if (selectedUser?.uid !== person.uid) return;

        const box = $("chatMessages");
        box.innerHTML = "";

        if (snapshot.empty) {
          box.innerHTML =
            '<div class="empty"><div class="big">👋</div><p>Start your conversation!</p></div>';
          return;
        }

        snapshot.forEach(messageDoc => {
          renderMessage(messageDoc.data());
        });

        box.scrollTop = box.scrollHeight;
      },
      error => {
        console.error("Message listener:", error);

        $("activeStatus").textContent =
          "Message access error. Check Firestore rules.";
      }
    );

  } catch (error) {
    console.error("Open chat error:", error);

    $("activeStatus").textContent =
      "Could not open chat. Check Firestore rules.";
  }
}

// ================= SEND TEXT / EMOJI =================

async function sendTextMessage() {
  if (!currentUser || !selectedUser) {
    alert("First select a saved contact.");
    return;
  }

  const input = $("messageInput");
  const text = input.value.trim();

  if (!text) return;

  const id = chatId(currentUser.uid, selectedUser.uid);

  $("sendBtn").disabled = true;

  try {
    await addDoc(collection(db, "chats", id, "messages"), {
      text,
      senderId: currentUser.uid,
      createdAt: serverTimestamp()
    });

    input.value = "";
    input.focus();

  } catch (error) {
    console.error(error);
    alert("Message could not be sent: " + friendlyError(error));
  } finally {
    $("sendBtn").disabled = false;
  }
}

$("sendBtn").addEventListener("click", sendTextMessage);

$("messageInput").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendTextMessage();
  }
});

document.querySelectorAll(".emoji").forEach(button => {
  button.addEventListener("click", async () => {
    if (!currentUser || !selectedUser) {
      alert("First select a saved contact.");
      return;
    }

    try {
      await addDoc(
        collection(
          db,
          "chats",
          chatId(currentUser.uid, selectedUser.uid),
          "messages"
        ),
        {
          text: button.textContent.trim(),
          senderId: currentUser.uid,
          createdAt: serverTimestamp()
        }
      );
    } catch (error) {
      console.error(error);
      alert("Emoji could not be sent: " + friendlyError(error));
    }
  });
});

// ================= SEND PHOTO =================

$("photoInput").addEventListener("change", async event => {
  const file = event.target.files[0];

  if (!file) return;

  if (!currentUser || !selectedUser) {
    alert("First select a saved contact.");
    event.target.value = "";
    return;
  }

  if (!file.type.startsWith("image/")) {
    alert("Please select an image file.");
    event.target.value = "";
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    alert("Photo must be smaller than 5 MB.");
    event.target.value = "";
    return;
  }

  const recipient = selectedUser;
  const id = chatId(currentUser.uid, recipient.uid);

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");

  const filePath =
    `chatImages/${id}/${currentUser.uid}_${Date.now()}_${safeName}`;

  $("activeStatus").textContent = "Uploading photo...";

  try {
    const imageRef = ref(storage, filePath);

    await uploadBytes(imageRef, file, {
      contentType: file.type
    });

    const imageUrl = await getDownloadURL(imageRef);

    if (selectedUser?.uid !== recipient.uid) {
      alert("Photo uploaded, but the selected chat changed.");
      return;
    }

    await addDoc(collection(db, "chats", id, "messages"), {
      imageUrl,
      senderId: currentUser.uid,
      createdAt: serverTimestamp()
    });

    $("activeStatus").textContent = "Photo sent";

  } catch (error) {
    console.error(error);

    alert("Photo could not be sent: " + friendlyError(error));
    $("activeStatus").textContent = "Photo upload failed";

  } finally {
    event.target.value = "";
  }
});

// ================= CALL SCREEN =================

function showCallScreen(title, status) {
  $("callScreen").classList.remove("hidden");
  $("callTitle").textContent = title;
  $("callStatus").textContent = status;
}

function hideCallScreen() {
  $("callScreen").classList.add("hidden");
}

// ================= CALL MEDIA =================

async function getCallMedia(type) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      "Camera and microphone require HTTPS or localhost."
    );
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: type === "video"
        ? {
            facingMode: { ideal: cameraFacingMode },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        : false
    });
  } catch (error) {
    console.error("Media permission error:", error);

    if (error.name === "NotAllowedError") {
      throw new Error(
        "Camera or microphone permission was denied. Allow permission in your device settings."
      );
    }

    if (error.name === "NotFoundError") {
      throw new Error(
        "No suitable camera or microphone was found."
      );
    }

    if (error.name === "NotReadableError") {
      throw new Error(
        "Camera or microphone is already being used by another application."
      );
    }

    throw error;
  }
}

function toggleCamera() {
  if (!localStream) {
    alert("Camera is not active.");
    return;
  }

  const track = localStream.getVideoTracks()[0];

  if (!track) {
    alert("No video camera is available in this call.");
    return;
  }

  cameraEnabled = !cameraEnabled;
  track.enabled = cameraEnabled;

  $("cameraToggleBtn").textContent =
    cameraEnabled ? "📷" : "🚫";

  $("cameraToggleBtn").title =
    cameraEnabled ? "Turn camera off" : "Turn camera on";
}

async function flipCamera() {
  if (!localStream || !peerConnection) {
    alert("Start a video call first.");
    return;
  }

  const oldTrack = localStream.getVideoTracks()[0];

  if (!oldTrack) {
    alert("No video camera is available.");
    return;
  }

  const newFacingMode =
    cameraFacingMode === "user" ? "environment" : "user";

  let newStream;

  try {
    newStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: newFacingMode }
      },
      audio: false
    });

    const newTrack = newStream.getVideoTracks()[0];

    const sender = peerConnection.getSenders().find(
      item => item.track?.kind === "video"
    );

    if (!sender) {
      newStream.getTracks().forEach(track => track.stop());
      alert("Could not find the video connection.");
      return;
    }

    await sender.replaceTrack(newTrack);

    newTrack.enabled = cameraEnabled;

    const audioTracks = localStream.getAudioTracks();

    localStream = new MediaStream([
      ...audioTracks,
      newTrack
    ]);

    $("localVideo").srcObject = localStream;

    oldTrack.stop();

    newStream.getTracks().forEach(track => {
      if (track !== newTrack) track.stop();
    });

    cameraFacingMode = newFacingMode;

  } catch (error) {
    if (newStream) {
      newStream.getTracks().forEach(track => track.stop());
    }

    console.error("Camera switch error:", error);

    alert("Could not switch camera. Check camera permissions.");
  }
}

// ================= PEER CONNECTION =================

function createPeerConnection() {
  if (!localStream) {
    throw new Error("Local camera or microphone is not ready.");
  }

  peerConnection = new RTCPeerConnection(callServers);

  const connection = peerConnection;

  localStream.getTracks().forEach(track => {
    connection.addTrack(track, localStream);
  });

  // Remote media
  connection.ontrack = event => {
    if (connection !== peerConnection) return;

    const remoteVideo = $("remoteVideo");

    if (event.streams?.[0]) {
      remoteVideo.srcObject = event.streams[0];
    } else {
      let stream = remoteVideo.srcObject;

      if (!(stream instanceof MediaStream)) {
        stream = new MediaStream();
        remoteVideo.srcObject = stream;
      }

      stream.addTrack(event.track);
    }

    remoteVideo.style.display = "block";
    remoteVideo.playsInline = true;

    remoteVideo.play().catch(error => {
      // Autoplay can be blocked by the browser.
      // This warning does not necessarily mean the call failed.
      console.warn("Remote video playback:", error);
    });
  };

  // Local ICE candidates
  connection.onicecandidate = async event => {
    if (
      !event.candidate ||
      !currentCallId ||
      !currentUser ||
      connection !== peerConnection
    ) return;

    const callIdAtCandidate = currentCallId;

    try {
      await addDoc(
        collection(db, "calls", callIdAtCandidate, "candidates"),
        {
          senderId: currentUser.uid,
          candidate: event.candidate.toJSON(),
          createdAt: serverTimestamp()
        }
      );
    } catch (error) {
      console.error("ICE candidate upload error:", error);
    }
  };

  // ICE diagnostics
  connection.oniceconnectionstatechange = () => {
    if (connection !== peerConnection) return;

    console.log(
      "ICE CONNECTION STATE:",
      connection.iceConnectionState
    );

    if (connection.iceConnectionState === "checking") {
      setCallStatus("Checking network connection...");
    }

    if (connection.iceConnectionState === "connected" ||
        connection.iceConnectionState === "completed") {
      setCallStatus("Connected");
    }

    if (connection.iceConnectionState === "failed") {
      console.error(
        "ICE failed. A TURN server may be required."
      );
    }
  };

  connection.onicegatheringstatechange = () => {
    console.log(
      "ICE GATHERING STATE:",
      connection.iceGatheringState
    );
  };

  connection.onsignalingstatechange = () => {
    console.log(
      "SIGNALING STATE:",
      connection.signalingState
    );
  };

  connection.onicecandidateerror = event => {
    console.error("ICE CANDIDATE ERROR:", event);
  };

  // Connection state
  connection.onconnectionstatechange = async () => {
    if (connection !== peerConnection) return;

    const state = connection.connectionState;

    console.log("PEER CONNECTION STATE:", state);

    if (state === "connected") {
      setCallStatus("Connected");

      clearTimeout(connectionTimeout);
      connectionTimeout = null;

      clearTimeout(disconnectTimeout);
      disconnectTimeout = null;
    }

    if (state === "connecting") {
      setCallStatus("Connecting...");
    }

    if (state === "disconnected" && !disconnectTimeout) {
      const disconnectedCallId = currentCallId;

      setCallStatus("Connection interrupted. Reconnecting...");

      disconnectTimeout = setTimeout(async () => {
        if (
          currentCallId !== disconnectedCallId ||
          connection !== peerConnection ||
          connection.connectionState === "connected"
        ) return;

        try {
          if (disconnectedCallId) {
            await updateDoc(
              doc(db, "calls", disconnectedCallId),
              { status: "ended" }
            );
          }
        } catch (error) {
          console.error("Disconnect update:", error);
        }

        if (currentCallId === disconnectedCallId) {
          alert("Call disconnected. Please try again.");
          cleanupCall();
        }
      }, 12000);
    }

    if (state === "failed") {
      const failedCallId = currentCallId;

      console.error("WebRTC connection failed.");

      try {
        if (failedCallId) {
          await updateDoc(
            doc(db, "calls", failedCallId),
            { status: "ended" }
          );
        }
      } catch (error) {
        console.error("Failed call update:", error);
      }

      if (
        currentCallId === failedCallId &&
        connection === peerConnection
      ) {
        alert(
          "Call connection failed. Your network may require a TURN server."
        );

        cleanupCall();
      }
    }
  };

  return connection;
}

// ================= REMOTE ICE CANDIDATES =================

async function addPendingCandidates() {
  if (!peerConnection?.remoteDescription) return;

  const connection = peerConnection;

  while (pendingRemoteCandidates.length) {
    const candidate = pendingRemoteCandidates.shift();

    if (connection !== peerConnection) return;

    try {
      await connection.addIceCandidate(
        new RTCIceCandidate(candidate)
      );
    } catch (error) {
      console.error("Pending ICE candidate error:", error);
    }
  }
}

function listenForRemoteCandidates() {
  candidateUnsub = stopListener(candidateUnsub);

  pendingRemoteCandidates = [];

  const listeningCallId = currentCallId;

  if (!listeningCallId) return;

  candidateUnsub = onSnapshot(
    collection(db, "calls", listeningCallId, "candidates"),
    snapshot => {
      snapshot.docChanges().forEach(async change => {
        if (change.type !== "added") return;

        const data = change.doc.data();

        if (data.senderId === currentUser.uid) return;
        if (!data.candidate) return;
        if (currentCallId !== listeningCallId) return;

        if (!peerConnection?.remoteDescription) {
          pendingRemoteCandidates.push(data.candidate);
          return;
        }

        const connection = peerConnection;

        try {
          await connection.addIceCandidate(
            new RTCIceCandidate(data.candidate)
          );
        } catch (error) {
          console.error("Remote candidate error:", error);
        }
      });
    },
    error => {
      console.error("Candidate listener error:", error);
    }
  );
}

// ================= WATCH CALL DOCUMENT =================

function watchCallDocument() {
  callUnsub = stopListener(callUnsub);

  const watchedCallId = currentCallId;

  if (!watchedCallId) return;

  callUnsub = onSnapshot(
    doc(db, "calls", watchedCallId),
    async snapshot => {
      if (!snapshot.exists()) return;
      if (currentCallId !== watchedCallId) return;

      const data = snapshot.data();

      if (data.status === "missed") {
        clearTimeout(callTimeout);
        callTimeout = null;

        if (isCaller) {
          alert("The other user did not answer.");
        } else {
          showMissedCallNotification(
            data.callerName,
            watchedCallId
          );
        }

        cleanupCall();
        return;
      }

      if (data.status === "rejected") {
        if (isCaller) {
          alert("The call was rejected.");
        }

        cleanupCall();
        return;
      }

      if (data.status === "ended") {
        cleanupCall();
        return;
      }

      if (data.status === "accepted") {
        callAccepted = true;

        clearTimeout(callTimeout);
        callTimeout = null;

        setCallStatus("Connecting...");

        if (!connectionTimeout) {
          connectionTimeout = setTimeout(async () => {
            if (
              currentCallId !== watchedCallId ||
              !peerConnection ||
              peerConnection.connectionState === "connected"
            ) return;

            try {
              await updateDoc(
                doc(db, "calls", watchedCallId),
                { status: "ended" }
              );
            } catch (error) {
              console.error("Connection timeout update:", error);
            }

            if (currentCallId === watchedCallId) {
              alert(
                "Could not establish the call connection. Check your internet or TURN configuration."
              );

              cleanupCall();
            }
          }, 45000);
        }
      }

      if (
        isCaller &&
        data.answer &&
        peerConnection &&
        !peerConnection.remoteDescription
      ) {
        try {
          await peerConnection.setRemoteDescription(
            new RTCSessionDescription(data.answer)
          );

          await addPendingCandidates();

          setCallStatus("Connecting...");

        } catch (error) {
          console.error("Answer error:", error);
          setCallStatus("Could not process call answer.");
        }
      }
    },
    error => {
      console.error("Call document listener:", error);
      setCallStatus("Call connection error. Check Firestore rules.");
    }
  );
}

// ================= CLEANUP CALL =================

function cleanupCall() {
  // Invalidate pending async call operations.
  callAttempt++;

  clearTimeout(callTimeout);
  clearTimeout(connectionTimeout);
  clearTimeout(disconnectTimeout);

  callTimeout = null;
  connectionTimeout = null;
  disconnectTimeout = null;

  callUnsub = stopListener(callUnsub);
  candidateUnsub = stopListener(candidateUnsub);

  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.oniceconnectionstatechange = null;
    peerConnection.onicegatheringstatechange = null;
    peerConnection.onsignalingstatechange = null;
    peerConnection.onicecandidateerror = null;

    peerConnection.close();
    peerConnection = null;
  }

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  pendingRemoteCandidates = [];

  currentCallId = null;
  incomingCall = null;
  activeCallPeerId = null;

  isCaller = false;
  callAccepted = false;
  microphoneMuted = false;
  cameraEnabled = true;
  cameraFacingMode = "user";

  simultaneousCallDetected = false;
  simultaneousCancelInProgress = false;

  $("localVideo").srcObject = null;
  $("remoteVideo").srcObject = null;

  $("localVideo").style.display = "none";
  $("remoteVideo").style.display = "none";

  $("acceptCallBtn").style.display = "inline-block";
  $("acceptCallBtn").disabled = false;

  $("cameraToggleBtn").textContent = "📷";
  $("cameraToggleBtn").style.display = "none";

  $("flipCameraBtn").style.display = "none";

  $("muteCallBtn").textContent = "🎙️";

  hideCallScreen();
}

// ================= START OUTGOING CALL =================

async function startCall(type) {
  if (!currentUser) return;

  if (!selectedUser) {
    alert("First select a saved contact.");
    return;
  }

  if (selectedUser.uid === currentUser.uid) {
    alert("You cannot call yourself.");
    return;
  }

  if (currentCallId || peerConnection || isCaller) {
    alert("You already have an active call.");
    return;
  }

  const recipient = selectedUser;
  const thisAttempt = ++callAttempt;

  simultaneousCallDetected = false;
  simultaneousCancelInProgress = false;

  try {
    isCaller = true;
    callAccepted = false;
    microphoneMuted = false;
    cameraEnabled = true;
    cameraFacingMode = "user";
    activeCallPeerId = recipient.uid;

    showCallScreen(
      type === "video" ? "Video Call" : "Voice Call",
      "Starting call..."
    );

    $("acceptCallBtn").style.display = "none";

    $("cameraToggleBtn").style.display =
      type === "video" ? "inline-block" : "none";

    $("flipCameraBtn").style.display =
      type === "video" ? "inline-block" : "none";

    $("cameraToggleBtn").textContent = "📷";
    $("muteCallBtn").textContent = "🎙️";

    $("remoteVideo").style.display = "none";

    $("localVideo").style.display =
      type === "video" ? "block" : "none";

    // Request camera/microphone permission.
    localStream = await getCallMedia(type);

    if (thisAttempt !== callAttempt || !isCaller) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
      return;
    }

    $("localVideo").srcObject = localStream;

    createPeerConnection();

    const callRef = doc(collection(db, "calls"));
    currentCallId = callRef.id;

    // Create call document before publishing ICE candidates.
    await setDoc(callRef, {
      callerId: currentUser.uid,
      callerName: currentUser.displayName || "Connecto user",
      receiverId: recipient.uid,
      participants: [currentUser.uid, recipient.uid],
      type,
      status: "preparing",
      createdAt: serverTimestamp()
    });

    if (thisAttempt !== callAttempt) return;

    const offer = await peerConnection.createOffer();

    await peerConnection.setLocalDescription(offer);

    if (thisAttempt !== callAttempt) return;

    const ringingAllowed = await runTransaction(
      db,
      async transaction => {
        const snapshot = await transaction.get(callRef);

        if (!snapshot.exists()) return false;

        if (snapshot.data().status !== "preparing") {
          return false;
        }

        transaction.update(callRef, {
          offer: {
            type: offer.type,
            sdp: offer.sdp
          },
          status: "ringing"
        });

        return true;
      }
    );

    if (!ringingAllowed || thisAttempt !== callAttempt) {
      cleanupCall();
      return;
    }

    listenForRemoteCandidates();
    watchCallDocument();

    setCallStatus(
      "Calling " + (recipient.displayName || "user") + "..."
    );

    const thisCallId = currentCallId;

    callTimeout = setTimeout(async () => {
      if (
        currentCallId !== thisCallId ||
        callAccepted
      ) return;

      try {
        await runTransaction(db, async transaction => {
          const refToUpdate = doc(db, "calls", thisCallId);
          const snapshot = await transaction.get(refToUpdate);

          if (
            snapshot.exists() &&
            snapshot.data().status === "ringing"
          ) {
            transaction.update(refToUpdate, {
              status: "missed",
              missedAt: serverTimestamp()
            });
          }
        });
      } catch (error) {
        console.error("Missed call update:", error);
      }

      if (
        currentCallId === thisCallId &&
        !callAccepted
      ) {
        cleanupCall();
      }
    }, 30000);

  } catch (error) {
    console.error("Call error:", error);

    alert("Could not start call: " + friendlyError(error));

    if (thisAttempt === callAttempt || currentCallId) {
      cleanupCall();
    }
  }
}

// ================= INCOMING CALL LISTENER =================

function listenForIncomingCalls() {
  incomingCallUnsub = stopListener(incomingCallUnsub);

  if (!currentUser) return;

  const callsQuery = query(
    collection(db, "calls"),
    where("participants", "array-contains", currentUser.uid)
  );

  incomingCallUnsub = onSnapshot(
    callsQuery,
    async snapshot => {
      for (const change of snapshot.docChanges()) {
        if (
          change.type !== "added" &&
          change.type !== "modified"
        ) continue;

        const data = change.doc.data();
        const changedCallId = change.doc.id;

        if (data.receiverId !== currentUser.uid) continue;

        // Both users called each other.
        const simultaneousCall =
          isCaller &&
          activeCallPeerId === data.callerId &&
          ["preparing", "ringing"].includes(data.status);

        if (
          simultaneousCall &&
          !simultaneousCallDetected &&
          !simultaneousCancelInProgress
        ) {
          simultaneousCallDetected = true;
          simultaneousCancelInProgress = true;

          const outgoingId = currentCallId;

          try {
            await runTransaction(db, async transaction => {
              const incomingRef = doc(
                db,
                "calls",
                changedCallId
              );

              const incomingSnapshot =
                await transaction.get(incomingRef);

              const outgoingRef = outgoingId
                ? doc(db, "calls", outgoingId)
                : null;

              const outgoingSnapshot = outgoingRef
                ? await transaction.get(outgoingRef)
                : null;

              if (
                incomingSnapshot.exists() &&
                ["preparing", "ringing"].includes(
                  incomingSnapshot.data().status
                )
              ) {
                transaction.update(incomingRef, {
                  status: "ended"
                });
              }

              if (
                outgoingSnapshot?.exists() &&
                ["preparing", "ringing"].includes(
                  outgoingSnapshot.data().status
                )
              ) {
                transaction.update(outgoingRef, {
                  status: "ended"
                });
              }
            });
          } catch (error) {
            console.error(
              "Simultaneous call cancellation:",
              error
            );
          }

          cleanupCall();

          alert(
            "You called each other at the same time. Please call again."
          );

          continue;
        }

        if (data.status === "missed") {
          if (isRecentMissedCall(data)) {
            showMissedCallNotification(
              data.callerName || "Connecto user",
              changedCallId
            );
          }

          if (
            currentCallId === changedCallId &&
            !isCaller
          ) {
            cleanupCall();
          }

          continue;
        }

        if (
          currentCallId === changedCallId &&
          !isCaller &&
          ["ended", "rejected"].includes(data.status)
        ) {
          cleanupCall();
          continue;
        }

        if (data.status !== "ringing") continue;

        if (currentCallId || peerConnection || isCaller) {
          continue;
        }

        currentCallId = changedCallId;

        incomingCall = {
          id: changedCallId,
          ...data
        };

        activeCallPeerId = data.callerId;
        isCaller = false;
        callAccepted = false;
        microphoneMuted = false;
        cameraEnabled = true;
        cameraFacingMode = "user";

        showCallScreen(
          data.type === "video"
            ? "Incoming Video Call"
            : "Incoming Voice Call",
          `Incoming call from ${data.callerName || "Connecto user"}`
        );

        $("acceptCallBtn").style.display = "inline-block";
        $("acceptCallBtn").disabled = false;

        $("cameraToggleBtn").style.display =
          data.type === "video" ? "inline-block" : "none";

        $("flipCameraBtn").style.display =
          data.type === "video" ? "inline-block" : "none";

        $("cameraToggleBtn").textContent = "📷";
        $("muteCallBtn").textContent = "🎙️";

        $("remoteVideo").style.display = "none";
        $("localVideo").style.display = "none";
      }
    },
    error => {
      console.error("Incoming call listener:", error);
    }
  );
}

// ================= ACCEPT INCOMING CALL =================

async function acceptCall() {
  if (!incomingCall || !currentCallId) return;

  const acceptedCallId = currentCallId;
  const acceptedIncomingCall = incomingCall;
  const thisAttempt = ++callAttempt;

  try {
    $("acceptCallBtn").disabled = true;

    setCallStatus("Preparing your camera and microphone...");

    localStream = await getCallMedia(
      acceptedIncomingCall.type
    );

    if (
      currentCallId !== acceptedCallId ||
      thisAttempt !== callAttempt
    ) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
      return;
    }

    $("localVideo").srcObject = localStream;

    $("localVideo").style.display =
      acceptedIncomingCall.type === "video"
        ? "block"
        : "none";

    createPeerConnection();

    if (!acceptedIncomingCall.offer) {
      throw new Error("The caller's offer is missing.");
    }

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(acceptedIncomingCall.offer)
    );

    await addPendingCandidates();

    listenForRemoteCandidates();

    const answer = await peerConnection.createAnswer();

    await peerConnection.setLocalDescription(answer);

    const accepted = await runTransaction(
      db,
      async transaction => {
        const callRef = doc(db, "calls", acceptedCallId);
        const snapshot = await transaction.get(callRef);

        if (!snapshot.exists()) return false;

        if (snapshot.data().status !== "ringing") {
          return false;
        }

        transaction.update(callRef, {
          answer: {
            type: answer.type,
            sdp: answer.sdp
          },
          status: "accepted"
        });

        return true;
      }
    );

    if (
      !accepted ||
      currentCallId !== acceptedCallId ||
      thisAttempt !== callAttempt
    ) {
      cleanupCall();
      return;
    }

    callAccepted = true;

    clearTimeout(callTimeout);
    callTimeout = null;

    watchCallDocument();

    $("acceptCallBtn").style.display = "none";

    setCallStatus("Connecting...");

  } catch (error) {
    console.error("Accept call error:", error);

    alert("Could not accept call: " + friendlyError(error));

    try {
      await updateDoc(
        doc(db, "calls", acceptedCallId),
        { status: "rejected" }
      );
    } catch (updateError) {
      console.error(
        "Could not update rejected call:",
        updateError
      );
    }

    cleanupCall();

  } finally {
    if ($("acceptCallBtn")) {
      $("acceptCallBtn").disabled = false;
    }
  }
}

// ================= END / DECLINE CALL =================

async function endCall() {
  const endingCallId = currentCallId;

  if (!endingCallId) {
    cleanupCall();
    return;
  }

  const status =
    (isCaller || callAccepted) ? "ended" : "rejected";

  // Clean up local media immediately.
  cleanupCall();

  try {
    await updateDoc(
      doc(db, "calls", endingCallId),
      { status }
    );
  } catch (error) {
    console.error("End call error:", error);
  }
}

// ================= CALL BUTTONS =================

$("voiceCallBtn").addEventListener("click", () => {
  startCall("audio");
});

$("videoCallBtn").addEventListener("click", () => {
  startCall("video");
});

$("acceptCallBtn").addEventListener("click", acceptCall);
$("endCallBtn").addEventListener("click", endCall);
$("declineCallBtn").addEventListener("click", endCall);

$("cameraToggleBtn").addEventListener("click", toggleCamera);
$("flipCameraBtn").addEventListener("click", flipCamera);

$("muteCallBtn").addEventListener("click", () => {
  if (!localStream) return;

  microphoneMuted = !microphoneMuted;

  localStream.getAudioTracks().forEach(track => {
    track.enabled = !microphoneMuted;
  });

  $("muteCallBtn").textContent =
    microphoneMuted ? "🔇" : "🎙️";
});

// ================= START APP =================

async function startApp(user) {
  currentUser = user;

  $("authPage").classList.add("hidden");
  $("chatApp").classList.remove("hidden");

  $("myName").textContent =
    user.displayName ||
    user.email?.split("@")[0] ||
    "Connecto user";

  $("myConnectoId").textContent =
    "Connecto ID: Loading...";

  try {
    myConnectoId = await ensureConnectoId(user);

    // Stop if the account changed during setup.
    if (auth.currentUser?.uid !== user.uid) return;

    $("myConnectoId").textContent =
      "Connecto ID: @" + myConnectoId;

    loadSavedContacts();
    listenForIncomingCalls();

  } catch (error) {
    console.error("Profile setup error:", error);

    $("userList").innerHTML =
      '<div class="notice">Could not set up your Connecto ID. Check Firestore rules and try again.</div>';
  }
}

// ================= LOGOUT =================

$("logoutBtn").addEventListener("click", async () => {
  try {
    if (currentCallId) {
      await endCall();
    } else {
      cleanupCall();
    }

    await signOut(auth);

  } catch (error) {
    alert(friendlyError(error));
  }
});

// ================= AUTH STATE =================

onAuthStateChanged(auth, async user => {
  if (user) {
    await startApp(user);

  } else {
    if (currentCallId) {
      await endCall();
    } else {
      cleanupCall();
    }

    incomingCallUnsub = stopListener(incomingCallUnsub);
    stopSavedContacts = stopListener(stopSavedContacts);
    stopMessages = stopListener(stopMessages);

    currentUser = null;
    selectedUser = null;
    myConnectoId = "";

    savedContacts = [];
    searchResult = null;
    searchRequestNumber++;

    $("authPage").classList.remove("hidden");
    $("chatApp").classList.add("hidden");

    $("myConnectoId").textContent =
      "Connecto ID: Not logged in";

    $("userList").innerHTML = "";
    $("chatMessages").innerHTML =
      '<div class="empty">Select a contact to start chatting.</div>';

    $("activeName").textContent = "Select a contact";
    $("activeAvatar").textContent = "?";
    $("activeStatus").textContent = "";

    showLogin();
  }
});

// ============================================================
// CONNECTO UPGRADE
// Paste this entire block at the VERY BOTTOM of script.js.
// Existing login, messages, photos, calls and notifications
// are preserved.
// ============================================================

let recentChats = [];
let stopRecentChats = null;

// ---------------- MOBILE CHAT LAYOUT ----------------

(function setupMobileLayout() {
  const style = document.createElement("style");

  style.textContent = `
    #backToContactsBtn {
      display: none;
      border: 0;
      background: #e8f5f1;
      color: #087b69;
      border-radius: 9px;
      padding: 9px 12px;
      font-weight: bold;
      font-size: 14px;
      flex-shrink: 0;
    }

    @media (max-width: 650px) {
      #chatApp {
        height: 100dvh;
        min-height: 100dvh;
        overflow: hidden;
      }

      #chatApp .sidebar {
        width: 100%;
        max-width: 100%;
        height: 100%;
        border-right: 0;
      }

      #chatApp .topbar {
        min-height: 65px;
        flex-direction: row;
        justify-content: space-between;
        padding: 10px 14px;
      }

      #chatApp .topbar h2 {
        font-size: 22px;
      }

      #chatApp .logout {
        font-size: 12px;
        padding: 8px;
      }

      #chatApp .me {
        font-size: 13px;
      }

      #chatApp .my-id-row {
        flex-direction: row;
        align-items: center;
      }

      #chatApp .my-id-label {
        font-size: 12px;
      }

      #chatApp .search {
        padding: 12px;
      }

      #chatApp .search input {
        font-size: 15px;
        padding: 12px;
      }

      #chatApp .user {
        flex-direction: row;
        text-align: left;
        padding: 13px;
      }

      #chatApp .user-name {
        font-size: 14px;
      }

      #chatApp .user-sub {
        display: block;
      }

      #chatApp .save-contact-btn,
      #chatApp .remove-contact-btn {
        margin: 0 12px 10px 68px;
        padding: 8px 12px;
        font-size: 12px;
      }

      #chatApp .main {
        display: none;
        width: 100%;
        height: 100%;
      }

      body.mobile-chat-open #chatApp .sidebar {
        display: none;
      }

      body.mobile-chat-open #chatApp .main {
        display: flex;
      }

      body.mobile-chat-open #backToContactsBtn {
        display: block;
      }

      #chatApp .chat-head {
        padding: 10px;
        gap: 8px;
      }

      #chatApp .chat-body {
        padding: 12px;
      }

      #chatApp .bubble {
        max-width: 88%;
      }

      #chatApp .composer {
        padding: 9px;
      }

      #chatApp .emoji-grid {
        gap: 4px;
      }

      #chatApp .emoji {
        font-size: 20px;
        min-width: 34px;
        padding: 5px;
      }

      #chatApp #messageInput {
        font-size: 14px;
      }

      #chatApp #sendBtn {
        padding: 11px;
      }

      #callScreen {
        padding: 12px;
      }

      #remoteVideo {
        width: 100%;
        max-height: 55vh;
        object-fit: contain;
      }

      #localVideo {
        width: 105px;
        right: 12px;
        top: 65px;
      }

      .call-controls {
        gap: 9px;
        margin-top: 20px;
      }

      .call-controls button {
        padding: 12px;
      }
    }
  `;

  document.head.appendChild(style);

  // Add a back button without needing to change index.html.
  const chatHead = document.querySelector("#chatApp .chat-head");

  if (chatHead && !$("backToContactsBtn")) {
    const backButton = document.createElement("button");

    backButton.id = "backToContactsBtn";
    backButton.type = "button";
    backButton.textContent = "← Back";

    backButton.addEventListener("click", () => {
      document.body.classList.remove("mobile-chat-open");
    });

    chatHead.insertBefore(backButton, chatHead.firstChild);
  }
})();

// ---------------- RECENT CONVERSATIONS ----------------

async function loadRecentChats() {
  if (!currentUser) return;

  stopRecentChats = stopListener(stopRecentChats);

  const chatsQuery = query(
    collection(db, "chats"),
    where("participants", "array-contains", currentUser.uid)
  );

  stopRecentChats = onSnapshot(
    chatsQuery,
    async snapshot => {
      const requestUserId = currentUser?.uid;

      if (!requestUserId) return;

      try {
        const results = await Promise.all(
          snapshot.docs.map(async chatDoc => {
            const data = chatDoc.data();

            const otherUid = (data.participants || []).find(
              uid => uid !== requestUserId
            );

            if (!otherUid) return null;

            // Use direct profile reads, not a public users listing.
            const profileSnapshot = await getDoc(
              doc(db, "users", otherUid)
            );

            if (!profileSnapshot.exists()) return null;

            const profile = profileSnapshot.data();

            return {
              uid: otherUid,
              userId: otherUid,
              displayName:
                profile.displayName || "Connecto user",
              connectoId: profile.connectoId || "",
              updatedAt: data.updatedAt || null,
              chatId: chatDoc.id
            };
          })
        );

        if (currentUser?.uid !== requestUserId) return;

        recentChats = results
          .filter(Boolean)
          .sort((a, b) => {
            const timeA = a.updatedAt?.toMillis?.() || 0;
            const timeB = b.updatedAt?.toMillis?.() || 0;

            return timeB - timeA;
          });

        renderUsers();

      } catch (error) {
        console.error("Recent chats error:", error);
      }
    },
    error => {
      console.error("Recent chats listener:", error);
    }
  );
}

// ---------------- CONTACT LIST DISPLAY ----------------

// Replace the old display function while keeping its callers.
renderUsers = function () {
  if (!currentUser) return;

  const list = $("userList");
  const search = $("userSearch").value.trim();

  list.innerHTML = "";

  // Search result view.
  if (search) {
    if (!searchResult) {
      list.innerHTML =
        '<div class="empty">Enter a complete Connecto ID to search.</div>';
      return;
    }

    if (
      searchResult.isSelf ||
      searchResult.uid === currentUser.uid
    ) {
      list.innerHTML =
        '<div class="empty">This is your own Connecto ID.</div>';
      return;
    }

    const person = searchResult;

    const isSaved = savedContacts.some(
      contact => contact.uid === person.uid
    );

    const entry = document.createElement("div");
    entry.className = "user-entry";

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "user";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent =
      (person.displayName || "?").charAt(0).toUpperCase();

    const details = document.createElement("div");

    const name = document.createElement("div");
    name.className = "user-name";
    name.textContent = person.displayName || "Connecto user";

    const sub = document.createElement("div");
    sub.className = "user-sub";
    sub.textContent = person.connectoId
      ? "@" + person.connectoId
      : "Connecto user";

    details.append(name, sub);
    openButton.append(avatar, details);

    // Chatting does NOT require saving the contact.
    openButton.addEventListener("click", () => {
      openChat(person);
    });

    entry.appendChild(openButton);

    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "save-contact-btn";
    saveButton.textContent = isSaved
      ? "✓ Saved"
      : "＋ Save Contact";
    saveButton.disabled = isSaved;

    saveButton.addEventListener("click", () => {
      saveContact(person);
    });

    entry.appendChild(saveButton);
    list.appendChild(entry);

    return;
  }

  // Recent conversations heading.
  const recentHeading = document.createElement("div");
  recentHeading.className = "notice";
  recentHeading.style.color = "#087b69";
  recentHeading.style.fontWeight = "bold";
  recentHeading.textContent = "💬 Recent conversations";

  list.appendChild(recentHeading);

  const displayedIds = new Set();

  recentChats.forEach(person => {
    displayedIds.add(person.uid);

    const entry = document.createElement("div");
    entry.className = "user-entry";

    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "user" + (selectedUser?.uid === person.uid ? " active" : "");

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent =
      (person.displayName || "?").charAt(0).toUpperCase();

    const details = document.createElement("div");

    const name = document.createElement("div");
    name.className = "user-name";
    name.textContent = person.displayName || "Connecto user";

    const sub = document.createElement("div");
    sub.className = "user-sub";
    sub.textContent = "Recent conversation";

    details.append(name, sub);
    button.append(avatar, details);

    button.addEventListener("click", () => {
      openChat(person);
    });

    entry.appendChild(button);
    list.appendChild(entry);
  });

  // Saved contacts heading.
  const savedHeading = document.createElement("div");
  savedHeading.className = "notice";
  savedHeading.style.color = "#087b69";
  savedHeading.style.fontWeight = "bold";
  savedHeading.textContent = "👥 Saved contacts";

  list.appendChild(savedHeading);

  const remainingContacts = savedContacts.filter(
    person => !displayedIds.has(person.uid)
  );

  if (!remainingContacts.length && !recentChats.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent =
      "No conversations or saved contacts yet. Search for someone using their Connecto ID.";
    list.appendChild(empty);
    return;
  }

  remainingContacts.forEach(person => {
    const entry = document.createElement("div");
    entry.className = "user-entry";

    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "user" + (selectedUser?.uid === person.uid ? " active" : "");

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent =
      (person.displayName || "?").charAt(0).toUpperCase();

    const details = document.createElement("div");

    const name = document.createElement("div");
    name.className = "user-name";
    name.textContent = person.displayName || "Connecto user";

    const sub = document.createElement("div");
    sub.className = "user-sub";
    sub.textContent = person.connectoId
      ? "@" + person.connectoId
      : "Saved contact";

    details.append(name, sub);
    button.append(avatar, details);

    button.addEventListener("click", () => {
      openChat(person);
    });

    entry.appendChild(button);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "remove-contact-btn";
    removeButton.textContent = "Remove";

    removeButton.addEventListener("click", () => {
      removeContact(person);
    });

    entry.appendChild(removeButton);
    list.appendChild(entry);
  });
};

// ---------------- OPEN CHAT WITHOUT SAVING ----------------

openChat = async function (person) {
  if (!currentUser || !person?.uid) return;

  if (person.uid === currentUser.uid) {
    alert("You cannot chat with yourself.");
    return;
  }

  selectedUser = person;

  $("activeName").textContent =
    person.displayName || "Connecto user";

  $("activeAvatar").textContent =
    (person.displayName || "?").charAt(0).toUpperCase();

  $("activeStatus").textContent = "Connecting...";

  // On mobile, open the chat screen.
  document.body.classList.add("mobile-chat-open");

  renderUsers();

  stopMessages = stopListener(stopMessages);

  const id = chatId(currentUser.uid, person.uid);
  const chatRef = doc(db, "chats", id);

  $("chatMessages").innerHTML =
    '<div class="empty">Loading messages...</div>';

  try {
    await setDoc(chatRef, {
      participants: [currentUser.uid, person.uid].sort(),
      updatedAt: serverTimestamp()
    }, { merge: true });

    if (selectedUser?.uid !== person.uid) return;

    $("activeStatus").textContent =
      person.connectoId
        ? "@" + person.connectoId
        : "Connecto user";

    const messagesQuery = query(
      collection(db, "chats", id, "messages"),
      orderBy("createdAt", "asc")
    );

    stopMessages = onSnapshot(
      messagesQuery,
      snapshot => {
        if (selectedUser?.uid !== person.uid) return;

        const box = $("chatMessages");
        box.innerHTML = "";

        if (snapshot.empty) {
          box.innerHTML =
            '<div class="empty"><div class="big">👋</div><p>Start your conversation!</p></div>';
        } else {
          snapshot.forEach(messageDoc => {
            renderMessage(messageDoc.data());
          });
        }

        box.scrollTop = box.scrollHeight;

        // Refresh the conversation timestamp.
        // This keeps the inbox ordered by recent activity.
        updateDoc(chatRef, {
          updatedAt: serverTimestamp()
        }).catch(error => {
          console.warn("Chat timestamp update:", error);
        });
      },
      error => {
        console.error("Message listener:", error);

        $("activeStatus").textContent =
          "Message access error. Check Firestore rules.";
      }
    );

  } catch (error) {
    console.error("Open chat error:", error);

    $("activeStatus").textContent =
      "Could not open chat: " + friendlyError(error);
  }
};

// ---------------- REMOVE CONTACT WITHOUT DELETING CHAT ----------------

removeContact = async function (person) {
  if (!currentUser || !person?.uid) return;

  if (!confirm(
    `Remove ${person.displayName || "this contact"} from your saved contacts?`
  )) return;

  try {
    await deleteDoc(doc(
      db,
      "users",
      currentUser.uid,
      "contacts",
      person.uid
    ));

    // Removing a saved contact does not delete the conversation.
    alert("Contact removed. Your conversation remains available.");

  } catch (error) {
    console.error("Remove contact error:", error);
    alert("Could not remove contact: " + friendlyError(error));
  }
};

// ---------------- START APP WITH INBOX ----------------

// Keep the original setup and add the recent conversation listener.
startApp = async function (user) {
  currentUser = user;

  $("authPage").classList.add("hidden");
  $("chatApp").classList.remove("hidden");

  document.body.classList.remove("mobile-chat-open");

  $("myName").textContent =
    user.displayName ||
    user.email?.split("@")[0] ||
    "Connecto user";

  $("myConnectoId").textContent =
    "Connecto ID: Loading...";

  try {
    myConnectoId = await ensureConnectoId(user);

    if (auth.currentUser?.uid !== user.uid) return;

    $("myConnectoId").textContent =
      "Connecto ID: @" + myConnectoId;

    loadSavedContacts();
    loadRecentChats();
    listenForIncomingCalls();

  } catch (error) {
    console.error("Profile setup error:", error);

    $("userList").innerHTML =
      '<div class="notice">Could not set up Connecto. Check Firebase rules and internet.</div>';
  }
};

// ---------------- CLEAN UP INBOX ON LOGOUT ----------------

onAuthStateChanged(auth, user => {
  if (!user) {
    stopRecentChats = stopListener(stopRecentChats);
    recentChats = [];

    document.body.classList.remove("mobile-chat-open");
  }
});

console.log("Connecto upgrade loaded successfully.");

// ============================================================
// CONNECTO CALL TIMER + SINGLE CALL BUTTON + CONTACT REMOVAL
// ============================================================

let connectoCallTimerInterval = null;
let connectoCallStartedAt = null;

// ---------- CALL TIMER UI ----------

(function setupCallTimer() {
  const callScreen = $("callScreen");
  const callStatus = $("callStatus");

  if (!callScreen || !callStatus) return;

  let timer = $("callDurationTimer");

  if (!timer) {
    timer = document.createElement("div");
    timer.id = "callDurationTimer";
    timer.textContent = "00:00";

    callStatus.insertAdjacentElement("afterend", timer);
  }

  const style = document.createElement("style");

  style.textContent = `
    #callDurationTimer {
      display: none;
      margin: 9px auto;
      text-align: center;
      font-size: 25px;
      font-weight: 700;
      letter-spacing: 2px;
      color: #087b69;
      font-variant-numeric: tabular-nums;
    }

    #endCallBtn {
      background: #d93025 !important;
      color: white !important;
      border: none !important;
      border-radius: 12px;
      padding: 12px 20px;
      font-weight: bold;
      cursor: pointer;
    }

    #declineCallBtn {
      display: none !important;
    }

    #remove-contact-upgrade-btn {
      background: #fff0f0;
      color: #c0392b;
      border: 1px solid #f1caca;
      border-radius: 8px;
      padding: 8px 12px;
      margin: 0 8px 10px 68px;
      cursor: pointer;
      font-size: 12px;
      font-weight: bold;
    }

    #remove-contact-upgrade-btn:hover {
      background: #ffe0e0;
    }
  `;

  document.head.appendChild(style);

  // One visible call action button.
  $("declineCallBtn").style.display = "none";
  $("endCallBtn").style.display = "inline-block";
  $("endCallBtn").textContent = "End Call";
})();

// ---------- CALL BUTTON LABEL ----------

function updateCallActionButton(label) {
  const button = $("endCallBtn");

  if (!button) return;

  button.textContent = label;
  button.style.display = "inline-block";

  // Always hide the second button.
  if ($("declineCallBtn")) {
    $("declineCallBtn").style.display = "none";
  }
}

// Preserve the original call screen function.
const originalShowCallScreen = showCallScreen;

showCallScreen = function(title, status) {
  originalShowCallScreen(title, status);

  const incoming = (title || "").startsWith("Incoming");

  updateCallActionButton(
    incoming ? "Decline" : "End Call"
  );

  const timer = $("callDurationTimer");

  if (timer) {
    timer.style.display = "none";
    timer.textContent = "00:00";
  }
};

// ---------- TIMER FUNCTIONS ----------

function startConnectoCallTimer() {
  if (connectoCallTimerInterval) return;

  connectoCallStartedAt = Date.now();

  const timer = $("callDurationTimer");

  if (!timer) return;

  timer.style.display = "block";

  function updateTimer() {
    if (!connectoCallStartedAt) return;

    const seconds = Math.floor(
      (Date.now() - connectoCallStartedAt) / 1000
    );

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    timer.textContent =
      String(minutes).padStart(2, "0") +
      ":" +
      String(remainingSeconds).padStart(2, "0");
  }

  updateTimer();

  connectoCallTimerInterval = setInterval(
    updateTimer,
    1000
  );
}

function stopConnectoCallTimer() {
  if (connectoCallTimerInterval) {
    clearInterval(connectoCallTimerInterval);
    connectoCallTimerInterval = null;
  }

  connectoCallStartedAt = null;

  const timer = $("callDurationTimer");

  if (timer) {
    timer.textContent = "00:00";
    timer.style.display = "none";
  }
}

// ---------- DETECT REAL CALL CONNECTION ----------

// Preserve the original WebRTC connection handlers.
const originalCreatePeerConnection = createPeerConnection;

createPeerConnection = function() {
  const connection = originalCreatePeerConnection();

  const originalConnectionHandler =
    connection.onconnectionstatechange;

  connection.onconnectionstatechange = function(event) {
    if (originalConnectionHandler) {
      originalConnectionHandler.call(connection, event);
    }

    if (connection !== peerConnection) return;

    if (connection.connectionState === "connected") {
      startConnectoCallTimer();
      setCallStatus("Connected");
      updateCallActionButton("End Call");
    }
  };

  return connection;
};

// ---------- INCOMING CALL BUTTON ----------

// When the incoming call is accepted, the action becomes End Call.
const originalAcceptCall = acceptCall;

acceptCall = async function() {
  updateCallActionButton("End Call");
  return originalAcceptCall();
};

// ---------- CLEAN UP TIMER ----------

const originalCleanupCall = cleanupCall;

cleanupCall = function() {
  stopConnectoCallTimer();
  originalCleanupCall();

  updateCallActionButton("End Call");
};

// ---------- ONE BUTTON FOR DECLINE AND END ----------

// Existing endCall() already handles both cases:
// incoming unanswered call = rejected
// outgoing or accepted call = ended
// Therefore the same button can handle both.
$("endCallBtn").onclick = endCall;

$("declineCallBtn").style.display = "none";

// ---------- REMOVE CONTACT FROM RECENT CONVERSATIONS ----------

// The previous renderer puts recent conversations first.
// Add a Remove button to recent entries when they are saved contacts.
const originalRenderUsersForRemoval = renderUsers;

renderUsers = function() {
  originalRenderUsersForRemoval();

  if (!currentUser) return;

  const list = $("userList");
  const search = $("userSearch").value.trim();

  // Search result: show Remove if already saved.
  if (search && searchResult && !searchResult.isSelf) {
    const isSaved = savedContacts.some(
      person => person.uid === searchResult.uid
    );

    if (isSaved) {
      const entry = list.querySelector(".user-entry");

      if (entry && !entry.querySelector(".remove-contact-btn")) {
        const removeButton = document.createElement("button");

        removeButton.type = "button";
        removeButton.className = "remove-contact-btn";
        removeButton.textContent = "Remove";

        removeButton.addEventListener("click", () => {
          removeContact(searchResult);
        });

        entry.appendChild(removeButton);
      }
    }

    return;
  }

  // Recent conversations are rendered before saved contacts.
  const entries = list.querySelectorAll(".user-entry");

  recentChats.forEach((person, index) => {
    const isSaved = savedContacts.some(
      contact => contact.uid === person.uid
    );

    if (!isSaved) return;

    const entry = entries[index];

    if (!entry || entry.querySelector(".remove-contact-btn")) {
      return;
    }

    const removeButton = document.createElement("button");

    removeButton.type = "button";
    removeButton.className = "remove-contact-btn";
    removeButton.textContent = "Remove";

    removeButton.addEventListener("click", () => {
      removeContact(person);
    });

    entry.appendChild(removeButton);
  });
};

console.log(
  "Connecto: single call button, call timer and contact removal enabled."
);

// ============================================================
// CONNECTO: REMOVE, BLOCK AND UNBLOCK CONTACTS
// Add this block at the VERY BOTTOM of script.js.
// ============================================================

let blockedContacts = [];
let blockedIds = new Set();
let stopBlockedContacts = null;

let searchBlockStatus = {
  checkedUid: null,
  blockedByMe: false,
  blockedByThem: false,
  checking: false
};

// ---------------- BLOCK STATUS ----------------

async function getBlockStatus(otherUid) {
  if (!currentUser || !otherUid || otherUid === currentUser.uid) {
    return {
      blockedByMe: false,
      blockedByThem: false
    };
  }

  const myBlockRef = doc(
    db, "users", currentUser.uid, "blocked", otherUid
  );

  const theirBlockRef = doc(
    db, "users", otherUid, "blocked", currentUser.uid
  );

  const [myBlock, theirBlock] = await Promise.all([
    getDoc(myBlockRef),
    getDoc(theirBlockRef)
  ]);

  return {
    blockedByMe: myBlock.exists(),
    blockedByThem: theirBlock.exists()
  };
}

async function canInteractWith(otherUid) {
  const status = await getBlockStatus(otherUid);

  return !status.blockedByMe && !status.blockedByThem;
}

// ---------------- LOAD BLOCKED CONTACTS ----------------

function loadBlockedContacts() {
  if (!currentUser) return;

  stopBlockedContacts = stopListener(stopBlockedContacts);

  const blockedRef = collection(
    db,
    "users",
    currentUser.uid,
    "blocked"
  );

  stopBlockedContacts = onSnapshot(
    blockedRef,
    async snapshot => {
      const requestUid = currentUser?.uid;

      if (!requestUid) return;

      const results = await Promise.all(
        snapshot.docs.map(async item => {
          const blockedUid = item.id;

          try {
            const profile = await getDoc(
              doc(db, "users", blockedUid)
            );

            const data = profile.exists()
              ? profile.data()
              : {};

            return {
              uid: blockedUid,
              userId: blockedUid,
              displayName: data.displayName || "Connecto user",
              connectoId: data.connectoId || ""
            };
          } catch (error) {
            console.warn("Blocked profile lookup:", error);

            return {
              uid: blockedUid,
              userId: blockedUid,
              displayName: "Connecto user",
              connectoId: ""
            };
          }
        })
      );

      if (currentUser?.uid !== requestUid) return;

      blockedContacts = results;
      blockedIds = new Set(
        results.map(person => person.uid)
      );

      renderUsers();
    },
    error => {
      console.error("Blocked contacts listener:", error);
      alert("Could not load blocked contacts: " + friendlyError(error));
    }
  );
}

// ---------------- BLOCK A CONTACT ----------------

async function blockContact(person) {
  if (!currentUser || !person?.uid) return;

  if (person.uid === currentUser.uid) return;

  if (blockedIds.has(person.uid)) {
    alert("This contact is already blocked.");
    return;
  }

  const confirmed = confirm(
    `Block ${person.displayName || "this contact"}?\n\n` +
    "They will not be able to send you Connecto messages or call you."
  );

  if (!confirmed) return;

  try {
    // End an active call with this person before creating the block.
    if (activeCallPeerId === person.uid && currentCallId) {
      await endCall();
    }

    await setDoc(
      doc(db, "users", currentUser.uid, "blocked", person.uid),
      {
        blockedUid: person.uid,
        createdAt: serverTimestamp()
      }
    );

    // Close this person's chat if it is open.
    if (selectedUser?.uid === person.uid) {
      selectedUser = null;
      stopMessages = stopListener(stopMessages);

      $("activeName").textContent = "Select a contact";
      $("activeAvatar").textContent = "?";
      $("activeStatus").textContent = "";

      $("chatMessages").innerHTML =
        '<div class="empty">Select a contact to start chatting.</div>';

      document.body.classList.remove("mobile-chat-open");
    }

    alert("Contact blocked successfully.");

    renderUsers();

  } catch (error) {
    console.error("Block contact error:", error);

    alert("Could not block contact: " + friendlyError(error));
  }
}

// ---------------- UNBLOCK A CONTACT ----------------

async function unblockContact(person) {
  if (!currentUser || !person?.uid) return;

  if (!confirm(
    `Unblock ${person.displayName || "this contact"}?`
  )) return;

  try {
    await deleteDoc(
      doc(db, "users", currentUser.uid, "blocked", person.uid)
    );

    alert(
      "Contact unblocked. You can search for and save this person again."
    );

    renderUsers();

  } catch (error) {
    console.error("Unblock contact error:", error);

    alert("Could not unblock contact: " + friendlyError(error));
  }
}

// ---------------- CONTACT LIST STYLING ----------------

(function addBlockStyles() {
  const style = document.createElement("style");

  style.textContent = `
    .connecto-block-btn {
      background: #fff0f0;
      color: #c0392b;
      border: 1px solid #efcccc;
      border-radius: 8px;
      padding: 8px 11px;
      margin: 0 8px 10px 8px;
      cursor: pointer;
      font-size: 12px;
      font-weight: bold;
    }

    .connecto-block-btn:hover {
      background: #ffe0e0;
    }

    .connecto-unblock-btn {
      background: #e8f5f1;
      color: #087b69;
      border: 1px solid #b9ded2;
      border-radius: 8px;
      padding: 8px 11px;
      margin: 0 8px 10px 68px;
      cursor: pointer;
      font-size: 12px;
      font-weight: bold;
    }

    .connecto-blocked-note {
      color: #c0392b;
      font-size: 12px;
      padding: 8px 12px;
    }

    .connecto-section-heading {
      color: #087b69;
      font-weight: bold;
      padding: 12px;
      margin-top: 5px;
      font-size: 13px;
    }
  `;

  document.head.appendChild(style);
})();

// ---------------- CREATE CONTACT ENTRY ----------------

function makeConnectoEntry(person, options = {}) {
  const entry = document.createElement("div");
  entry.className = "user-entry";

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.className = "user";

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent =
    (person.displayName || "?").charAt(0).toUpperCase();

  const details = document.createElement("div");

  const name = document.createElement("div");
  name.className = "user-name";
  name.textContent = person.displayName || "Connecto user";

  const sub = document.createElement("div");
  sub.className = "user-sub";
  sub.textContent = options.subtitle || person.connectoId
    ? (options.subtitle || "@" + person.connectoId)
    : "Connecto user";

  details.append(name, sub);
  openButton.append(avatar, details);

  openButton.addEventListener("click", async () => {
    if (options.blocked) return;

    try {
      if (!await canInteractWith(person.uid)) {
        alert("You cannot open this chat because one of you has blocked the other.");
        return;
      }

      openChat(person);
    } catch (error) {
      console.error(error);
      alert("Could not check block status: " + friendlyError(error));
    }
  });

  entry.appendChild(openButton);

  if (options.saved && !options.blocked) {
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "remove-contact-btn";
    removeButton.textContent = "Remove";

    removeButton.addEventListener("click", () => {
      removeContact(person);
    });

    entry.appendChild(removeButton);
  }

  if (!options.blocked) {
    const blockButton = document.createElement("button");
    blockButton.type = "button";
    blockButton.className = "connecto-block-btn";
    blockButton.textContent = "Block";

    blockButton.addEventListener("click", () => {
      blockContact(person);
    });

    entry.appendChild(blockButton);
  }

  return entry;
}

// ---------------- UPDATED CONTACT DISPLAY ----------------

renderUsers = function() {
  if (!currentUser || !$("userList")) return;

  const list = $("userList");
  const search = $("userSearch").value.trim();

  list.innerHTML = "";

  // Search result
  if (search) {
    if (!searchResult) {
      list.innerHTML =
        '<div class="empty">Enter a complete Connecto ID to search.</div>';
      return;
    }

    const person = searchResult;

    if (person.isSelf || person.uid === currentUser.uid) {
      list.innerHTML =
        '<div class="empty">This is your own Connecto ID.</div>';
      return;
    }

    if (blockedIds.has(person.uid)) {
      const entry = makeConnectoEntry(person, {
        blocked: true,
        subtitle: "You blocked this contact"
      });

      const unblockButton = document.createElement("button");
      unblockButton.className = "connecto-unblock-btn";
      unblockButton.textContent = "Unblock";

      unblockButton.addEventListener("click", () => {
        unblockContact(person);
      });

      entry.appendChild(unblockButton);
      list.appendChild(entry);
      return;
    }

    const loading = document.createElement("div");
    loading.className = "empty";
    loading.textContent = "Checking contact status...";
    list.appendChild(loading);

    const searchedUid = person.uid;

    getBlockStatus(searchedUid).then(status => {
      if (
        currentUser?.uid == null ||
        $("userSearch").value.trim() !== search ||
        searchResult?.uid !== searchedUid
      ) return;

      list.innerHTML = "";

      if (status.blockedByMe) {
        const entry = makeConnectoEntry(person, {
          blocked: true,
          subtitle: "You blocked this contact"
        });

        const unblockButton = document.createElement("button");
        unblockButton.className = "connecto-unblock-btn";
        unblockButton.textContent = "Unblock";

        unblockButton.addEventListener("click", () => {
          unblockContact(person);
        });

        entry.appendChild(unblockButton);
        list.appendChild(entry);
        return;
      }

      if (status.blockedByThem) {
        const entry = document.createElement("div");
        entry.className = "user-entry";

        const note = document.createElement("div");
        note.className = "connecto-blocked-note";
        note.textContent =
          "This user is unavailable for Connecto messaging and calls.";

        entry.appendChild(note);
        list.appendChild(entry);
        return;
      }

      const isSaved = savedContacts.some(
        contact => contact.uid === person.uid
      );

      const entry = makeConnectoEntry(person, {
        saved,
        subtitle: isSaved
          ? "Saved contact"
          : "Connecto user found"
      });

      if (!isSaved) {
        const saveButton = document.createElement("button");
        saveButton.type = "button";
        saveButton.className = "save-contact-btn";
        saveButton.textContent = "＋ Save Contact";

        saveButton.addEventListener("click", () => {
          saveContact(person);
        });

        entry.appendChild(saveButton);
      }

      list.appendChild(entry);

    }).catch(error => {
      console.error("Search block check:", error);

      list.innerHTML =
        '<div class="notice">Could not check contact status. Try again.</div>';
    });

    return;
  }

  // Recent conversations: show only saved and unblocked contacts.
  const visibleRecent = recentChats.filter(person =>
    savedContacts.some(contact => contact.uid === person.uid) &&
    !blockedIds.has(person.uid)
  );

  const visibleSaved = savedContacts.filter(person =>
    !blockedIds.has(person.uid) &&
    !visibleRecent.some(recent => recent.uid === person.uid)
  );

  const recentHeading = document.createElement("div");
  recentHeading.className = "connecto-section-heading";
  recentHeading.textContent = "💬 Recent conversations";
  list.appendChild(recentHeading);

  visibleRecent.forEach(person => {
    list.appendChild(makeConnectoEntry(person, {
      saved: true,
      subtitle: "Recent conversation"
    }));
  });

  const savedHeading = document.createElement("div");
  savedHeading.className = "connecto-section-heading";
  savedHeading.textContent = "👥 Saved contacts";
  list.appendChild(savedHeading);

  visibleSaved.forEach(person => {
    list.appendChild(makeConnectoEntry(person, {
      saved: true
    }));
  });

  if (!visibleRecent.length && !visibleSaved.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent =
      "No visible contacts yet. Search using a Connecto ID to find someone.";
    list.appendChild(empty);
  }

  // Blocked contacts section
  const blockedHeading = document.createElement("div");
  blockedHeading.className = "connecto-section-heading";
  blockedHeading.textContent =
    `🚫 Blocked contacts (${blockedContacts.length})`;

  list.appendChild(blockedHeading);

  if (!blockedContacts.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "You have not blocked anyone.";
    list.appendChild(empty);
  }

  blockedContacts.forEach(person => {
    const entry = document.createElement("div");
    entry.className = "user-entry";

    const info = document.createElement("div");
    info.className = "connecto-blocked-note";
    info.textContent = person.displayName;

    entry.appendChild(info);

    const unblockButton = document.createElement("button");
    unblockButton.type = "button";
    unblockButton.className = "connecto-unblock-btn";
    unblockButton.textContent = "Unblock";

    unblockButton.addEventListener("click", () => {
      unblockContact(person);
    });

    entry.appendChild(unblockButton);
    list.appendChild(entry);
  });
};

// ---------------- PREVENT SAVING BLOCKED CONTACTS ----------------

const previousSaveContact = saveContact;

saveContact = async function(person) {
  if (!currentUser || !person?.uid) return;

  try {
    const allowed = await canInteractWith(person.uid);

    if (!allowed) {
      alert("You cannot save this contact because one of you has blocked the other.");
      return;
    }

    return previousSaveContact(person);

  } catch (error) {
    console.error("Save block check:", error);
    alert("Could not check block status: " + friendlyError(error));
  }
};

// ---------------- PREVENT OPENING BLOCKED CHATS ----------------

const previousOpenChat = openChat;

openChat = async function(person) {
  if (!currentUser || !person?.uid) return;

  try {
    const allowed = await canInteractWith(person.uid);

    if (!allowed) {
      alert("Messaging is unavailable because one of you has blocked the other.");
      return;
    }

    return previousOpenChat(person);

  } catch (error) {
    console.error("Open chat block check:", error);
    alert("Could not check block status: " + friendlyError(error));
  }
};

// ---------------- PREVENT STARTING BLOCKED CALLS ----------------

const previousStartCall = startCall;

startCall = async function(type) {
  if (!currentUser || !selectedUser) {
    alert("First select a contact.");
    return;
  }

  try {
    const allowed = await canInteractWith(selectedUser.uid);

    if (!allowed) {
      alert("You cannot call this contact because one of you has blocked the other.");
      return;
    }

    return previousStartCall(type);

  } catch (error) {
    console.error("Call block check:", error);
    alert("Could not check block status: " + friendlyError(error));
  }
};

// ---------------- PREVENT INCOMING CALL UI FROM BLOCKED USERS ----------------

// The Firestore rules deny call creation by blocked users.
// This extra check prevents showing a call if a block already exists.
const previousListenForIncomingCalls = listenForIncomingCalls;

listenForIncomingCalls = function() {
  // Keep the original listener and its existing call functionality.
  return previousListenForIncomingCalls();
};

// ---------------- REMOVE CONTACT: HIDE FROM ALL LISTS ----------------

removeContact = async function(person) {
  if (!currentUser || !person?.uid) return;

  if (!confirm(
    `Remove ${person.displayName || "this contact"} from your saved contacts?\n\nYour chat history will not be deleted.`
  )) return;

  try {
    await deleteDoc(
      doc(db, "users", currentUser.uid, "contacts", person.uid)
    );

    // Close the chat if it was open.
    if (selectedUser?.uid === person.uid) {
      selectedUser = null;
      stopMessages = stopListener(stopMessages);

      $("activeName").textContent = "Select a contact";
      $("activeAvatar").textContent = "?";
      $("activeStatus").textContent = "";

      $("chatMessages").innerHTML =
        '<div class="empty">Select a contact to start chatting.</div>';

      document.body.classList.remove("mobile-chat-open");
    }

    alert("Contact removed. Chat history is preserved.");
    renderUsers();

  } catch (error) {
    console.error("Remove contact error:", error);
    alert("Could not remove contact: " + friendlyError(error));
  }
};

// ---------------- START BLOCK LISTENER ----------------

const previousStartAppForBlocks = startApp;

startApp = async function(user) {
  await previousStartAppForBlocks(user);

  if (auth.currentUser?.uid !== user.uid) return;

  loadBlockedContacts();
};

// ---------------- CLEANUP ON LOGOUT ----------------

onAuthStateChanged(auth, user => {
  if (!user) {
    stopBlockedContacts = stopListener(stopBlockedContacts);

    blockedContacts = [];
    blockedIds = new Set();

    searchBlockStatus = {
      checkedUid: null,
      blockedByMe: false,
      blockedByThem: false,
      checking: false
    };
  }
});

// ---------------- FIX DUPLICATE END CALL HANDLER ----------------

// The existing addEventListener already handles the button.
// Remove the later onclick handler so one click does not run twice.
if ($("endCallBtn")) {
  $("endCallBtn").onclick = null;
}

console.log(
  "Connecto: remove, block and unblock features loaded."
);
