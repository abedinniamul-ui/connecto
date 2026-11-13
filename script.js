
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
  query,
  where,
  orderBy,
  onSnapshot,
  updateDoc,
  serverTimestamp
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

const $ = id => document.getElementById(id);

let auth;
let db;
let storage;

let currentUser = null;
let selectedUser = null;
let stopUsers = null;
let stopMessages = null;
let people = [];

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

function showMissedCallNotification(callerName, callId) {
  if (!currentUser || !callId) return;

  const storageKey = `connecto_missed_${currentUser.uid}`;

  let notified = [];

  try {
    notified = JSON.parse(localStorage.getItem(storageKey) || "[]");
    if (!Array.isArray(notified)) notified = [];
  } catch {
    notified = [];
  }

  if (notified.includes(callId)) return;

  const title = "Connecto - Missed Call";
  const body = `${callerName || "Connecto user"} tried to call you.`;

  let notificationShown = false;

  if (
    "Notification" in window &&
    Notification.permission === "granted"
  ) {
    try {
      const notification = new Notification(title, {
        body,
        tag: `connecto-${callId}`,
        requireInteraction: true
      });

      notification.onclick = () => {
        window.focus();
        notification.close();
      };

      notificationShown = true;
    } catch (error) {
      console.error("Browser notification error:", error);
    }
  }

  if (!notificationShown) {
    alert(`${title}\n${body}`);
  }

  // Save only after showing a notification or fallback alert.
  notified.push(callId);

  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify(notified.slice(-100))
    );
  } catch (error) {
    console.warn("Could not save notification history:", error);
  }
}

function isRecentMissedCall(data) {
  if (!data.missedAt) return false;

  const missedTime = data.missedAt.toDate
    ? data.missedAt.toDate().getTime()
    : new Date(data.missedAt).getTime();

  return (
    Number.isFinite(missedTime) &&
    Date.now() - missedTime >= 0 &&
    Date.now() - missedTime < 10 * 60 * 1000
  );
}

// ================= GENERAL HELPERS =================

function showError(message) {
  $("authStatus").textContent = message;
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
    "permission-denied": "Access denied. Check Firestore rules."
  };

  return messages[error.code] || error.message;
}

// ================= CALLING VARIABLES =================

let peerConnection = null;
let localStream = null;

let currentCallId = null;
let incomingCall = null;

let incomingCallUnsub = null;
let callUnsub = null;
let candidateUnsub = null;

let isCaller = false;
let callAccepted = false;
let microphoneMuted = false;

let callTimeout = null;
let cameraEnabled = true;
let cameraFacingMode = "user";

let pendingRemoteCandidates = [];

const callServers = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
  ]
};

// ================= CALL SCREEN =================

function showCallScreen(title, status) {
  $("callScreen").classList.remove("hidden");
  $("callTitle").textContent = title;
  $("callStatus").textContent = status;
}

function hideCallScreen() {
  $("callScreen").classList.add("hidden");
}

// ================= CAMERA AND MICROPHONE =================

async function getCallMedia(type) {
  return await navigator.mediaDevices.getUserMedia({
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

  const videoTrack = localStream.getVideoTracks()[0];

  if (!videoTrack) {
    alert("No video camera is available in this call.");
    return;
  }

  cameraEnabled = !cameraEnabled;
  videoTrack.enabled = cameraEnabled;

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
      item => item.track && item.track.kind === "video"
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

    alert(
      "Could not switch camera. Your device may have only one camera."
    );
  }
}

// ================= PEER CONNECTION =================

function createPeerConnection() {
  peerConnection = new RTCPeerConnection(callServers);

  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.ontrack = event => {
    const remoteVideo = $("remoteVideo");

    remoteVideo.srcObject = event.streams[0];
    remoteVideo.style.display = "block";

    remoteVideo.play().catch(error => {
      console.warn("Remote video autoplay:", error);
    });
  };

  peerConnection.onicecandidate = async event => {
    if (!event.candidate || !currentCallId) return;

    try {
      await addDoc(
        collection(db, "calls", currentCallId, "candidates"),
        {
          senderId: currentUser.uid,
          candidate: event.candidate.toJSON()
        }
      );
    } catch (error) {
      console.error("ICE candidate error:", error);
    }
  };

  peerConnection.onconnectionstatechange = () => {
    if (!peerConnection) return;

    const state = peerConnection.connectionState;

    if (state === "connected") {
      $("callStatus").textContent = "Connected";
    }

    if (state === "failed") {
      $("callStatus").textContent =
        "Connection failed. Check your internet connection.";
    }

    if (state === "disconnected") {
      $("callStatus").textContent = "Connection interrupted...";
    }
  };
}

// ================= REMOTE ICE CANDIDATES =================

async function addPendingCandidates() {
  if (!peerConnection || !peerConnection.remoteDescription) return;

  while (pendingRemoteCandidates.length > 0) {
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
  if (candidateUnsub) {
    candidateUnsub();
    candidateUnsub = null;
  }

  pendingRemoteCandidates = [];

  const candidatesRef = collection(
    db,
    "calls",
    currentCallId,
    "candidates"
  );

  candidateUnsub = onSnapshot(
    candidatesRef,
    snapshot => {
      snapshot.docChanges().forEach(async change => {
        if (change.type !== "added") return;

        const data = change.doc.data();

        if (data.senderId === currentUser.uid) return;
        if (!data.candidate) return;

        if (
          !peerConnection ||
          !peerConnection.remoteDescription
        ) {
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
    error => {
      console.error("Candidate listener error:", error);
    }
  );
}

// ================= WATCH CALL DOCUMENT =================

function watchCallDocument() {
  if (callUnsub) {
    callUnsub();
    callUnsub = null;
  }

  const watchedCallId = currentCallId;

  callUnsub = onSnapshot(
    doc(db, "calls", watchedCallId),
    async snapshot => {
      if (!snapshot.exists()) return;
      if (currentCallId !== watchedCallId) return;

      const data = snapshot.data();

      if (data.status === "missed") {
        if (callTimeout) {
          clearTimeout(callTimeout);
          callTimeout = null;
        }

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
        if (callTimeout) {
          clearTimeout(callTimeout);
          callTimeout = null;
        }

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

        if (callTimeout) {
          clearTimeout(callTimeout);
          callTimeout = null;
        }

        $("callStatus").textContent = "Connected";
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

          $("callStatus").textContent = "Connected";

        } catch (error) {
          console.error("Answer error:", error);
        }
      }
    },
    error => {
      console.error("Call document listener:", error);
    }
  );
}

// ================= START OUTGOING CALL =================

async function startCall(type) {
  if (!currentUser) return;

  if (!selectedUser) {
    alert("First select a person to call.");
    return;
  }

  if (selectedUser.uid === currentUser.uid) {
    alert("You cannot call yourself.");
    return;
  }

  if (currentCallId || peerConnection) {
    alert("You already have an active call.");
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    alert("Camera and microphone require HTTPS or localhost.");
    return;
  }

  try {
    isCaller = true;
    callAccepted = false;
    microphoneMuted = false;

    cameraEnabled = true;
    cameraFacingMode = "user";

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

    $("localVideo").srcObject = localStream;

    createPeerConnection();

    const callRef = doc(collection(db, "calls"));

    currentCallId = callRef.id;

    await setDoc(callRef, {
      callerId: currentUser.uid,
      callerName: currentUser.displayName || currentUser.email,
      receiverId: selectedUser.uid,
      participants: [currentUser.uid, selectedUser.uid],
      type,
      status: "preparing",
      createdAt: serverTimestamp()
    });

    const offer = await peerConnection.createOffer();

    await peerConnection.setLocalDescription(offer);

    await updateDoc(callRef, {
      offer: {
        type: offer.type,
        sdp: offer.sdp
      },
      status: "ringing"
    });

    listenForRemoteCandidates();
    watchCallDocument();

    $("callStatus").textContent =
      "Calling " + (selectedUser.displayName || "user") + "...";

    const thisCallId = currentCallId;

    callTimeout = setTimeout(async () => {
      if (
        currentCallId !== thisCallId ||
        callAccepted
      ) {
        return;
      }

      try {
        await updateDoc(doc(db, "calls", thisCallId), {
          status: "missed",
          missedAt: serverTimestamp()
        });
      } catch (error) {
        console.error("Missed call update:", error);
      }

      if (currentCallId === thisCallId) {
        cleanupCall();
      }

    }, 30000);

  } catch (error) {
    console.error("Call error:", error);

    alert("Could not start call: " + error.message);

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

  // IMPORTANT FIX:
  // Query participants instead of receiverId.
  // This matches the existing Firestore participant read rule.

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
        const changedCallId = change.doc.id;

        // Only process calls intended for this user.
        if (data.receiverId !== currentUser.uid) return;

        // Handle missed calls.
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

          return;
        }

        // Handle calls ended or rejected by the caller.
        if (
          currentCallId === changedCallId &&
          !isCaller &&
          (
            data.status === "ended" ||
            data.status === "rejected"
          )
        ) {
          cleanupCall();
          return;
        }

        // Only show calls that are ringing.
        if (data.status !== "ringing") return;

        // Prevent duplicate incoming-call screens.
        if (currentCallId === changedCallId) return;

        // Do not interrupt another active call.
        if (currentCallId || peerConnection) return;

        currentCallId = changedCallId;
        incomingCall = {
          id: changedCallId,
          ...data
        };

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
      });
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

  try {
    $("acceptCallBtn").disabled = true;

    localStream = await getCallMedia(incomingCall.type);

    $("localVideo").srcObject = localStream;

    $("localVideo").style.display =
      incomingCall.type === "video" ? "block" : "none";

    createPeerConnection();

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(incomingCall.offer)
    );

    listenForRemoteCandidates();

    await addPendingCandidates();

    const answer = await peerConnection.createAnswer();

    await peerConnection.setLocalDescription(answer);

    await updateDoc(doc(db, "calls", acceptedCallId), {
      answer: {
        type: answer.type,
        sdp: answer.sdp
      },
      status: "accepted"
    });

    callAccepted = true;

    if (callTimeout) {
      clearTimeout(callTimeout);
      callTimeout = null;
    }

    watchCallDocument();

    $("acceptCallBtn").style.display = "none";
    $("callStatus").textContent = "Connected";

  } catch (error) {
    console.error("Accept call error:", error);

    alert("Could not accept call: " + error.message);

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

// ================= END OR DECLINE CALL =================

async function endCall() {
  const endingCallId = currentCallId;

  if (!endingCallId) {
    cleanupCall();
    return;
  }

  const status =
    (isCaller || callAccepted) ? "ended" : "rejected";

  try {
    await updateDoc(doc(db, "calls", endingCallId), {
      status
    });
  } catch (error) {
    console.error("End call error:", error);
  }

  cleanupCall();
}

// ================= CLEANUP CALL =================

function cleanupCall() {
  if (callTimeout) {
    clearTimeout(callTimeout);
    callTimeout = null;
  }

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

$("muteCallBtn").addEventListener("click", () => {
  if (!localStream) return;

  microphoneMuted = !microphoneMuted;

  localStream.getAudioTracks().forEach(track => {
    track.enabled = !microphoneMuted;
  });

  $("muteCallBtn").textContent =
    microphoneMuted ? "🔇" : "🎙️";
});

$("cameraToggleBtn").addEventListener("click", toggleCamera);

$("flipCameraBtn").addEventListener("click", flipCamera);

// ================= NOTIFICATION BUTTON =================

$("enableNotificationsBtn")?.addEventListener(
  "click",
  enableNotifications
);

// ================= LOGIN AND SIGNUP SWITCH =================

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

    showError(
      "Password reset email sent. Check your inbox and spam folder."
    );

    $("authStatus").style.color = "#087b69";

  } catch (error) {
    $("authStatus").style.color = "#c0392b";
    showError(friendlyError(error));

  } finally {
    $("forgotPassword").disabled = false;
  }
});

// ================= LOGOUT =================

$("logoutBtn").addEventListener("click", async () => {
  try {
    await signOut(auth);

  } catch (error) {
    alert(friendlyError(error));
  }
});

// ================= DISPLAY USERS =================

function renderUsers() {
  if (!currentUser) return;

  const search = $("userSearch").value.toLowerCase();
  const list = $("userList");

  list.innerHTML = "";

  const filtered = people.filter(person =>
    person.uid !== currentUser.uid &&
    (person.displayName || "").toLowerCase().includes(search)
  );

  if (!filtered.length) {
    list.innerHTML =
      '<div class="empty">No other users found yet.</div>';
    return;
  }

  filtered.forEach(person => {
    const button = document.createElement("button");

    button.className =
      "user" + (selectedUser?.uid === person.uid ? " active" : "");

    const avatar = document.createElement("div");

    avatar.className = "avatar";

    avatar.textContent =
      (person.displayName || "?").charAt(0).toUpperCase();

    const details = document.createElement("div");

    details.innerHTML =
      '<div class="user-name"></div><div class="user-sub">Connecto member</div>';

    details.querySelector(".user-name").textContent =
      person.displayName || "Connecto user";

    button.append(avatar, details);

    button.addEventListener("click", () => openChat(person));

    list.appendChild(button);
  });
}

// ================= DISPLAY MESSAGES =================

function renderMessage(message) {
  const bubble = document.createElement("div");

  bubble.className =
    "bubble" + (
      message.senderId === currentUser.uid ? " mine" : ""
    );

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
  selectedUser = person;

  $("activeName").textContent =
    person.displayName || "Connecto user";

  $("activeAvatar").textContent =
    (person.displayName || "?").charAt(0).toUpperCase();

  $("activeStatus").textContent =
    "Chat with " + person.displayName;

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

    const messagesRef = collection(
      db,
      "chats",
      id,
      "messages"
    );

    const messagesQuery = query(
      messagesRef,
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
        console.error(error);

        $("activeStatus").textContent =
          "Message access error. Check Firestore rules.";
      }
    );

  } catch (error) {
    console.error(error);

    $("activeStatus").textContent =
      "Could not open chat. Check Firestore rules.";
  }
}

// ================= SEND TEXT OR EMOJI =================

async function sendTextMessage() {
  if (!selectedUser) {
    alert("First select a person from the user list.");
    return;
  }

  const input = $("messageInput");
  const text = input.value.trim();

  if (!text) return;

  const id = chatId(currentUser.uid, selectedUser.uid);

  $("sendBtn").disabled = true;

  try {
    await addDoc(
      collection(db, "chats", id, "messages"),
      {
        text,
        senderId: currentUser.uid,
        createdAt: serverTimestamp()
      }
    );

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

// ================= SEND EMOJIS =================

document.querySelectorAll(".emoji").forEach(button => {
  button.addEventListener("click", async () => {
    if (!selectedUser) {
      alert("First select a person from the user list.");
      return;
    }

    const emoji = button.textContent.trim();

    const id = chatId(currentUser.uid, selectedUser.uid);

    try {
      await addDoc(
        collection(db, "chats", id, "messages"),
        {
          text: emoji,
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
    alert("First select a person from the user list.");
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

  const safeName = file.name.replace(
    /[^a-zA-Z0-9._-]/g,
    "_"
  );

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
      alert(
        "Photo uploaded, but the selected chat changed. Please select the original chat and try again."
      );

      return;
    }

    await addDoc(
      collection(db, "chats", id, "messages"),
      {
        imageUrl,
        senderId: currentUser.uid,
        createdAt: serverTimestamp()
      }
    );

    $("activeStatus").textContent = "Photo sent";

  } catch (error) {
    console.error(error);

    alert("Photo could not be sent: " + friendlyError(error));

    $("activeStatus").textContent = "Photo upload failed";

  } finally {
    event.target.value = "";
  }
});

// ================= SEARCH USERS =================

$("userSearch").addEventListener("input", renderUsers);

// ================= LOAD USERS IN REAL TIME =================

function loadPeople() {
  if (stopUsers) stopUsers();

  stopUsers = onSnapshot(
    collection(db, "users"),
    snapshot => {
      people = snapshot.docs.map(item => item.data());

      renderUsers();
    },
    error => {
      console.error(error);

      $("userList").innerHTML =
        '<div class="notice">Cannot load users. Check Firestore rules.</div>';
    }
  );
}

// ================= START APP AFTER LOGIN =================

function startApp(user) {
  currentUser = user;

  listenForIncomingCalls();

  $("authPage").classList.add("hidden");
  $("chatApp").classList.remove("hidden");

  $("myName").textContent =
    user.displayName || user.email;

  const userRef = doc(db, "users", user.uid);

  setDoc(userRef, {
    uid: user.uid,
    displayName: user.displayName || user.email.split("@")[0]
  }, { merge: true })
    .then(loadPeople)
    .catch(error => {
      console.error(error);

      $("userList").innerHTML =
        '<div class="notice">Cannot save your profile. Check Firestore rules.</div>';
    });
}

// ================= INITIALIZE FIREBASE =================

try {
  const firebaseApp = initializeApp(firebaseConfig);

  auth = getAuth(firebaseApp);
  db = getFirestore(firebaseApp);
  storage = getStorage(firebaseApp);

  onAuthStateChanged(auth, user => {
    if (user) {
      startApp(user);

    } else {
      if (currentCallId) {
        endCall();
      } else {
        cleanupCall();
      }

      if (incomingCallUnsub) {
        incomingCallUnsub();
        incomingCallUnsub = null;
      }

      currentUser = null;
      selectedUser = null;
      people = [];

      if (stopUsers) {
        stopUsers();
        stopUsers = null;
      }

      if (stopMessages) {
        stopMessages();
        stopMessages = null;
      }

      $("authPage").classList.remove("hidden");
      $("chatApp").classList.add("hidden");

      showLogin();
    }
  });

} catch (error) {
  showError(error.message);
  console.error(error);
}
