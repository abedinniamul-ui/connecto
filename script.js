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
  deleteField,
  query,
  where,
  orderBy,
  onSnapshot,
  updateDoc,
  serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/12.5.0/firebase-firestore.js";

import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.5.0/firebase-storage.js";

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
const storage = getStorage(firebaseApp);

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

const callServers = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: "max-bundle"
};

// ================= GENERAL HELPERS =================

function showError(message) {
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

  return messages[error.code] || error.message || "Something went wrong.";
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
    user.displayName || user.email?.split("@")[0] || "Connecto user";

  const userRef = doc(db, "users", uid);
  const prefix = makeIdPrefix(displayName);

  for (let attempt = 0; attempt < 30; attempt++) {
    const candidate = attempt === 0
      ? null
      : `${prefix}${Math.floor(1000 + Math.random() * 9000)}`;

    const result = await runTransaction(db, async transaction => {
      const userSnapshot = await transaction.get(userRef);

      const existingId = userSnapshot.exists()
        ? userSnapshot.data().connectoId
        : null;

      const connectoId = existingId || candidate;

      if (!connectoId) return null;

      const mappingRef = doc(db, "connectoIds", connectoId);
      const mappingSnapshot = await transaction.get(mappingRef);

      if (mappingSnapshot.exists()) {
        if (mappingSnapshot.data().uid !== uid) {
          return null;
        }
      } else {
        transaction.set(mappingRef, {
          uid,
          createdAt: serverTimestamp()
        });
      }

      transaction.set(userRef, {
        uid,
        userId: uid,
        connectoId,
        displayName
      }, { merge: true });

      return connectoId;
    });

    if (result) return result;
  }

  throw new Error("Could not generate a unique Connecto ID. Please try again.");
}

// ================= COPY CONNECTO ID =================

$("copyConnectoIdBtn").addEventListener("click", async () => {
  if (!myConnectoId) {
    alert("Your Connecto ID is not ready yet.");
    return;
  }

  try {
    await navigator.clipboard.writeText(myConnectoId);

    $("copyConnectoIdBtn").textContent = "✓ Copied";

    setTimeout(() => {
      $("copyConnectoIdBtn").textContent = "📋 Copy ID";
    }, 2000);

  } catch (error) {
    console.error("Copy ID error:", error);
    alert("Your Connecto ID is: " + myConnectoId);
  }
});

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

$("enableNotificationsBtn").addEventListener(
  "click",
  enableNotifications
);

function showMissedCallNotification(callerName, missedCallId) {
  if (!currentUser || !missedCallId) return;

  const storageKey = `connecto_missed_${currentUser.uid}`;

  let notified = [];

  try {
    notified = JSON.parse(localStorage.getItem(storageKey) || "[]");
    if (!Array.isArray(notified)) notified = [];
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
    localStorage.setItem(storageKey, JSON.stringify(notified.slice(-100)));
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

    await updateProfile(result.user, { displayName: name });

    await setDoc(doc(db, "users", result.user.uid), {
      uid: result.user.uid,
      userId: result.user.uid,
      displayName: name,
      createdAt: serverTimestamp()
    });

  } catch (error) {
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
    showError("Password reset email sent. Check your inbox and spam folder.");

  } catch (error) {
    showError(friendlyError(error));
  } finally {
    $("forgotPassword").disabled = false;
  }
});

// ================= PRIVATE SAVED CONTACTS =================

function loadSavedContacts() {
  if (!currentUser) return;

  if (stopSavedContacts) stopSavedContacts();

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

      if (stopMessages) {
        stopMessages();
        stopMessages = null;
      }

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

  if (!enteredId) {
    searchResult = null;
    renderUsers();
    return;
  }

  if (enteredId === myConnectoId) {
    searchResult = { uid: currentUser.uid, isSelf: true };
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
      searchResult = null;
      $("userList").innerHTML =
        '<div class="empty">No user found with this Connecto ID.</div>';
      return;
    }

    const uid = mappingSnapshot.data().uid;

    const userSnapshot = await getDoc(doc(db, "users", uid));

    if (thisRequest !== searchRequestNumber) return;

    if (!userSnapshot.exists()) {
      searchResult = null;
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

    if (searchResult.isSelf || searchResult.uid === currentUser.uid) {
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
    saveButton.textContent = isSaved ? "✓ Saved" : "＋ Save Contact";
    saveButton.disabled = isSaved;

    saveButton.addEventListener("click", () => saveContact(person));

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
      person.connectoId ? "@" + person.connectoId : "Saved contact";

    button.append(avatar, details);
    button.addEventListener("click", () => openChat(person));
    entry.appendChild(button);

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "remove-contact-btn";
    removeButton.textContent = "Remove";

    removeButton.addEventListener("click", () => removeContact(person));

    entry.appendChild(removeButton);
    list.appendChild(entry);
  });
}

// ================= CHAT MESSAGES =================

function renderMessage(message) {
  const bubble = document.createElement("div");

  bubble.className =
    "bubble" + (message.senderId === currentUser.uid ? " mine" : "");

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

  if (stopMessages) {
    stopMessages();
    stopMessages = null;
  }

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

        snapshot.forEach(messageDoc => renderMessage(messageDoc.data()));
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
  if (!selectedUser) {
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
    if (!selectedUser) {
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

  if (!selectedUser) {
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
    throw new Error("Camera and microphone require HTTPS or localhost.");
  }

  return navigator.mediaDevices.getUserMedia({
    audio: true,
    video: type === "video"
      ? { facingMode: { ideal: cameraFacingMode } }
      : false
  });
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
      video: { facingMode: { ideal: newFacingMode } },
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

    localStream = new MediaStream([...audioTracks, newTrack]);

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
  peerConnection = new RTCPeerConnection(callServers);

  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.ontrack = event => {
    if (!event.streams?.[0]) return;

    $("remoteVideo").srcObject = event.streams[0];
    $("remoteVideo").style.display = "block";

    $("remoteVideo").play().catch(error => {
      console.warn("Remote video autoplay:", error);
    });
  };

  peerConnection.onicecandidate = async event => {
    if (!event.candidate || !currentCallId || !currentUser) return;

    const callIdAtCandidate = currentCallId;

    try {
      await addDoc(
        collection(db, "calls", callIdAtCandidate, "candidates"),
        {
          senderId: currentUser.uid,
          candidate: event.candidate.toJSON()
        }
      );
    } catch (error) {
      console.error("ICE candidate error:", error);
    }
  };

  peerConnection.onconnectionstatechange = async () => {
    if (!peerConnection) return;

    const state = peerConnection.connectionState;

    if (state === "connected") {
      $("callStatus").textContent = "Connected";

      clearTimeout(connectionTimeout);
      connectionTimeout = null;

      clearTimeout(disconnectTimeout);
      disconnectTimeout = null;
    }

    if (state === "connecting") {
      $("callStatus").textContent = "Connecting...";
    }

    if (state === "disconnected" && !disconnectTimeout) {
      const disconnectedCallId = currentCallId;

      $("callStatus").textContent =
        "Connection interrupted. Reconnecting...";

      disconnectTimeout = setTimeout(async () => {
        if (
          currentCallId !== disconnectedCallId ||
          !peerConnection ||
          peerConnection.connectionState === "connected"
        ) return;

        try {
          await updateDoc(doc(db, "calls", disconnectedCallId), {
            status: "ended"
          });
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

      if (failedCallId) {
        try {
          await updateDoc(doc(db, "calls", failedCallId), {
            status: "ended"
          });
        } catch (error) {
          console.error("Failed call update:", error);
        }
      }

      if (currentCallId === failedCallId) {
        alert("Call connection failed. Please try again.");
        cleanupCall();
      }
    }
  };
}

// ================= REMOTE ICE CANDIDATES =================

async function addPendingCandidates() {
  if (!peerConnection?.remoteDescription) return;

  while (pendingRemoteCandidates.length) {
    const candidate = pendingRemoteCandidates.shift();

    try {
      await peerConnection.addIceCandidate(
        new RTCIceCandidate(candidate)
      );
    } catch (error) {
      console.error("Pending ICE candidate error:", error);
    }
  }
}

function listenForRemoteCandidates() {
  if (candidateUnsub) candidateUnsub();

  pendingRemoteCandidates = [];

  const listeningCallId = currentCallId;

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

        try {
          await peerConnection.addIceCandidate(
            new RTCIceCandidate(data.candidate)
          );
        } catch (error) {
          console.error("Remote candidate error:", error);
        }
      });
    },
    error => console.error("Candidate listener error:", error)
  );
}

// ================= WATCH CALL DOCUMENT =================

function watchCallDocument() {
  if (callUnsub) callUnsub();

  const watchedCallId = currentCallId;

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
          showMissedCallNotification(data.callerName, watchedCallId);
        }

        cleanupCall();
        return;
      }

      if (data.status === "rejected") {
        if (isCaller) alert("The call was rejected.");
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

        $("callStatus").textContent = "Connecting...";

        if (!connectionTimeout) {
          connectionTimeout = setTimeout(async () => {
            if (
              currentCallId !== watchedCallId ||
              !peerConnection ||
              peerConnection.connectionState === "connected"
            ) return;

            try {
              await updateDoc(doc(db, "calls", watchedCallId), {
                status: "ended"
              });
            } catch (error) {
              console.error("Connection timeout update:", error);
            }

            if (currentCallId === watchedCallId) {
              alert("Could not establish the call connection. Please try again.");
              cleanupCall();
            }
          }, 30000);
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
          $("callStatus").textContent = "Connecting...";
        } catch (error) {
          console.error("Answer error:", error);
        }
      }
    },
    error => console.error("Call document listener:", error)
  );
}

// ================= CLEANUP CALL =================

function cleanupCall() {
  callAttempt++;

  clearTimeout(callTimeout);
  clearTimeout(connectionTimeout);
  clearTimeout(disconnectTimeout);

  callTimeout = null;
  connectionTimeout = null;
  disconnectTimeout = null;

  if (callUnsub) {
    callUnsub();
    callUnsub = null;
  }

  if (candidateUnsub) {
    candidateUnsub();
    candidateUnsub = null;
  }

  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
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

    await setDoc(callRef, {
      callerId: currentUser.uid,
      callerName: currentUser.displayName || "Connecto user",
      receiverId: recipient.uid,
      participants: [currentUser.uid, recipient.uid],
      type,
      status: "preparing",
      createdAt: serverTimestamp()
    });

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    const ringingAllowed = await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(callRef);

      if (!snapshot.exists()) return false;
      if (snapshot.data().status !== "preparing") return false;

      transaction.update(callRef, {
        offer: { type: offer.type, sdp: offer.sdp },
        status: "ringing"
      });

      return true;
    });

    if (!ringingAllowed || thisAttempt !== callAttempt) {
      cleanupCall();
      return;
    }

    listenForRemoteCandidates();
    watchCallDocument();

    $("callStatus").textContent =
      "Calling " + (recipient.displayName || "user") + "...";

    const thisCallId = currentCallId;

    callTimeout = setTimeout(async () => {
      if (currentCallId !== thisCallId || callAccepted) return;

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

      if (currentCallId === thisCallId && !callAccepted) {
        cleanupCall();
      }
    }, 30000);

  } catch (error) {
    console.error("Call error:", error);
    alert("Could not start call: " + friendlyError(error));
    cleanupCall();
  }
}

// ================= INCOMING CALL LISTENER =================

function listenForIncomingCalls() {
  if (incomingCallUnsub) {
    incomingCallUnsub();
    incomingCallUnsub = null;
  }

  if (!currentUser) return;

  const callsQuery = query(
    collection(db, "calls"),
    where("participants", "array-contains", currentUser.uid)
  );

  incomingCallUnsub = onSnapshot(
    callsQuery,
    async snapshot => {
      for (const change of snapshot.docChanges()) {
        if (change.type !== "added" && change.type !== "modified") continue;

        const data = change.doc.data();
        const changedCallId = change.doc.id;

        if (data.receiverId !== currentUser.uid) continue;

        const simultaneousCall =
          isCaller &&
          activeCallPeerId === data.callerId &&
          ["preparing", "ringing"].includes(data.status);

        if (simultaneousCall && !simultaneousCallDetected) {
          simultaneousCallDetected = true;

          const outgoingId = currentCallId;

          try {
            await runTransaction(db, async transaction => {
              const incomingRef = doc(db, "calls", changedCallId);
              const incomingSnapshot = await transaction.get(incomingRef);

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
                transaction.update(incomingRef, { status: "ended" });
              }

              if (
                outgoingSnapshot?.exists() &&
                ["preparing", "ringing"].includes(
                  outgoingSnapshot.data().status
                )
              ) {
                transaction.update(outgoingRef, { status: "ended" });
              }
            });
          } catch (error) {
            console.error("Simultaneous call cancellation:", error);
          }

          cleanupCall();
          alert("You called each other at the same time. Please call again.");
          continue;
        }

        if (data.status === "missed") {
          if (isRecentMissedCall(data)) {
            showMissedCallNotification(
              data.callerName || "Connecto user",
              changedCallId
            );
          }

          if (currentCallId === changedCallId && !isCaller) {
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
        if (currentCallId || peerConnection || isCaller) continue;

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
          data.type === "video" ? "Incoming Video Call" : "Incoming Voice Call",
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
    error => console.error("Incoming call listener:", error)
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

    localStream = await getCallMedia(acceptedIncomingCall.type);

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
      acceptedIncomingCall.type === "video" ? "block" : "none";

    createPeerConnection();

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(acceptedIncomingCall.offer)
    );

    await addPendingCandidates();
    listenForRemoteCandidates();

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    const accepted = await runTransaction(db, async transaction => {
      const callRef = doc(db, "calls", acceptedCallId);
      const snapshot = await transaction.get(callRef);

      if (!snapshot.exists()) return false;
      if (snapshot.data().status !== "ringing") return false;

      transaction.update(callRef, {
        answer: { type: answer.type, sdp: answer.sdp },
        status: "accepted"
      });

      return true;
    });

    if (!accepted || currentCallId !== acceptedCallId) {
      cleanupCall();
      return;
    }

    callAccepted = true;

    clearTimeout(callTimeout);
    callTimeout = null;

    watchCallDocument();

    $("acceptCallBtn").style.display = "none";
    $("callStatus").textContent = "Connecting...";

  } catch (error) {
    console.error("Accept call error:", error);
    alert("Could not accept call: " + friendlyError(error));

    try {
      await updateDoc(doc(db, "calls", acceptedCallId), {
        status: "rejected"
      });
    } catch (updateError) {
      console.error("Could not update rejected call:", updateError);
    }

    cleanupCall();

  } finally {
    $("acceptCallBtn").disabled = false;
  }
}

// ================= END / DECLINE CALL =================

async function endCall() {
  const endingCallId = currentCallId;

  if (!endingCallId) {
    cleanupCall();
    return;
  }

  const status = (isCaller || callAccepted) ? "ended" : "rejected";

  try {
    await updateDoc(doc(db, "calls", endingCallId), { status });
  } catch (error) {
    console.error("End call error:", error);
  }

  if (currentCallId === endingCallId) cleanupCall();
}

// ================= CALL BUTTONS =================

$("voiceCallBtn").addEventListener("click", () => startCall("audio"));
$("videoCallBtn").addEventListener("click", () => startCall("video"));
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
    user.displayName || user.email?.split("@")[0] || "Connecto user";

  $("myConnectoId").textContent = "Connecto ID: Loading...";

  try {
    myConnectoId = await ensureConnectoId(user);

    $("myConnectoId").textContent = "Connecto ID: @" + myConnectoId;

    loadSavedContacts();
    listenForIncomingCalls();

    await setDoc(
      doc(db, "users", user.uid),
      { email: deleteField() },
      { merge: true }
    );

  } catch (error) {
    console.error("Profile setup error:", error);

    $("userList").innerHTML =
      '<div class="notice">Could not set up your Connecto ID. Check Firestore rules.</div>';
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

    if (incomingCallUnsub) {
      incomingCallUnsub();
      incomingCallUnsub = null;
    }

    if (stopSavedContacts) {
      stopSavedContacts();
      stopSavedContacts = null;
    }

    if (stopMessages) {
      stopMessages();
      stopMessages = null;
    }

    currentUser = null;
    selectedUser = null;
    myConnectoId = "";

    savedContacts = [];
    searchResult = null;
    searchRequestNumber++;

    $("authPage").classList.remove("hidden");
    $("chatApp").classList.add("hidden");

    $("myConnectoId").textContent = "Connecto ID: Not logged in";
    $("userList").innerHTML = "";

    showLogin();
  }
});