
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
let currentAuthUid = null;
let selectedUser = null;
let myConnectoId = "";

let savedContacts = [];
let inboxUsers = [];
let searchResult = null;
let searchRequestNumber = 0;

let stopMessages = null;
let stopSavedContacts = null;
let stopInbox = null;

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

let callDurationInterval = null;
let callStartedAt = null;

let remoteDescriptionSet = false;
let answerApplying = false;

let stopHiddenChats = null;
let hiddenChatIds = new Set();
// ================= WEBRTC SERVERS =================

const callServers = {
  iceServers: [
    // STUN servers
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },

    // TURN server — replace these with real credentials
    {
      urls: [
        "turn:YOUR_TURN_SERVER:3478?transport=udp",
        "turn:YOUR_TURN_SERVER:3478?transport=tcp",
        "turns:YOUR_TURN_SERVER:5349?transport=tcp"
      ],
      username: "YOUR_TURN_USERNAME",
      credential: "YOUR_TURN_CREDENTIAL"
    }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: "max-bundle"
};
// ================= GENERAL HELPERS =================

function on(id, event, callback) {
  const element = $(id);

  if (element) {
    element.addEventListener(event, callback);
  }
}

function stopListener(listener) {
  if (typeof listener === "function") {
    try {
      listener();
    } catch (error) {
      console.warn("Listener cleanup:", error);
    }
  }

  return null;
}

function showError(message, success = false) {
  if (!$("authStatus")) return;

  $("authStatus").textContent = message;
  $("authStatus").style.color =
    success ? "#087b69" : "#c0392b";
}

function friendlyError(error) {
  const messages = {
    "auth/email-already-in-use":
      "This email already has an account.",
    "auth/invalid-email":
      "Please enter a valid email.",
    "auth/weak-password":
      "Password must have at least 6 characters.",
    "auth/invalid-credential":
      "Email or password is incorrect.",
    "auth/network-request-failed":
      "Network error. Check your internet.",
    "auth/user-not-found":
      "No account found with this email.",
    "auth/too-many-requests":
      "Too many attempts. Try again later.",
    "permission-denied":
      "Access denied. Check your Firebase security rules."
  };

  return messages[error?.code] ||
    error?.message ||
    "Something went wrong.";
}

function chatId(uid1, uid2) {
  return [uid1, uid2].sort().join("__");
}

function setCallStatus(message) {
  if ($("callStatus")) {
    $("callStatus").textContent = message;
  }
}

function isMobileLayout() {
  return window.matchMedia("(max-width: 650px)").matches;
}

function showMobileChat() {
  if (isMobileLayout() && $("chatApp")) {
    $("chatApp").classList.add("mobile-chat-open");
  }
}

function showMobileContacts() {
  if ($("chatApp")) {
    $("chatApp").classList.remove("mobile-chat-open");
  }
}

// ================= CONNECTO ID =================

function makeIdPrefix(name) {
  return (
    (name || "user")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 12) || "user"
  );
}

async function ensureConnectoId(user) {
  const userRef = doc(db, "users", user.uid);

  const displayName =
    user.displayName ||
    user.email?.split("@")[0] ||
    "Connecto user";

  const prefix = makeIdPrefix(displayName);

  for (let attempt = 0; attempt < 60; attempt++) {
    const candidate =
      `${prefix}${Math.floor(1000 + Math.random() * 9000)}`;

    const result = await runTransaction(db, async transaction => {
      const profile = await transaction.get(userRef);

      const existing = profile.exists()
        ? profile.data().connectoId
        : null;

      let chosen = existing || candidate;
      let mapRef = doc(db, "connectoIds", chosen);
      let mapping = await transaction.get(mapRef);

      if (
        mapping.exists() &&
        mapping.data().uid !== user.uid
      ) {
        chosen = candidate;
        mapRef = doc(db, "connectoIds", chosen);
        mapping = await transaction.get(mapRef);
      }

      if (
        mapping.exists() &&
        mapping.data().uid !== user.uid
      ) {
        return null;
      }

      if (!mapping.exists()) {
        transaction.set(mapRef, {
          uid: user.uid,
          createdAt: serverTimestamp()
        });
      }

      transaction.set(
        userRef,
        {
          uid: user.uid,
          userId: user.uid,
          connectoId: chosen,
          displayName
        },
        { merge: true }
      );

      return chosen;
    });

    if (result) return result;
  }

  throw new Error(
    "Could not create a unique Connecto ID. Please try again."
  );
}

on("copyConnectoIdBtn", "click", async () => {
  if (!myConnectoId) {
    alert("Your Connecto ID is not ready yet.");
    return;
  }

  try {
    await navigator.clipboard.writeText(myConnectoId);

    $("copyConnectoIdBtn").textContent = "✓ Copied";

    setTimeout(() => {
      if ($("copyConnectoIdBtn")) {
        $("copyConnectoIdBtn").textContent = "📋 Copy ID";
      }
    }, 1800);

  } catch {
    prompt("Copy your Connecto ID:", myConnectoId);
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

    alert(
      permission === "granted"
        ? "Connecto notifications enabled!"
        : "Please allow notifications in browser settings."
    );

  } catch (error) {
    console.error("Notification permission:", error);
  }
}

on("enableNotificationsBtn", "click", enableNotifications);

function showMissedCallNotification(callerName, missedCallId) {
  if (!currentUser || !missedCallId) return;

  const key = `connecto_missed_${currentUser.uid}`;
  let notified = [];

  try {
    notified = JSON.parse(localStorage.getItem(key) || "[]");

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
        tag: `connecto-${missedCallId}`
      });

      notification.onclick = () => {
        window.focus();
        notification.close();
      };

    } catch {
      alert(`${title}\n${body}`);
    }
  } else {
    alert(`${title}\n${body}`);
  }

  notified.push(missedCallId);

  try {
    localStorage.setItem(
      key,
      JSON.stringify(notified.slice(-100))
    );
  } catch {}
}

function isRecentMissedCall(data) {
  if (!data.missedAt) return false;

  const time = data.missedAt.toDate
    ? data.missedAt.toDate().getTime()
    : new Date(data.missedAt).getTime();

  return (
    Number.isFinite(time) &&
    Date.now() - time >= 0 &&
    Date.now() - time < 10 * 60 * 1000
  );
}

// ================= AUTH UI =================

function showLogin() {
  $("loginBox").classList.remove("hidden");
  $("signupBox").classList.add("hidden");
  showError("");
}

on("showSignup", "click", () => {
  $("loginBox").classList.add("hidden");
  $("signupBox").classList.remove("hidden");
  showError("");
});

on("showLogin", "click", showLogin);

// ================= SIGNUP =================

on("signupBtn", "click", async () => {
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

  $("signupBtn").disabled = true;

  try {
    const result = await createUserWithEmailAndPassword(
      auth,
      email,
      password
    );

    await updateProfile(result.user, {
      displayName: name
    });

    await setDoc(
      doc(db, "users", result.user.uid),
      {
        uid: result.user.uid,
        userId: result.user.uid,
        displayName: name,
        createdAt: serverTimestamp()
      },
      { merge: true }
    );

  } catch (error) {
    console.error("Signup:", error);
    showError(friendlyError(error));

  } finally {
    $("signupBtn").disabled = false;
  }
});

// ================= LOGIN =================

on("loginBtn", "click", async () => {
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;

  if (!email || !password) {
    showError("Enter your email and password.");
    return;
  }

  $("loginBtn").disabled = true;

  try {
    await signInWithEmailAndPassword(auth, email, password);

    } catch (error) {
    console.error("LOGIN ERROR:", error);
    showError(friendlyError(error));
  } finally {
    $("loginBtn").disabled = false;
  }
});

// ================= FORGOT PASSWORD =================

on("forgotPassword", "click", async () => {
  const email = $("loginEmail").value.trim();

  if (!email) {
    showError("Enter your email address first.");
    $("loginEmail").focus();
    return;
  }

  $("forgotPassword").disabled = true;

  try {
    await sendPasswordResetEmail(auth, email);

    showError(
      "Password reset email sent. Check your inbox and spam folder.",
      true
    );

    } catch (error) {
    console.error("LOGIN ERROR:", error);
    showError(friendlyError(error));
  } finally {
    $("forgotPassword").disabled = false;
  }
})
// ================= CONTACTS + INBOX =================

function loadHiddenChats() {
  stopHiddenChats = stopListener(stopHiddenChats);

  if (!currentUser) return;

  const hiddenRef = collection(
    db,
    "users",
    currentUser.uid,
    "hiddenChats"
  );

  stopHiddenChats = onSnapshot(
    hiddenRef,
    snapshot => {
      hiddenChatIds = new Set(snapshot.docs.map(item => item.id));
      renderUsers();
    },
    error => console.error("Hidden chats listener:", error)
  );
}

function loadSavedContacts() {
  stopSavedContacts = stopListener(stopSavedContacts);

  if (!currentUser) return;

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
      console.error("Saved contacts:", error);

      $("userList").innerHTML =
        '<div class="notice">Could not load saved contacts. Check Firestore rules.</div>';
    }
  );
}


function loadInbox() {
  stopInbox = stopListener(stopInbox);

  if (!currentUser) return;

  const chatsQuery = query(
    collection(db, "chats"),
    where("participants", "array-contains", currentUser.uid)
  );

  stopInbox = onSnapshot(
    chatsQuery,
    async snapshot => {
      const myUid = currentUser?.uid;
      if (!myUid) return;

      const otherIds = [
        ...new Set(
          snapshot.docs
            .map(item =>
              (item.data().participants || [])
                .find(uid => uid !== myUid)
            )
            .filter(Boolean)
        )
      ];

      const profiles = await Promise.all(
        otherIds.map(async uid => {
          try {
            const profile = await getDoc(doc(db, "users", uid));

            if (!profile.exists()) return null;

            const data = profile.data();

            return {
              uid,
              userId: uid,
              connectoId: data.connectoId || "",
              displayName: data.displayName || "Connecto user"
            };

          } catch (error) {
            console.warn("Could not load chat profile:", uid, error);
            return null;
          }
        })
      );

      if (currentUser?.uid !== myUid) return;

      inboxUsers = profiles.filter(Boolean);
      renderUsers();
    },
    error => {
      console.error("Inbox listener:", error);
      renderUsers();
    }
  );
}
// ================= SAVE CONTACT =================

async function saveContact(person) {
  if (!currentUser || !person?.uid) return;

  if (person.uid === currentUser.uid) {
    alert("You cannot save yourself as a contact.");
    return;
  }

  try {
    const hiddenRef = doc(
      db, "users", currentUser.uid,
      "hiddenChats", person.uid
    );

    // Restore the contact if previously removed.
    const hiddenSnap = await getDoc(hiddenRef);

    if (hiddenSnap.exists()) {
      await deleteDoc(hiddenRef);
    }

    await setDoc(
      doc(db, "users", currentUser.uid, "contacts", person.uid),
      {
        uid: person.uid,
        connectoId: person.connectoId || "",
        displayName: person.displayName || "Connecto user",
        savedAt: serverTimestamp()
      }
    );

    alert("Contact saved successfully.");

  } catch (error) {
    console.error("Save contact:", error);
    alert("Could not save contact: " + friendlyError(error));
  }
}

// ================= REMOVE CONTACT =================

async function removeContact(person) {
  if (!currentUser || !person?.uid) return;

  if (person.uid === currentUser.uid) return;

  if (!confirm(
    `Remove ${person.displayName || "this contact"} from your list? Your chat history will be preserved.`
  )) {
    return;
  }

  try {
    const hiddenRef = doc(
      db, "users", currentUser.uid,
      "hiddenChats", person.uid
    );

    const contactRef = doc(
      db, "users", currentUser.uid,
      "contacts", person.uid
    );

    // Create the hidden record only if it does not already exist.
    const hiddenSnap = await getDoc(hiddenRef);

    if (!hiddenSnap.exists()) {
      await setDoc(hiddenRef, {
        uid: person.uid,
        hiddenAt: serverTimestamp()
      });
    }

    // Delete saved contact only if it exists.
    const contactSnap = await getDoc(contactRef);

    if (contactSnap.exists()) {
      await deleteDoc(contactRef);
    }

    // Update the local UI immediately.
    savedContacts = savedContacts.filter(
      item => item.uid !== person.uid
    );

    hiddenChatIds.add(person.uid);

    if (selectedUser?.uid === person.uid) {
      selectedUser = null;
      stopMessages = stopListener(stopMessages);
      resetChatView();
    } else {
      renderUsers();
    }

    alert("Contact removed successfully.");

  } catch (error) {
    console.error("Remove contact:", error);
    alert("Could not remove contact: " + friendlyError(error));
  }
}

// ================= DISPLAY CONTACT ENTRY =================

function renderUserEntry(person, container, mode = "normal") {
  const entry = document.createElement("div");
  entry.className = "user-entry";

  const button = document.createElement("button");
  button.type = "button";

  button.className =
    "user" +
    (selectedUser?.uid === person.uid ? " active" : "");

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent =
    (person.displayName || "?").charAt(0).toUpperCase();

  const details = document.createElement("div");
  details.className = "user-details";

  const name = document.createElement("div");
  name.className = "user-name";
  name.textContent = person.displayName || "Connecto user";

  const sub = document.createElement("div");
  sub.className = "user-sub";

  const saved = savedContacts.some(
    item => item.uid === person.uid
  );

  sub.textContent = person.connectoId
    ? `@${person.connectoId}`
    : (saved ? "Saved contact" : "Conversation");

  details.append(name, sub);
  button.append(avatar, details);

  button.addEventListener("click", () => openChat(person));
  entry.appendChild(button);

  if (mode === "search") {
    const save = document.createElement("button");

    save.type = "button";
    save.className = "save-contact-btn";
    save.textContent = saved ? "✓ Saved" : "＋ Save";
    save.disabled = saved;

    save.addEventListener("click", () => saveContact(person));
    entry.appendChild(save);

  } else {
  const remove = document.createElement("button");

  remove.type = "button";
  remove.className = "remove-contact-btn";
  remove.textContent = "Remove";
  remove.title = "Remove contact";

  remove.addEventListener("click", event => {
    event.stopPropagation();
    removeContact(person);
  });

  entry.appendChild(remove);
  
}

container.appendChild(entry);
}
// ================= DISPLAY USERS =================

function renderUsers() {
  if (!currentUser || !$("userList")) return;

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

    renderUserEntry(searchResult, list, "search");
    return;
  }

  const merged = new Map();

  [...inboxUsers, ...savedContacts].forEach(person => {
    const previous = merged.get(person.uid) || {};

    merged.set(person.uid, {
      ...previous,
      ...person
    });
  });

  const people = [...merged.values()]
  .filter(person => !hiddenChatIds.has(person.uid))
  .sort((a, b) =>
    (a.displayName || "").localeCompare(b.displayName || "")
  );
  if (!people.length) {
    list.innerHTML =
      '<div class="empty">No chats yet. Search for someone using their Connecto ID.</div>';
    return;
  }

  people.forEach(person => {
    renderUserEntry(person, list, "normal");
  });
}

// ================= SEARCH CONNECTO ID =================

 
async function searchUserById() {
  if (!currentUser) return;

  const enteredId = $("userSearch").value
    .trim()
    .toLowerCase()
    .replace(/^@/, "");

  searchResult = null;

  if (!enteredId) {
    renderUsers();
    return;
  }

  $("userList").innerHTML =
    '<div class="empty">Searching...</div>';

  try {
    const mappingRef = doc(db, "connectoIds", enteredId);
    const mapping = await getDoc(mappingRef);

    if (!mapping.exists()) {
      $("userList").innerHTML =
        '<div class="empty">Connecto ID not found.</div>';
      return;
    }

    const uid = mapping.data().uid;

    const profile = await getDoc(doc(db, "users", uid));

    if (!profile.exists()) {
      $("userList").innerHTML =
        '<div class="empty">User profile not found.</div>';
      return;
    }

    const data = profile.data();

    searchResult = {
      uid: uid,
      userId: uid,
      connectoId: data.connectoId || enteredId,
      displayName: data.displayName || "Connecto user"
    };

    renderUsers();

  } catch (error) {
    console.error("Search error:", error);

    $("userList").innerHTML =
      '<div class="empty">Search failed: ' +
      error.message +
      '</div>';
  }
}
on("userSearch", "input", searchUserById);
// ================= CHAT =================

function resetChatView() {
  selectedUser = null;
  stopMessages = stopListener(stopMessages);

  $("activeName").textContent = "Select a contact";
  $("activeAvatar").textContent = "?";
  $("activeStatus").textContent = "Choose someone to chat with";

  $("chatMessages").innerHTML =
    '<div class="empty"><div class="big">💬</div><p>Select a person to start chatting.</p></div>';

  showMobileContacts();
  renderUsers();
}

// ================= DISPLAY MESSAGE =================

function renderMessage(message) {
  const bubble = document.createElement("div");

  bubble.className =
    "bubble" +
    (message.senderId === currentUser.uid ? " mine" : "");

  if (typeof message.text === "string" && message.text.length) {
    const textElement = document.createElement("div");

    textElement.textContent = message.text;
    textElement.style.whiteSpace = "pre-wrap";

    bubble.appendChild(textElement);
  }

  if (message.createdAt?.toDate) {
    const time = document.createElement("div");

    time.className = "message-time";
    time.textContent =
      message.createdAt.toDate().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      });

    bubble.appendChild(time);
  }

  $("chatMessages").appendChild(bubble);
}

// ================= OPEN CHAT =================

async function openChat(person) {
  if (
    !currentUser ||
    !person?.uid ||
    person.uid === currentUser.uid
  ) {
    return;
  }

  selectedUser = person;
  // Restore a previously hidden conversation when opened again.
try {
  await deleteDoc(
    doc(
      db,
      "users",
      currentUser.uid,
      "hiddenChats",
      person.uid
    )
  );

  hiddenChatIds.delete(person.uid);
} catch (error) {
  console.warn("Could not restore hidden chat:", error);
}

  $("activeName").textContent =
    person.displayName || "Connecto user";

  $("activeAvatar").textContent =
    (person.displayName || "?").charAt(0).toUpperCase();

  $("activeStatus").textContent =
    person.connectoId
      ? `@${person.connectoId}`
      : "Connecto conversation";

  showMobileChat();
  renderUsers();

  stopMessages = stopListener(stopMessages);

  const id = chatId(currentUser.uid, person.uid);
  const chatRef = doc(db, "chats", id);

  $("chatMessages").innerHTML =
    '<div class="empty">Loading messages...</div>';

  try {
    await setDoc(
      chatRef,
      {
        participants: [currentUser.uid, person.uid].sort(),
        updatedAt: serverTimestamp()
      },
      { merge: true }
    );

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

        snapshot.forEach(item => renderMessage(item.data()));
        box.scrollTop = box.scrollHeight;
      },
      error => {
        console.error("Messages listener:", error);

        $("activeStatus").textContent =
          "Message access error. Check Firestore rules.";
      }
    );

  } catch (error) {
    console.error("Open chat:", error);

    $("activeStatus").textContent =
      "Could not open chat: " + friendlyError(error);
  }
}

// ================= SEND MESSAGE =================

async function sendMessage(payload) {
  if (!currentUser || !selectedUser) {
    alert("First select a person to chat with.");
    return false;
  }

  if (
    !payload ||
    typeof payload.text !== "string" ||
    !payload.text.trim()
  ) {
    return false;
  }

  const recipient = selectedUser;
  const id = chatId(currentUser.uid, recipient.uid);

  try {
    await addDoc(
      collection(db, "chats", id, "messages"),
      {
        text: payload.text,
        senderId: currentUser.uid,
        createdAt: serverTimestamp()
      }
    );

    await updateDoc(doc(db, "chats", id), {
      updatedAt: serverTimestamp()
    });

    return true;

  } catch (error) {
    console.error("Send message:", error);

    alert("Message could not be sent: " + friendlyError(error));
    return false;
  }
}

// ================= SEND TEXT =================

async function sendTextMessage() {
  const input = $("messageInput");
  const text = input.value.trim();

  if (!text) return;

  $("sendBtn").disabled = true;

  try {
    const sent = await sendMessage({ text });

    if (sent) {
      input.value = "";
      input.focus();
    }
  } finally {
    $("sendBtn").disabled = false;
  }
}

on("sendBtn", "click", sendTextMessage);

on("messageInput", "keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendTextMessage();
  }
});

// ================= EMOJI MESSAGES =================

document.querySelectorAll(".emoji").forEach(button => {
  button.addEventListener("click", () => {
    const emoji = button.textContent.trim();

    if (emoji) {
      sendMessage({ text: emoji });
    }
  });
});


// ================= CALL MEDIA =================

let currentCallType = null;

async function getCallMedia(type) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      "Camera and microphone require HTTPS or localhost."
    );
  }

  const constraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: type === "video"
      ? {
          facingMode: cameraFacingMode,
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 24, max: 30 }
        }
      : false
  };

  try {
    const stream =
      await navigator.mediaDevices.getUserMedia(constraints);

    localStream = stream;

    if (type === "video" && $("localVideo")) {
      $("localVideo").srcObject = stream;
      $("localVideo").muted = true;
      $("localVideo").playsInline = true;
      $("localVideo").play().catch(() => {});
    }

    return stream;

  } catch (error) {
    console.error("Get call media:", error);

    if (error.name === "NotAllowedError") {
      alert("Please allow microphone and camera permissions.");
    } else if (error.name === "NotFoundError") {
      alert("Microphone or camera was not found.");
    } else if (error.name === "NotReadableError") {
      alert("Camera or microphone is being used by another app.");
    } else {
      alert("Could not access call devices: " + error.message);
    }

    throw error;
  }
}

// ================= CALL SCREEN =================

function showCallScreen(title, status) {
  $("callScreen").classList.remove("hidden");
  $("callTitle").textContent = title;
  $("callStatus").textContent = status;

  $("acceptCallBtn").style.display = "none";
  $("declineCallBtn").style.display = "none";
  $("endCallBtn").style.display = "inline-block";

  $("muteCallBtn").textContent = "🎙️";
  $("cameraToggleBtn").textContent = "📷";
  $("flipCameraBtn").textContent = "🔄";

  $("remoteVideo").style.display = "none";
  $("localVideo").style.display = "none";
}

// ================= CALL DURATION =================

function startCallDurationTimer() {
  if (callDurationInterval) return;

  callStartedAt = Date.now();

  const updateTimer = () => {
    const seconds = Math.floor(
      (Date.now() - callStartedAt) / 1000
    );

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    const formatted =
      `${String(minutes).padStart(2, "0")}:` +
      `${String(remainingSeconds).padStart(2, "0")}`;

    setCallStatus(`Connected · ${formatted}`);
  };

  updateTimer();

  callDurationInterval = setInterval(updateTimer, 1000);
}

function stopCallDurationTimer() {
  if (callDurationInterval) {
    clearInterval(callDurationInterval);
    callDurationInterval = null;
  }

  callStartedAt = null;
}

// ================= CALL CLEANUP =================

function cleanupCall() {
  // Invalidate any unfinished call setup or media request.
  callAttempt++;

  clearTimeout(callTimeout);
  clearTimeout(connectionTimeout);
  clearTimeout(disconnectTimeout);

  callTimeout = null;
  connectionTimeout = null;
  disconnectTimeout = null;

  stopCallDurationTimer();

  callUnsub = stopListener(callUnsub);
  candidateUnsub = stopListener(candidateUnsub);

  if (peerConnection) {
    try {
      peerConnection.ontrack = null;
      peerConnection.onicecandidate = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.oniceconnectionstatechange = null;
      peerConnection.close();
    } catch (error) {
      console.warn("Peer cleanup:", error);
    }
  }

  peerConnection = null;

  if (localStream) {
    localStream.getTracks().forEach(track => {
      try {
        track.stop();
      } catch {}
    });
  }

  localStream = null;

  if ($("localVideo")) {
    $("localVideo").pause();
    $("localVideo").srcObject = null;
  }

  if ($("remoteVideo")) {
    $("remoteVideo").pause();
    $("remoteVideo").srcObject = null;
  }

  currentCallId = null;
  currentCallType = null;
  incomingCall = null;
  activeCallPeerId = null;

  isCaller = false;
  callAccepted = false;

  microphoneMuted = false;
  cameraEnabled = true;
  cameraFacingMode = "user";

  remoteDescriptionSet = false;
  answerApplying = false;
  pendingRemoteCandidates = [];

  if ($("muteCallBtn")) {
    $("muteCallBtn").textContent = "🎙️";
  }

  if ($("cameraToggleBtn")) {
    $("cameraToggleBtn").textContent = "📷";
  }

  if ($("acceptCallBtn")) {
    $("acceptCallBtn").disabled = false;
    $("acceptCallBtn").style.display = "none";
  }

  if ($("declineCallBtn")) {
    $("declineCallBtn").style.display = "none";
  }

  if ($("endCallBtn")) {
    $("endCallBtn").style.display = "inline-block";
  }

  if ($("callScreen")) {
    $("callScreen").classList.add("hidden");
  }
}

// ================= REMOTE ICE CANDIDATES =================

async function addPendingCandidates() {
  if (
    !peerConnection ||
    !peerConnection.remoteDescription
  ) {
    return;
  }

  const pc = peerConnection;
  const candidates = [...pendingRemoteCandidates];

  pendingRemoteCandidates = [];

  for (const candidate of candidates) {
    if (peerConnection !== pc) return;

    try {
      await pc.addIceCandidate(
        new RTCIceCandidate(candidate)
      );
    } catch (error) {
      console.error("Add queued ICE candidate:", error);
    }
  }
}

function listenForRemoteCandidates(callId) {
  candidateUnsub = stopListener(candidateUnsub);

  if (!currentUser || !callId) return;

  const candidatesRef = collection(
    db,
    "calls",
    callId,
    "candidates"
  );

  const candidatesQuery = query(
    candidatesRef,
    orderBy("createdAt", "asc")
  );

  candidateUnsub = onSnapshot(
    candidatesQuery,
    async snapshot => {
      for (const change of snapshot.docChanges()) {
        if (change.type !== "added") continue;

        if (currentCallId !== callId) return;

        const data = change.doc.data();

        if (data.senderId === currentUser.uid) continue;
        if (!data.candidate || !peerConnection) continue;

        if (!peerConnection.remoteDescription) {
          pendingRemoteCandidates.push(data.candidate);
          continue;
        }

        const pc = peerConnection;

        try {
          await pc.addIceCandidate(
            new RTCIceCandidate(data.candidate)
          );
        } catch (error) {
          console.error("Add remote ICE candidate:", error);
        }
      }
    },
    error => {
      console.error("ICE candidate listener:", error);
    }
  );
}

// ================= PEER CONNECTION =================

function createPeerConnection(callId) {
  if (!currentUser || !localStream || !callId) {
    throw new Error(
      "User, call ID or call media is not ready."
    );
  }

  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  pendingRemoteCandidates = [];
  remoteDescriptionSet = false;

  const pc = new RTCPeerConnection(callServers);
  peerConnection = pc;

  const remoteStream = new MediaStream();

  if ($("remoteVideo")) {
    $("remoteVideo").srcObject = remoteStream;
  }

  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });

  pc.ontrack = event => {
    if (peerConnection !== pc) return;

    const incomingStream = event.streams?.[0];

    if (incomingStream) {
      incomingStream.getTracks().forEach(track => {
        if (
          !remoteStream.getTracks().some(
            existing => existing.id === track.id
          )
        ) {
          remoteStream.addTrack(track);
        }
      });
    } else if (
      !remoteStream.getTracks().some(
        existing => existing.id === event.track.id
      )
    ) {
      remoteStream.addTrack(event.track);
    }

    if ($("remoteVideo")) {
      $("remoteVideo").srcObject = remoteStream;

      $("remoteVideo").style.display =
        currentCallType === "video" ? "block" : "none";

      $("remoteVideo").play().catch(error => {
        console.warn("Remote media autoplay:", error);
      });
    }
  };

  pc.onicecandidate = async event => {
    if (!event.candidate) return;
    if (peerConnection !== pc) return;
    if (currentCallId !== callId || !currentUser) return;

    try {
      await addDoc(
        collection(db, "calls", callId, "candidates"),
        {
          senderId: currentUser.uid,
          candidate: event.candidate.toJSON(),
          createdAt: serverTimestamp()
        }
      );
    } catch (error) {
      console.error("Upload ICE candidate:", error);
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (peerConnection !== pc) return;

    console.log("ICE CONNECTION STATE:", pc.iceConnectionState);

    if (
      pc.iceConnectionState === "connected" ||
      pc.iceConnectionState === "completed"
    ) {
      clearTimeout(disconnectTimeout);
      disconnectTimeout = null;
    }

    if (pc.iceConnectionState === "disconnected") {
      clearTimeout(disconnectTimeout);

      disconnectTimeout = setTimeout(() => {
        if (
          peerConnection === pc &&
          pc.iceConnectionState === "disconnected"
        ) {
          setCallStatus("Connection lost. Ending call...");
          endCall();
        }
      }, 12000);
    }

    if (pc.iceConnectionState === "failed") {
      setCallStatus("Connection failed.");
      endCall();
    }
  };

  pc.onconnectionstatechange = () => {
    if (peerConnection !== pc) return;

    console.log("PEER CONNECTION STATE:", pc.connectionState);

    if (pc.connectionState === "connected") {
      clearTimeout(connectionTimeout);
      clearTimeout(disconnectTimeout);

      connectionTimeout = null;
      disconnectTimeout = null;

      callAccepted = true;

      setCallStatus("Connected");
      startCallDurationTimer();
    }

    if (pc.connectionState === "failed") {
      setCallStatus("Connection failed.");
      endCall();
    }
  };

  pc.onsignalingstatechange = () => {
    if (peerConnection === pc) {
      console.log("SIGNALING STATE:", pc.signalingState);
    }
  };

  pc.onicegatheringstatechange = () => {
    if (peerConnection === pc) {
      console.log("ICE GATHERING STATE:", pc.iceGatheringState);
    }
  };

  return pc;
}

// ================= CALL DOCUMENT LISTENER =================

function watchCallDocument(callId) {
  callUnsub = stopListener(callUnsub);

  if (!currentUser || !callId) return;

  const callRef = doc(db, "calls", callId);

  callUnsub = onSnapshot(
    callRef,
    async snapshot => {
      if (currentCallId !== callId) return;

      if (!snapshot.exists()) {
        cleanupCall();
        return;
      }

      const data = snapshot.data();

      if (
        ["ended", "rejected", "missed"].includes(data.status)
      ) {
        setCallStatus(
          data.status === "missed"
            ? "Missed call"
            : data.status === "rejected"
              ? "Call declined"
              : "Call ended"
        );

        cleanupCall();
        return;
      }

      // The caller must receive and apply the receiver's answer.
      if (
        isCaller &&
        data.status === "accepted" &&
        data.answer &&
        peerConnection &&
        !remoteDescriptionSet &&
        !answerApplying
      ) {
        const pc = peerConnection;
        answerApplying = true;

        try {
          await pc.setRemoteDescription(
            new RTCSessionDescription(data.answer)
          );

          if (
            currentCallId !== callId ||
            peerConnection !== pc
          ) {
            return;
          }

          remoteDescriptionSet = true;

          await addPendingCandidates();

          setCallStatus("Connecting...");

        } catch (error) {
          console.error("Apply remote answer:", error);

          setCallStatus("Could not connect the call.");
          endCall();

        } finally {
          answerApplying = false;
        }
      }
    },
    error => {
      console.error("Call document listener:", error);
    }
  );
}

// ================= OUTGOING CALL =================

async function startCall(type) {
  if (!currentUser) return;

  if (!selectedUser) {
    alert("First select a person to chat with.");
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
  const attempt = ++callAttempt;

  try {
    isCaller = true;
    callAccepted = false;

    currentCallType = type;
    microphoneMuted = false;
    cameraEnabled = true;
    cameraFacingMode = "user";
    activeCallPeerId = recipient.uid;

    showCallScreen(
      type === "video" ? "Video Call" : "Voice Call",
      "Starting call..."
    );

    $("cameraToggleBtn").style.display =
      type === "video" ? "inline-block" : "none";

    $("flipCameraBtn").style.display =
      type === "video" ? "inline-block" : "none";

    $("localVideo").style.display =
      type === "video" ? "block" : "none";

    $("remoteVideo").style.display = "none";

    setCallStatus("Requesting microphone and camera...");

    await getCallMedia(type);

    if (attempt !== callAttempt || !isCaller) return;

    // Create the Firestore call document BEFORE creating the peer connection.
    const callRef = doc(collection(db, "calls"));
    currentCallId = callRef.id;

    await setDoc(callRef, {
      callerId: currentUser.uid,
      callerName: currentUser.displayName || "Connecto user",
      receiverId: recipient.uid,
      participants: [currentUser.uid, recipient.uid].sort(),
      type,
      status: "preparing",
      createdAt: serverTimestamp()
    });

    if (attempt !== callAttempt) return;

    // The peer connection now has the correct call ID.
    createPeerConnection(currentCallId);

    listenForRemoteCandidates(currentCallId);
    watchCallDocument(currentCallId);

    const pc = peerConnection;

    const offer = await pc.createOffer();

    await pc.setLocalDescription(offer);

    if (
      attempt !== callAttempt ||
      currentCallId !== callRef.id ||
      peerConnection !== pc
    ) {
      return;
    }

    const allowed = await runTransaction(
      db,
      async transaction => {
        const snap = await transaction.get(callRef);

        if (
          !snap.exists() ||
          snap.data().status !== "preparing"
        ) {
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

    if (!allowed || attempt !== callAttempt) {
      cleanupCall();
      return;
    }

    setCallStatus(
      `Calling ${recipient.displayName || "user"}...`
    );

    const thisId = currentCallId;

    callTimeout = setTimeout(async () => {
      if (
        currentCallId !== thisId ||
        callAccepted
      ) {
        return;
      }

      try {
        await runTransaction(db, async transaction => {
          const ref = doc(db, "calls", thisId);
          const snap = await transaction.get(ref);

          if (
            snap.exists() &&
            snap.data().status === "ringing"
          ) {
            transaction.update(ref, {
              status: "missed",
              missedAt: serverTimestamp()
            });
          }
        });
      } catch (error) {
        console.error("Missed call update:", error);
      }

      if (currentCallId === thisId && !callAccepted) {
        cleanupCall();
      }
    }, 30000);

  } catch (error) {
    console.error("Start call:", error);

    alert("Could not start call: " + friendlyError(error));

    if (attempt === callAttempt) {
      cleanupCall();
    }
  }
}

// ================= INCOMING CALLS =================

function listenForIncomingCalls() {
  incomingCallUnsub = stopListener(incomingCallUnsub);

  if (!currentUser) return;

  const callsQuery = query(
    collection(db, "calls"),
    where("participants", "array-contains", currentUser.uid)
  );

  incomingCallUnsub = onSnapshot(
    callsQuery,
    snapshot => {
      snapshot.docChanges().forEach(change => {
        if (
          change.type !== "added" &&
          change.type !== "modified"
        ) {
          return;
        }

        const data = change.doc.data();
        const id = change.doc.id;

        if (data.receiverId !== currentUser.uid) return;

        if (data.status === "missed") {
          if (isRecentMissedCall(data)) {
            showMissedCallNotification(data.callerName, id);
          }

          if (currentCallId === id) {
            cleanupCall();
          }

          return;
        }

        if (
          currentCallId === id &&
          ["ended", "rejected"].includes(data.status)
        ) {
          cleanupCall();
          return;
        }

        if (
          data.status !== "ringing" ||
          currentCallId ||
          peerConnection ||
          isCaller
        ) {
          return;
        }

        if (!data.offer) return;

        currentCallId = id;
        incomingCall = { id, ...data };
        activeCallPeerId = data.callerId;

        currentCallType = data.type;
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

        $("declineCallBtn").style.display = "inline-block";
        $("endCallBtn").style.display = "none";

        $("cameraToggleBtn").style.display =
          data.type === "video" ? "inline-block" : "none";

        $("flipCameraBtn").style.display =
          data.type === "video" ? "inline-block" : "none";

        $("localVideo").style.display = "none";
        $("remoteVideo").style.display = "none";
      });
    },
    error => {
      console.error("Incoming call listener:", error);
    }
  );
}

// ================= ACCEPT CALL =================

async function acceptCall() {
  if (!incomingCall || !currentCallId) return;

  const id = currentCallId;
  const call = incomingCall;
  const attempt = ++callAttempt;

  $("acceptCallBtn").disabled = true;

  try {
    setCallStatus("Preparing your camera and microphone...");

    await getCallMedia(call.type);

    if (
      currentCallId !== id ||
      attempt !== callAttempt
    ) {
      return;
    }

    $("localVideo").srcObject = localStream;
    $("localVideo").style.display =
      call.type === "video" ? "block" : "none";

    createPeerConnection(id);

    const pc = peerConnection;

    if (!call.offer) {
      throw new Error("The caller's offer is missing.");
    }

    await pc.setRemoteDescription(
      new RTCSessionDescription(call.offer)
    );

    if (
      currentCallId !== id ||
      peerConnection !== pc
    ) {
      return;
    }

    remoteDescriptionSet = true;

    listenForRemoteCandidates(id);
    await addPendingCandidates();

    const answer = await pc.createAnswer();

    await pc.setLocalDescription(answer);

    const accepted = await runTransaction(
      db,
      async transaction => {
        const callRef = doc(db, "calls", id);
        const snap = await transaction.get(callRef);

        if (
          !snap.exists() ||
          snap.data().status !== "ringing" ||
          snap.data().receiverId !== currentUser.uid
        ) {
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
      currentCallId !== id ||
      attempt !== callAttempt
    ) {
      cleanupCall();
      return;
    }

    callAccepted = true;

    clearTimeout(callTimeout);
    callTimeout = null;

    watchCallDocument(id);

    $("acceptCallBtn").style.display = "none";
    $("declineCallBtn").style.display = "none";
    $("endCallBtn").style.display = "inline-block";

    setCallStatus("Connecting...");

  } catch (error) {
    console.error("Accept call:", error);

    alert("Could not accept call: " + friendlyError(error));

    try {
      await updateDoc(doc(db, "calls", id), {
        status: "rejected"
      });
    } catch (updateError) {
      console.error("Reject failed:", updateError);
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
  const id = currentCallId;

  if (!id) {
    cleanupCall();
    return;
  }

  const status =
    (isCaller || callAccepted) ? "ended" : "rejected";

  // Stop local media and listeners immediately.
  cleanupCall();

  try {
    await updateDoc(doc(db, "calls", id), {
      status
    });
  } catch (error) {
    console.error("End call:", error);
  }
}

// ================= MUTE MICROPHONE =================

on("muteCallBtn", "click", () => {
  if (!localStream) return;

  microphoneMuted = !microphoneMuted;

  localStream.getAudioTracks().forEach(track => {
    track.enabled = !microphoneMuted;
  });

  $("muteCallBtn").textContent =
    microphoneMuted ? "🔇" : "🎙️";
});

// ================= CAMERA ON / OFF =================

function toggleCamera() {
  if (!localStream || currentCallType !== "video") return;

  const videoTracks = localStream.getVideoTracks();

  if (!videoTracks.length) return;

  cameraEnabled = !cameraEnabled;

  videoTracks.forEach(track => {
    track.enabled = cameraEnabled;
  });

  $("cameraToggleBtn").textContent =
    cameraEnabled ? "📷" : "🚫";
}

// ================= FLIP CAMERA =================

async function flipCamera() {
  if (
    !localStream ||
    currentCallType !== "video" ||
    !peerConnection
  ) {
    return;
  }

  const oldTrack = localStream.getVideoTracks()[0];

  if (!oldTrack) return;

  const newFacingMode =
    cameraFacingMode === "user" ? "environment" : "user";

  try {
    const newStream =
      await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: newFacingMode },
          width: { ideal: 640 },
          height: { ideal: 480 }
        },
        audio: false
      });

    const newTrack = newStream.getVideoTracks()[0];

    if (!newTrack) {
      throw new Error("Could not access the selected camera.");
    }

    const sender = peerConnection
      .getSenders()
      .find(item => item.track?.kind === "video");

    if (!sender) {
      newTrack.stop();
      throw new Error("Video sender is not available.");
    }

    await sender.replaceTrack(newTrack);

    localStream.removeTrack(oldTrack);
    localStream.addTrack(newTrack);

    oldTrack.stop();

    cameraFacingMode = newFacingMode;

    newTrack.enabled = cameraEnabled;

    $("localVideo").srcObject = localStream;

    await $("localVideo").play().catch(() => {});

  } catch (error) {
    console.error("Flip camera:", error);

    alert(
      "Could not switch camera: " + error.message
    );
  }
}

// ================= CALL BUTTONS =================

on("voiceCallBtn", "click", () => startCall("audio"));
on("videoCallBtn", "click", () => startCall("video"));
on("acceptCallBtn", "click", acceptCall);
on("endCallBtn", "click", endCall);
on("declineCallBtn", "click", endCall);
on("cameraToggleBtn", "click", toggleCamera);
on("flipCameraBtn", "click", flipCamera);

// ================= APP START =================

async function startApp(user) {
  currentUser = user;
  currentAuthUid = user.uid;

  $("authPage").classList.add("hidden");
  $("chatApp").classList.remove("hidden");
  $("chatApp").classList.remove("mobile-chat-open");

  $("myName").textContent =
    user.displayName ||
    user.email?.split("@")[0] ||
    "Connecto user";

  $("myConnectoId").textContent = "Connecto ID: Loading...";

  try {
    const connectoId = await ensureConnectoId(user);

    if (auth.currentUser?.uid !== user.uid) return;

    myConnectoId = connectoId;

    $("myConnectoId").textContent =
      "Connecto ID: @" + myConnectoId;

    loadSavedContacts();
    loadInbox();
    listenForIncomingCalls();
    loadHiddenChats();
  } catch (error) {
    console.error("Profile setup:", error);

    $("userList").innerHTML =
      '<div class="notice">Could not set up your Connecto ID. Check Firestore rules and try again.</div>';
  }
}

// ================= LOGOUT =================

on("logoutBtn", "click", async () => {
  $("logoutBtn").disabled = true;

  try {
    if (currentCallId) {
      await endCall();
    } else {
      cleanupCall();
    }

    await signOut(auth);

  } catch (error) {
    alert(friendlyError(error));

  } finally {
    $("logoutBtn").disabled = false;
  }
});

// ================= AUTH STATE =================

onAuthStateChanged(auth, async user => {
  if (user) {
    if (
      currentAuthUid &&
      currentAuthUid !== user.uid
    ) {
      stopSavedContacts = stopListener(stopSavedContacts);
      stopInbox = stopListener(stopInbox);
      stopMessages = stopListener(stopMessages);
      stopHiddenChats = stopListener(stopHiddenChats);
      hiddenChatIds = new Set();
      incomingCallUnsub = stopListener(incomingCallUnsub);

      cleanupCall();

      savedContacts = [];
      inboxUsers = [];
      selectedUser = null;
      searchResult = null;
    }

    await startApp(user);

  } else {
    if (currentCallId) {
      await endCall();
    } else {
      incomingCallUnsub = stopListener(incomingCallUnsub);
      stopSavedContacts = stopListener(stopSavedContacts);
      stopInbox = stopListener(stopInbox);
      stopMessages = stopListener(stopMessages);
      cleanupCall();
    }

    incomingCallUnsub = stopListener(incomingCallUnsub);
    stopSavedContacts = stopListener(stopSavedContacts);
    stopInbox = stopListener(stopInbox);
    stopMessages = stopListener(stopMessages);
    stopHiddenChats = stopListener(stopHiddenChats);
    hiddenChatIds = new Set();
    currentUser = null;
    currentAuthUid = null;
    selectedUser = null;
    myConnectoId = "";

    savedContacts = [];
    inboxUsers = [];
    searchResult = null;
    searchRequestNumber++;

    $("authPage").classList.remove("hidden");
    $("chatApp").classList.add("hidden");
    $("chatApp").classList.remove("mobile-chat-open");

    $("myConnectoId").textContent =
      "Connecto ID: Not logged in";

    $("userList").innerHTML = "";

    $("chatMessages").innerHTML =
      '<div class="empty">Select a person to start chatting.</div>';

    $("activeName").textContent = "Select a contact";
    $("activeAvatar").textContent = "?";
    $("activeStatus").textContent = "";

    $("userSearch").value = "";
    $("messageInput").value = "";

    showLogin();
  }
});

// ================= DISABLE PHOTO UPLOAD UI =================

// Connecto is configured for text and emoji messages only.
// No Firebase Storage or photo-message upload is used.

const photoLabel = document.querySelector(
  'label[for="photoInput"]'
);

if (photoLabel) {
  photoLabel.classList.add("hidden");
}

if ($("photoInput")) {
  $("photoInput").classList.add("hidden");
}


