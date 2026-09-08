const $ = selector => document.querySelector(selector);

let localStream = null;
let screenStream = null;
let peer = null;
let dataChannel = null;
let recorder = null;
let recordedChunks = [];
let seconds = 0;
let cameraEnabled = true;
let microphoneEnabled = true;
let screenSharing = false;
let signalBusy = false;

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ],
  bundlePolicy: 'max-bundle'
};

const toast = message => {
  const element = $('#toast');
  if (!element) return;
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 2800);
};

setInterval(() => {
  seconds++;
  const timer = $('#meetingTimer');
  if (timer) timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}, 1000);

function setStatus(message) {
  const status = $('#p2pStatus');
  if (status) status.textContent = message;
}

function setLocalVideo(source) {
  const video = $('#localVideo');
  if (!video) return;
  video.srcObject = source;
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.hidden = false;
  video.play().catch(() => toast('اضغط داخل الصفحة للسماح بتشغيل الفيديو'));
}

function cameraErrorMessage(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
    return 'اسمح بالكاميرا والميكروفون من رمز القفل بجانب عنوان GitHub Pages ثم أعد المحاولة.';
  }
  if (error?.name === 'NotFoundError') return 'لم يتم العثور على كاميرا أو ميكروفون متصل.';
  if (error?.name === 'NotReadableError') return 'الكاميرا مستخدمة في تطبيق آخر. أغلقه ثم أعد المحاولة.';
  if (error?.name === 'SecurityError' || !window.isSecureContext) return 'افتح رابط GitHub Pages عبر HTTPS وليس من ملف HTML محلي.';
  return `تعذر تشغيل الوسائط: ${error?.name || 'خطأ غير معروف'}`;
}

async function initMedia() {
  if (localStream) {
    setLocalVideo(localStream);
    return true;
  }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    toast('الكاميرا تحتاج HTTPS. استخدم رابط GitHub Pages الذي يبدأ بـ https://');
    return false;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (error) {
    console.error('getUserMedia failed:', error);
    toast(cameraErrorMessage(error));
    return false;
  }

  const videoTrack = localStream.getVideoTracks()[0];
  const audioTrack = localStream.getAudioTracks()[0];
  cameraEnabled = !!videoTrack?.enabled;
  microphoneEnabled = !!audioTrack?.enabled;
  setLocalVideo(localStream);
  if ($('#localPlaceholder')) $('#localPlaceholder').style.display = videoTrack ? 'none' : 'flex';
  if ($('#localMicState')) $('#localMicState').textContent = audioTrack ? '🎙' : '🔇';
  toast('تم تشغيل الكاميرا والميكروفون');
  return true;
}

function encodeSignal(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  bytes.forEach(byte => binary += String.fromCharCode(byte));
  return btoa(binary);
}

function decodeSignal(value) {
  try {
    const normalized = value.trim().replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    toast('الرمز غير صحيح. انسخه كاملاً دون تعديل أو مسافات.');
    return null;
  }
}

function waitForIceGathering(connection) {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      connection.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => {
      if (connection.iceGatheringState === 'complete') finish();
    };
    connection.addEventListener('icegatheringstatechange', check);
    setTimeout(finish, 10000);
  });
}

function updateParticipants(connected) {
  const count = connected ? 2 : 1;
  if ($('#participantCount')) $('#participantCount').textContent = count;
  if ($('#participantLabel')) $('#participantLabel').textContent = `${count} ${count === 1 ? 'مشارك' : 'مشاركين'}`;
  if ($('#remoteCard')) $('#remoteCard').style.display = connected ? 'flex' : 'none';
  if ($('#remotePeople')) {
    $('#remotePeople').innerHTML = connected
      ? '<div class="person" id="remotePerson"><span class="person-avatar green">م</span><div><b>المشارك المتصل</b><small>متصل الآن</small></div><span id="remotePersonMic">🎙</span></div>'
      : '';
  }
}

function setupDataChannel(channel) {
  dataChannel = channel;
  dataChannel.onopen = () => toast('المحادثة المباشرة متصلة');
  dataChannel.onclose = () => toast('انقطعت قناة المحادثة');
  dataChannel.onerror = () => toast('تعذر إرسال رسالة عبر الاتصال المباشر');
  dataChannel.onmessage = event => {
    try {
      const packet = JSON.parse(event.data);
      if (packet.type === 'chat') {
        const item = document.createElement('div');
        item.className = 'chat-item';
        item.textContent = packet.text;
        $('#chatList')?.append(item);
        if ($('#messageCount')) $('#messageCount').textContent = Number($('#messageCount').textContent) + 1;
        $('#chatList').scrollTop = 1e6;
      }
      if (packet.type === 'reaction') toast(`تفاعل المشارك ${packet.text}`);
    } catch (_) {
      console.warn('Invalid data channel packet');
    }
  };
}

function setupPeer() {
  if (peer) peer.close();
  peer = new RTCPeerConnection(rtcConfig);
  updateParticipants(false);
  if (localStream) localStream.getTracks().forEach(track => peer.addTrack(track, localStream));

  peer.ontrack = event => {
    let remote = $('#remoteVideo').srcObject;
    if (!(remote instanceof MediaStream)) remote = new MediaStream();
    if (!remote.getTracks().some(track => track.id === event.track.id)) remote.addTrack(event.track);
    $('#remoteVideo').srcObject = remote;
    $('#remoteVideo').play().catch(() => toast('اضغط داخل الصفحة لتشغيل فيديو المشارك'));
    $('#remotePlaceholder').style.display = 'none';
    $('#remoteStatus').textContent = 'متصل';
    updateParticipants(true);
  };

  peer.ondatachannel = event => setupDataChannel(event.channel);
  peer.onconnectionstatechange = () => {
    const state = peer.connectionState;
    setStatus(`الحالة الحالية: ${state}`);
    if (state === 'connected') {
      updateParticipants(true);
      toast('تم الاتصال الحقيقي بنجاح');
    }
    if (['failed', 'disconnected', 'closed'].includes(state)) {
      updateParticipants(false);
      $('#remoteStatus').textContent = 'في انتظار الاتصال';
      $('#remotePlaceholder').style.display = 'flex';
    }
  };
}

async function createOffer() {
  if (signalBusy || !(await initMedia())) return;
  signalBusy = true;
  try {
    setupPeer();
    setupDataChannel(peer.createDataChannel('meet-chat', { ordered: true }));
    await peer.setLocalDescription(await peer.createOffer());
    setStatus('جاري تجهيز العرض... لا تغلق النافذة.');
    await waitForIceGathering(peer);
    $('#signalOutput').value = encodeSignal(peer.localDescription);
    setStatus('تم إنشاء العرض. انسخه وأرسله للمشارك الثاني.');
    toast('العرض جاهز للنسخ');
  } catch (error) {
    console.error(error);
    toast('تعذر إنشاء عرض الاتصال');
  } finally {
    signalBusy = false;
  }
}

async function prepareAnswer() {
  if (!(await initMedia())) return;
  if (!peer) setupPeer();
  setStatus('الصق عرض المضيف في الرمز الوارد ثم اضغط معالجة الرمز.');
  toast('الجهاز جاهز لاستقبال عرض المضيف');
}

function toggleTrack(kind) {
  const tracks = kind === 'audio' ? localStream?.getAudioTracks() : localStream?.getVideoTracks();
  if (!tracks?.length) return toast(kind === 'audio' ? 'لا يوجد ميكروفون متاح' : 'لا توجد كاميرا متاحة');
  const enabled = tracks.some(track => track.enabled);
  tracks.forEach(track => track.enabled = !enabled);
  if (kind === 'audio') {
    microphoneEnabled = !enabled;
    $('#localMicState').textContent = microphoneEnabled ? '🎙' : '🔇';
    $('#localPersonMic').textContent = microphoneEnabled ? '🎙' : '🔇';
    $('#micBtn').classList.toggle('off', !microphoneEnabled);
  } else {
    cameraEnabled = !enabled;
    $('#localPlaceholder').style.display = cameraEnabled ? 'none' : 'flex';
    $('#cameraBtn').classList.toggle('off', !cameraEnabled);
  }
  toast(enabled ? 'تم الإيقاف' : 'تم التشغيل');
}

async function stopScreenShare() {
  if (!screenStream) return;
  const cameraTrack = localStream?.getVideoTracks()[0];
  const sender = peer?.getSenders().find(item => item.track?.kind === 'video' || item.transceiver?.receiver?.track?.kind === 'video');
  if (sender && cameraTrack) await sender.replaceTrack(cameraTrack);
  screenStream.getTracks().forEach(track => track.stop());
  screenStream = null;
  screenSharing = false;
  setLocalVideo(localStream);
  $('#shareBtn').classList.remove('active');
  toast('عادت الكاميرا');
}

async function toggleScreenShare() {
  if (!peer || peer.connectionState !== 'connected') return toast('اتصل بالمشارك أولاً ثم ابدأ المشاركة');
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('مشاركة الشاشة غير مدعومة في هذا المتصفح');
  if (screenSharing) return stopScreenShare();
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'motion' }, audio: false });
    const screenTrack = screenStream.getVideoTracks()[0];
    const sender = peer.getSenders().find(item => item.track?.kind === 'video');
    if (!sender) throw new Error('video-sender-not-found');
    await sender.replaceTrack(screenTrack);
    screenSharing = true;
    setLocalVideo(screenStream);
    $('#shareBtn').classList.add('active');
    screenTrack.onended = () => stopScreenShare();
    toast('بدأت مشاركة الشاشة مع المشارك');
  } catch (error) {
    console.error(error);
    screenStream = null;
    toast(error.name === 'NotAllowedError' ? 'تم إلغاء مشاركة الشاشة' : 'تعذر بدء مشاركة الشاشة');
  }
}

$('#micBtn').onclick = () => toggleTrack('audio');
$('#cameraBtn').onclick = () => toggleTrack('video');
$('#shareBtn').onclick = toggleScreenShare;

$('#chatForm').onsubmit = event => {
  event.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  const item = document.createElement('div');
  item.className = 'chat-item me';
  item.textContent = text;
  $('#chatList').append(item);
  $('#chatList').scrollTop = 1e6;
  if (dataChannel?.readyState === 'open') dataChannel.send(JSON.stringify({ type: 'chat', text }));
  input.value = '';
  $('#messageCount').textContent = Number($('#messageCount').textContent) + 1;
};

$('#createOfferBtn').onclick = createOffer;
$('#createAnswerBtn').onclick = prepareAnswer;
$('#applySignalBtn').onclick = async () => {
  const value = decodeSignal($('#signalInput').value);
  if (!value || !value.type || !value.sdp) return;
  if (!(await initMedia())) return;
  try {
    if (value.type === 'offer') {
      if (!peer) setupPeer();
      await peer.setRemoteDescription(value);
      await peer.setLocalDescription(await peer.createAnswer());
      setStatus('جاري تجهيز الرد...');
      await waitForIceGathering(peer);
      $('#signalOutput').value = encodeSignal(peer.localDescription);
      setStatus('تم إنشاء الرد. انسخه وأرسله إلى المضيف.');
      toast('الرد جاهز للنسخ');
    } else if (value.type === 'answer') {
      if (!peer || peer.signalingState !== 'have-local-offer') {
        throw new Error('يجب إنشاء عرض على هذا الجهاز أولاً');
      }
      await peer.setRemoteDescription(value);
      setStatus('تم قبول الرد. انتظر الاتصال الحقيقي...');
      toast('تم قبول رد المشارك');
    } else {
      throw new Error('signal-type');
    }
  } catch (error) {
    console.error(error);
    setStatus('تعذر معالجة الرمز. تأكد من استخدام عرض ورد من نفس الجلسة.');
    toast(error.message || 'رمز غير صالح أو مستخدم سابقاً');
  }
};

$('#copySignalBtn').onclick = async () => {
  const value = $('#signalOutput').value.trim();
  if (!value) return toast('أنشئ العرض أو الرد أولاً');
  try {
    await navigator.clipboard.writeText(value);
    toast('تم نسخ الرمز');
  } catch (_) {
    $('#signalOutput').select();
    toast('تم تحديد الرمز؛ انسخه يدوياً');
  }
};

$('#connectBtn').onclick = () => $('#connectDialog').showModal();
$('#connectClose').onclick = () => $('#connectDialog').close();
$('#copyBtn').onclick = () => $('#connectDialog').showModal();
$('#inviteBtn').onclick = () => $('#connectDialog').showModal();
$('#addParticipant').onclick = () => $('#connectDialog').showModal();

$('#chatBtn').onclick = () => {
  $('#sidePanel').classList.add('open');
  document.querySelector('[data-panel="chatPanel"]').click();
};
document.querySelectorAll('.tab').forEach(tab => tab.onclick = () => {
  document.querySelectorAll('.tab, .panel-content').forEach(item => item.classList.remove('active'));
  tab.classList.add('active');
  $(`#${tab.dataset.panel}`).classList.add('active');
  $('#sidePanel').classList.add('open');
});

document.querySelectorAll('#reactionMenu button').forEach(button => button.onclick = () => {
  const text = button.textContent;
  toast(`أرسلت تفاعلاً ${text}`);
  if (dataChannel?.readyState === 'open') dataChannel.send(JSON.stringify({ type: 'reaction', text }));
  $('#reactionMenu').classList.remove('show');
});
$('#reactionBtn').onclick = () => $('#reactionMenu').classList.toggle('show');

const canvas = $('#boardCanvas');
const context = canvas.getContext('2d');
let drawing = false;
function resizeBoard() { canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight; }
window.addEventListener('resize', resizeBoard);
canvas.onpointerdown = event => { drawing = true; canvas.setPointerCapture(event.pointerId); context.beginPath(); context.moveTo(event.offsetX, event.offsetY); };
canvas.onpointerup = () => drawing = false;
canvas.onpointercancel = () => drawing = false;
canvas.onpointermove = event => {
  if (!drawing) return;
  context.strokeStyle = $('#boardColor').value;
  context.lineWidth = 4;
  context.lineCap = 'round';
  context.lineTo(event.offsetX, event.offsetY);
  context.stroke();
};
$('#clearBoard').onclick = () => context.clearRect(0, 0, canvas.width, canvas.height);
$('#boardBtn').onclick = () => {
  const visible = $('#whiteboard').classList.toggle('show');
  $('#videoGrid').style.display = visible ? 'none' : 'grid';
  if (visible) requestAnimationFrame(resizeBoard);
};

$('#recordBtn').onclick = () => {
  if (!localStream) return toast('شغّل الكاميرا أولاً');
  if (recorder) {
    recorder.stop();
    $('#recordBtn').classList.remove('active');
    toast('تم إيقاف التسجيل وحفظه محلياً');
    return;
  }
  try {
    recordedChunks = [];
    recorder = new MediaRecorder(localStream, { mimeType: 'video/webm;codecs=vp8,opus' });
    recorder.ondataavailable = event => event.data.size && recordedChunks.push(event.data);
    recorder.onstop = () => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob(recordedChunks, { type: 'video/webm' }));
      link.download = `netgits-meet-${Date.now()}.webm`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      recorder = null;
    };
    recorder.start(1000);
    $('#recordBtn').classList.add('active');
    toast('بدأ التسجيل محلياً');
  } catch (error) {
    recorder = null;
    toast('التسجيل غير مدعوم بهذا المتصفح');
  }
};

$('#statsBtn').onclick = () => $('#statsDialog').showModal();
$('#fullscreenBtn').onclick = () => {
  const target = $('.stage');
  if (document.fullscreenElement) document.exitFullscreen();
  else target.requestFullscreen?.();
};
$('#layoutBtn').onclick = () => { $('#videoGrid').classList.toggle('single'); toast('تم تبديل تخطيط الفيديو'); };
$('#leaveBtn').onclick = () => { cleanup(); toast('تم إنهاء الاجتماع'); setTimeout(() => location.reload(), 700); };

document.querySelectorAll('dialog .dialog-close').forEach(button => button.onclick = () => button.closest('dialog').close());
function cleanup() {
  if (screenStream) screenStream.getTracks().forEach(track => track.stop());
  if (localStream) localStream.getTracks().forEach(track => track.stop());
  peer?.close();
  screenStream = null;
  localStream = null;
  peer = null;
}
window.addEventListener('beforeunload', cleanup);

updateParticipants(false);
