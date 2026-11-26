/* ==========================================================================
   PRESENSI GURU — SMP N 1 MEKARJAYA
   Core Application Engine (Offline IndexedDB + Google Sheets Auto-Sync,
   WebRTC 4:3 Portrait Camera, Geolocation 500m Radius, Rekap A4 PDF/DOCX,
   & Statistik Analisis Kinerja 37,5 Jam/Pekan)
========================================================================== */

const DEFAULT_CONFIG = {
  app_title: 'PRESENSI GURU',
  app_subtitle: 'SMP N 1 Mekarjaya',
  splash_title: 'PRESENSI GURU',
  splash_subtitle: 'SMP N 1 Mekarjaya',
  logo_sekolah: 'assets/logo-sekolah.png',
  logo_kabupaten: 'assets/logo-pandeglang.png',
  setup_access_code: 'diwantara01',
  admin_access_code: 'diwantara02',
  webapp_url: '',
  center_lat: null,
  center_lng: null,
  center_formatted: '',
  center_locked: false
};

const DEFAULT_GURU = [
  { id: 'G-001', nama: 'R. Dudi Romdiansah, M.Pd', nip: '19701102 199702 1 001' },
  { id: 'G-002', nama: 'Yana Fakhriyana, S.Pd', nip: '19760904 200801 1 007' }
];

const APP_STATE = {
  config: { ...DEFAULT_CONFIG },
  guruList: [],
  presensiList: [],
  offlineQueue: [],
  isAdminUnlocked: false,
  currentCoords: null,
  currentDistance: null,
  capturedPhotoDataUrl: null,
  cameraStream: null,
  galeriPage: 1,
  galeriPerPage: 30,
  charts: { workHours: null, pie: null },
  pendingResetType: null
};

/* ==========================================================================
   1. SOUND EFFECT ENGINE (WEB AUDIO API — ELEGAN & OFFLINE READY)
========================================================================== */
const SoundFX = {
  ctx: null,
  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  },
  playTone(freqs, durations, type = 'sine', gainVal = 0.08) {
    try {
      this.init();
      if (!this.ctx) return;
      let startTime = this.ctx.currentTime;
      freqs.forEach((f, idx) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(f, startTime);
        gain.gain.setValueAtTime(gainVal, startTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, startTime + durations[idx]);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(startTime);
        osc.stop(startTime + durations[idx]);
        startTime += durations[idx] * 0.85;
      });
    } catch (e) {}
  },
  tap() { this.playTone([520], [0.06], 'sine', 0.05); },
  shutter() { this.playTone([880, 440], [0.05, 0.08], 'triangle', 0.1); },
  success() { this.playTone([523.25, 659.25, 783.99], [0.09, 0.09, 0.18], 'sine', 0.09); },
  error() { this.playTone([220, 180], [0.14, 0.22], 'sawtooth', 0.08); },
  unlock() { this.playTone([440, 554.37, 659.25, 880], [0.07, 0.07, 0.07, 0.16], 'sine', 0.08); }
};

/* ==========================================================================
   2. INDEXEDDB STORAGE UNTUK ANTREAN OFFLINE & CACHE FOTO BESAR
========================================================================== */
const LocalDB = {
  dbName: 'PresensiSMPN1MekarjayaDB',
  version: 1,
  db: null,
  async open() {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, this.version);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('presensi')) {
          db.createObjectStore('presensi', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('queue')) {
          db.createObjectStore('queue', { keyPath: 'id' });
        }
      };
      req.onsuccess = (e) => { this.db = e.target.result; resolve(this.db); };
      req.onerror = (e) => reject(e.target.error);
    });
  },
  async getAll(storeName) {
    const db = await this.open();
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  },
  async put(storeName, item) {
    const db = await this.open();
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(item);
      tx.oncomplete = () => resolve(true);
    });
  },
  async bulkReplace(storeName, items) {
    const db = await this.open();
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.clear();
      items.forEach(item => store.put(item));
      tx.oncomplete = () => resolve(true);
    });
  },
  async delete(storeName, id) {
    const db = await this.open();
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(id);
      tx.oncomplete = () => resolve(true);
    });
  },
  async clear(storeName) {
    const db = await this.open();
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve(true);
    });
  }
};

/* ==========================================================================
   3. INISIALISASI, FIRST-TIME SETUP, SPLASH SCREEN & FULLSCREEN
========================================================================== */
document.addEventListener('DOMContentLoaded', async () => {
  registerServiceWorker();
  await loadLocalState();

  // Cek parameter URL ?server=... jika admin membagikan link konfigurasi cepat
  const params = new URLSearchParams(window.location.search);
  const sharedServer = params.get('server');
  if (sharedServer && sharedServer.startsWith('http')) {
    APP_STATE.config.webapp_url = sharedServer;
    saveConfigLocal();
  }

  applyBrandingToDOM();

  const isDeviceActivated = localStorage.getItem('smpn1_device_activated') === 'true';
  if (!isDeviceActivated) {
    document.getElementById('screen-setup').classList.remove('hidden');
    if (APP_STATE.config.webapp_url) {
      document.getElementById('input-setup-server').value = APP_STATE.config.webapp_url;
    }
  } else {
    runSplashAndBoot();
  }

  bindAllEvents();
});

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

async function loadLocalState() {
  try {
    const savedCfg = JSON.parse(localStorage.getItem('smpn1_config') || 'null');
    if (savedCfg) APP_STATE.config = { ...DEFAULT_CONFIG, ...savedCfg };

    const savedGuru = JSON.parse(localStorage.getItem('smpn1_guru') || 'null');
    APP_STATE.guruList = Array.isArray(savedGuru) && savedGuru.length ? savedGuru : [...DEFAULT_GURU];

    APP_STATE.presensiList = await LocalDB.getAll('presensi');
    APP_STATE.offlineQueue = await LocalDB.getAll('queue');
  } catch (e) {
    APP_STATE.guruList = [...DEFAULT_GURU];
  }
}

function saveConfigLocal() {
  localStorage.setItem('smpn1_config', JSON.stringify(APP_STATE.config));
}

function saveGuruLocal() {
  localStorage.setItem('smpn1_guru', JSON.stringify(APP_STATE.guruList));
}

function requestAppFullscreen() {
  const el = document.documentElement;
  if (!document.fullscreenElement) {
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  }
}

async function runSplashAndBoot() {
  const splash = document.getElementById('screen-splash');
  const statusEl = document.getElementById('splash-status');
  splash.classList.remove('hidden');

  if (navigator.onLine && APP_STATE.config.webapp_url) {
    statusEl.textContent = 'Menyinkronkan data dari server Google Sheets...';
    await syncWithServer(true);
  } else {
    statusEl.textContent = 'Menyiapkan mode lokal & offline siap pakai...';
    await new Promise(r => setTimeout(r, 1100));
  }

  applyBrandingToDOM();
  populateGuruDropdown();
  renderAdminPanel();
  initPeriodSelectors();

  splash.classList.add('hidden');
  document.getElementById('main-app').classList.remove('hidden');

  startClock();
  initGeolocation();
  startLiveCamera();
  updateSyncUI();
}

function applyBrandingToDOM() {
  const c = APP_STATE.config;
  document.querySelectorAll('.dynamic-app-title').forEach(el => el.textContent = c.app_title || 'PRESENSI GURU');
  document.querySelectorAll('.dynamic-app-subtitle').forEach(el => el.textContent = c.app_subtitle || 'SMP N 1 Mekarjaya');
  document.querySelectorAll('.dynamic-splash-title').forEach(el => el.textContent = c.splash_title || 'PRESENSI GURU');
  document.querySelectorAll('.dynamic-splash-subtitle').forEach(el => el.textContent = c.splash_subtitle || 'SMP N 1 Mekarjaya');

  document.querySelectorAll('.dynamic-logo-sekolah').forEach(img => {
    img.src = c.logo_sekolah || 'assets/logo-sekolah.png';
  });
  document.querySelectorAll('.dynamic-logo-kabupaten').forEach(img => {
    img.src = c.logo_kabupaten || 'assets/logo-pandeglang.png';
  });
}

/* ==========================================================================
   4. SINKRONISASI DUA ARAH GOOGLE SHEETS + AUTO-SYNC OFFLINE QUEUE
========================================================================== */
async function syncWithServer(silent = false) {
  const url = APP_STATE.config.webapp_url;
  updateSyncUI();

  if (!url) {
    if (!silent) showToast('URL Web App Google Sheets belum diatur di menu Admin.', 'warning');
    return false;
  }
  if (!navigator.onLine) {
    if (!silent) showToast('Tidak ada sinyal internet. Bekerja dalam mode lokal offline.', 'warning');
    return false;
  }

  try {
    // 1. Kirim antrean presensi offline terlebih dahulu jika ada
    const pendingItems = await LocalDB.getAll('queue');
    for (const item of pendingItems) {
      const pushRes = await postToGAS({ action: 'addPresensi', data: item });
      if (pushRes && pushRes.status === 'ok') {
        await LocalDB.delete('queue', item.id);
      }
    }
    APP_STATE.offlineQueue = await LocalDB.getAll('queue');

    // 2. Tarik data terbaru (Config, Guru, Presensi) dari Google Sheets
    const res = await fetch(`${url}?action=getAll&t=${Date.now()}`);
    const json = await res.json();

    if (json && json.status === 'ok') {
      if (json.config) {
        APP_STATE.config = {
          ...APP_STATE.config,
          ...json.config,
          webapp_url: url,
          center_lat: json.config.center_lat !== '' && json.config.center_lat !== null ? parseFloat(json.config.center_lat) : APP_STATE.config.center_lat,
          center_lng: json.config.center_lng !== '' && json.config.center_lng !== null ? parseFloat(json.config.center_lng) : APP_STATE.config.center_lng,
          center_locked: json.config.center_locked === true || json.config.center_locked === 'true'
        };
        saveConfigLocal();
        applyBrandingToDOM();
      }

      if (Array.isArray(json.guru) && json.guru.length > 0) {
        APP_STATE.guruList = json.guru;
        saveGuruLocal();
        populateGuruDropdown();
      }

      if (Array.isArray(json.presensi)) {
        // Gabungkan dengan sisa queue yang belum terkirim agar tidak hilang
        const remainingQueue = await LocalDB.getAll('queue');
        const mapById = new Map();
        json.presensi.forEach(p => mapById.set(p.id, p));
        remainingQueue.forEach(q => mapById.set(q.id, q));
        APP_STATE.presensiList = Array.from(mapById.values());
        await LocalDB.bulkReplace('presensi', APP_STATE.presensiList);
      }

      renderAdminPanel();
      refreshActiveTabViews();
      updateSyncUI();
      if (!silent) showToast('Data berhasil disinkronkan dengan server Google Sheets!', 'success');
      return true;
    }
  } catch (err) {
    if (!silent) showToast('Gagal terhubung ke server. Data tetap aman secara lokal.', 'warning');
  }
  updateSyncUI();
  return false;
}

async function postToGAS(payload) {
  const url = APP_STATE.config.webapp_url;
  if (!url || !navigator.onLine) return null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (e) {
    return null;
  }
}

function updateSyncUI() {
  const pill = document.getElementById('btn-sync-now');
  const label = document.getElementById('sync-label');
  const banner = document.getElementById('offline-queue-banner');
  const countEl = document.getElementById('queue-count');

  const qCount = APP_STATE.offlineQueue.length;
  if (qCount > 0) {
    banner.classList.remove('hidden');
    countEl.textContent = qCount;
  } else {
    banner.classList.add('hidden');
  }

  if (navigator.onLine) {
    pill.className = 'sync-pill online';
    label.textContent = qCount > 0 ? `Sinkron (${qCount})` : 'Online';
  } else {
    pill.className = 'sync-pill offline';
    label.textContent = 'Offline';
  }
}

window.addEventListener('online', () => {
  updateSyncUI();
  showToast('Sinyal internet terdeteksi! Menyinkronkan data otomatis...', 'success');
  syncWithServer(true);
});

window.addEventListener('offline', () => {
  updateSyncUI();
  showToast('Mode Offline aktif. Presensi tetap berjalan & tersimpan lokal.', 'warning');
});

/* ==========================================================================
   5. WAKTU REAL-TIME, GPS HAVERSINE (RADIUS 500M), & KAMERA 4:3 PORTRAIT
========================================================================== */
const HARI_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

function formatTanggalLengkap(dateObj) {
  const hari = HARI_ID[dateObj.getDay()];
  const tgl = String(dateObj.getDate()).padStart(2, '0');
  const bln = BULAN_ID[dateObj.getMonth()];
  const thn = dateObj.getFullYear();
  return `${hari}, ${tgl} ${bln} ${thn}`;
}

function formatJamDetik(dateObj) {
  const h = String(dateObj.getHours()).padStart(2, '0');
  const m = String(dateObj.getMinutes()).padStart(2, '0');
  const s = String(dateObj.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function getLocalISODate(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function startClock() {
  const tick = () => {
    const now = new Date();
    document.getElementById('live-clock-time').textContent = `${formatJamDetik(now)} WIB`;
    document.getElementById('live-clock-date').textContent = formatTanggalLengkap(now);
  };
  tick();
  setInterval(tick, 1000);
}

// Format koordinat baku agar 100% seragam antara Admin & Presensi
function formatCoordsStandard(lat, lng) {
  return `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
}

// Rumus Haversine menghitung jarak dalam meter
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

function initGeolocation() {
  const coordsEl = document.getElementById('live-coords');
  const statusEl = document.getElementById('live-radius-status');

  if (!('geolocation' in navigator)) {
    coordsEl.textContent = 'GPS tidak didukung perangkat';
    return;
  }

  const onPos = (pos) => {
    const lat = Number(pos.coords.latitude.toFixed(6));
    const lng = Number(pos.coords.longitude.toFixed(6));
    APP_STATE.currentCoords = { lat, lng, formatted: formatCoordsStandard(lat, lng) };
    coordsEl.textContent = APP_STATE.currentCoords.formatted;

    const cLat = APP_STATE.config.center_lat;
    const cLng = APP_STATE.config.center_lng;
    if (cLat !== null && cLng !== null && !isNaN(cLat) && !isNaN(cLng)) {
      const dist = calculateDistanceMeters(lat, lng, Number(cLat), Number(cLng));
      APP_STATE.currentDistance = dist;
      if (dist <= 500) {
        statusEl.className = 'radius-badge valid';
        statusEl.textContent = `✓ Dalam Radius Sekolah (${dist} m)`;
      } else {
        statusEl.className = 'radius-badge invalid';
        statusEl.textContent = `✕ Diluar Radius Sekolah (${dist} m)`;
      }
    } else {
      APP_STATE.currentDistance = null;
      statusEl.className = 'radius-badge neutral';
      statusEl.textContent = 'Titik pusat sekolah belum diatur Admin';
    }
  };

  const onErr = () => {
    coordsEl.textContent = 'Izin lokasi diperlukan (Aktifkan GPS)';
    statusEl.className = 'radius-badge invalid';
    statusEl.textContent = 'Gagal mengunci sinyal GPS';
  };

  navigator.geolocation.getCurrentPosition(onPos, onErr, { enableHighAccuracy: true, timeout: 12000 });
  navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 5000 });
}

// Kamera Live 4:3 Portrait & Anti-Galeri
async function startLiveCamera() {
  const video = document.getElementById('camera-video');
  const placeholder = document.getElementById('camera-placeholder');

  try {
    if (APP_STATE.cameraStream) {
      APP_STATE.cameraStream.getTracks().forEach(t => t.stop());
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 720 },
        height: { ideal: 960 }
      },
      audio: false
    });
    APP_STATE.cameraStream = stream;
    video.srcObject = stream;
    placeholder.classList.add('hidden');
  } catch (err) {
    placeholder.innerHTML = '<p>⚠️ Izin kamera ditolak atau kamera tidak tersedia.<br>Izinkan akses kamera pada browser.</p>';
  }
}

function captureLivePhoto4x3() {
  const video = document.getElementById('camera-video');
  const canvas = document.getElementById('camera-canvas');
  const preview = document.getElementById('camera-preview');

  if (!video.videoWidth || !video.videoHeight) {
    showToast('Kamera belum siap. Mohon tunggu sebentar.', 'warning');
    return;
  }

  SoundFX.shutter();

  // Dimensi target 4:3 Portrait (360 x 480 px) agar tajam namun muat di sel Google Sheets (<45KB)
  const targetW = 360;
  const targetH = 480;
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');

  // Crop tengah otomatis ke rasio 3:4 portrait
  const srcRatio = video.videoWidth / video.videoHeight;
  const dstRatio = targetW / targetH;
  let sx = 0, sy = 0, sW = video.videoWidth, sH = video.videoHeight;

  if (srcRatio > dstRatio) {
    sW = video.videoHeight * dstRatio;
    sx = (video.videoWidth - sW) / 2;
  } else {
    sH = video.videoWidth / dstRatio;
    sy = (video.videoHeight - sH) / 2;
  }

  // Mirror horizontal agar natural seperti cermin selfie
  ctx.save();
  ctx.translate(targetW, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, sx, sy, sW, sH, 0, 0, targetW, targetH);
  ctx.restore();

  // Kompresi adaptif agar ukuran Base64 selalu aman (< 44.000 karakter)
  let quality = 0.68;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);
  while (dataUrl.length > 44000 && quality > 0.3) {
    quality -= 0.08;
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  }

  APP_STATE.capturedPhotoDataUrl = dataUrl;
  preview.src = dataUrl;
  preview.classList.remove('hidden');
  video.classList.add('hidden');

  document.getElementById('btn-capture-photo').classList.add('hidden');
  document.getElementById('btn-retake-photo').classList.remove('hidden');
}

function retakeLivePhoto() {
  SoundFX.tap();
  APP_STATE.capturedPhotoDataUrl = null;
  document.getElementById('camera-preview').classList.add('hidden');
  document.getElementById('camera-video').classList.remove('hidden');
  document.getElementById('btn-capture-photo').classList.remove('hidden');
  document.getElementById('btn-retake-photo').classList.add('hidden');
}

/* ==========================================================================
   6. SUBMIT PRESENSI & VALIDASI KETAT
========================================================================== */
function populateGuruDropdown() {
  const select = document.getElementById('presensi-guru');
  const prevVal = select.value;
  select.innerHTML = '<option value="">-- Pilih Nama Guru --</option>';
  APP_STATE.guruList.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = `${g.nama} — NIP. ${g.nip || '-'}`;
    select.appendChild(opt);
  });
  if (prevVal) select.value = prevVal;
}

function countWords(str) {
  return str.trim().split(/\s+/).filter(Boolean).length;
}

async function handlePresensiSubmit(e) {
  e.preventDefault();

  const guruId = document.getElementById('presensi-guru').value;
  const kategoriEl = document.querySelector('input[name="kategori_presensi"]:checked');

  if (!APP_STATE.capturedPhotoDataUrl) {
    SoundFX.error();
    showToast('Silakan ambil foto live terlebih dahulu!', 'error');
    return;
  }
  if (!APP_STATE.currentCoords) {
    SoundFX.error();
    showToast('Lokasi GPS belum terdeteksi. Pastikan GPS aktif!', 'error');
    return;
  }
  if (!guruId) {
    SoundFX.error();
    showToast('Silakan pilih nama guru terlebih dahulu!', 'error');
    return;
  }
  if (!kategoriEl) {
    SoundFX.error();
    showToast('Silakan pilih keterangan kehadiran (Hadir, Sakit, Izin, atau Dinas Luar)!', 'error');
    return;
  }

  const kategori = kategoriEl.value;
  let subKategori = '';
  let keterangan = '';
  let tempat = '';

  if (kategori === 'Hadir') {
    const subHadirEl = document.querySelector('input[name="sub_hadir"]:checked');
    if (!subHadirEl) {
      SoundFX.error();
      showToast('Pilih status Hadir: Datang atau Pulang!', 'error');
      return;
    }
    subKategori = subHadirEl.value;

    // Validasi Radius Sekolah Maksimal 500 Meter
    if (APP_STATE.config.center_lat === null || APP_STATE.config.center_lng === null) {
      SoundFX.error();
      showToast('Lokasi pusat sekolah belum diatur oleh Admin!', 'error');
      return;
    }
    if (APP_STATE.currentDistance === null || APP_STATE.currentDistance > 500) {
      SoundFX.error();
      showToast(`Anda diluar radius sekolah! (Jarak Anda: ${APP_STATE.currentDistance ?? '?'} m, Maksimal: 500 m)`, 'error');
      return;
    }
    keterangan = `Hadir ${subKategori} di Sekolah`;
  } else if (kategori === 'Sakit') {
    keterangan = document.getElementById('ket-sakit').value.trim();
    if (!keterangan) {
      SoundFX.error();
      showToast('Keterangan sakit wajib diisi dengan mengetik!', 'error');
      return;
    }
  } else if (kategori === 'Izin') {
    keterangan = document.getElementById('ket-izin').value.trim();
    if (!keterangan) {
      SoundFX.error();
      showToast('Keterangan izin wajib diisi dengan mengetik!', 'error');
      return;
    }
  } else if (kategori === 'Dinas Luar') {
    const subDlEl = document.querySelector('input[name="sub_dl"]:checked');
    if (!subDlEl) {
      SoundFX.error();
      showToast('Pilih jenis Dinas Luar: Datang atau Pulang!', 'error');
      return;
    }
    subKategori = subDlEl.value;
    if (subKategori === 'Datang') {
      keterangan = document.getElementById('dl-kegiatan').value.trim();
      tempat = document.getElementById('dl-tempat').value.trim();
      if (!keterangan || !tempat) {
        SoundFX.error();
        showToast('Keterangan kegiatan dan tempat dinas luar wajib diisi!', 'error');
        return;
      }
    } else {
      keterangan = document.getElementById('dl-catatan-pulang').value.trim();
      const words = countWords(keterangan);
      if (words < 30) {
        SoundFX.error();
        showToast(`Catatan kegiatan dinas luar pulang wajib minimal 30 kata (saat ini: ${words} kata)!`, 'error');
        return;
      }
    }
  }

  const guru = APP_STATE.guruList.find(g => g.id === guruId) || { nama: 'Guru', nip: '-' };
  const now = new Date();
  const record = {
    id: `PRS-${now.getTime()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
    tanggal_iso: getLocalISODate(now),
    hari: HARI_ID[now.getDay()],
    tanggal_str: formatTanggalLengkap(now),
    waktu_str: formatJamDetik(now),
    timestamp_ms: now.getTime(),
    guru_id: guru.id,
    nama: guru.nama,
    nip: guru.nip,
    kategori,
    sub_kategori: subKategori,
    keterangan,
    tempat,
    lat: APP_STATE.currentCoords.lat,
    lng: APP_STATE.currentCoords.lng,
    lokasi_str: APP_STATE.currentCoords.formatted,
    jarak_meter: APP_STATE.currentDistance ?? 0,
    foto: APP_STATE.capturedPhotoDataUrl
  };

  // Simpan langsung ke IndexedDB lokal terlebih dahulu (instan & anti-hilang)
  APP_STATE.presensiList.unshift(record);
  await LocalDB.put('presensi', record);

  // Kirim ke server Google Sheets atau masukkan ke antrean offline
  let syncedNow = false;
  if (navigator.onLine && APP_STATE.config.webapp_url) {
    const res = await postToGAS({ action: 'addPresensi', data: record });
    if (res && res.status === 'ok') {
      syncedNow = true;
    }
  }

  if (!syncedNow) {
    APP_STATE.offlineQueue.push(record);
    await LocalDB.put('queue', record);
  }

  updateSyncUI();
  SoundFX.success();

  if (syncedNow) {
    showToast(`Presensi ${guru.nama} (${kategori}) berhasil terkirim & tersinkron!`, 'success');
  } else {
    showToast(`Presensi ${guru.nama} disimpan secara lokal & otomatis tersinkron saat sinyal ditemukan.`, 'warning');
  }

  // Reset form & kamera
  document.getElementById('form-presensi').reset();
  hideAllPresensiSubboxes();
  retakeLivePhoto();
}

function hideAllPresensiSubboxes() {
  ['box-hadir', 'box-sakit', 'box-izin', 'box-dinas-luar', 'box-dl-datang', 'box-dl-pulang'].forEach(id => {
    document.getElementById(id).classList.add('hidden');
  });
}

/* ==========================================================================
   7. MENU 3: GALERI FOTO LIVE (4:3 PORTRAIT, MAX 30 FOTO/HALAMAN)
========================================================================== */
function renderGaleri() {
  const search = document.getElementById('galeri-search').value.toLowerCase().trim();
  const kat = document.getElementById('galeri-filter-kategori').value;
  const sort = document.getElementById('galeri-sort').value;
  const filterDate = document.getElementById('galeri-filter-date').value;

  let items = [...APP_STATE.presensiList];

  if (search) {
    items = items.filter(p =>
      (p.nama || '').toLowerCase().includes(search) ||
      (p.nip || '').toLowerCase().includes(search) ||
      (p.keterangan || '').toLowerCase().includes(search)
    );
  }

  if (kat !== 'ALL') {
    if (kat === 'Hadir' || kat === 'Dinas Luar') {
      items = items.filter(p => p.kategori === kat);
    } else {
      items = items.filter(p => `${p.kategori} - ${p.sub_kategori}` === kat);
    }
  }

  if (filterDate) {
    items = items.filter(p => p.tanggal_iso === filterDate);
  }

  // Default: terbaru ke terlama
  items.sort((a, b) => {
    if (sort === 'oldest') return (a.timestamp_ms || 0) - (b.timestamp_ms || 0);
    if (sort === 'name_asc') return (a.nama || '').localeCompare(b.nama || '');
    return (b.timestamp_ms || 0) - (a.timestamp_ms || 0);
  });

  const total = items.length;
  const perPage = APP_STATE.galeriPerPage; // 30 foto maksimal per halaman
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (APP_STATE.galeriPage > totalPages) APP_STATE.galeriPage = totalPages;

  const startIdx = (APP_STATE.galeriPage - 1) * perPage;
  const pageItems = items.slice(startIdx, startIdx + perPage);

  document.getElementById('galeri-summary-bar').textContent =
    `Menampilkan ${pageItems.length} dari ${total} foto live (Halaman ${APP_STATE.galeriPage} / ${totalPages})`;

  const grid = document.getElementById('galeri-grid');
  if (pageItems.length === 0) {
    grid.innerHTML = '<div class="card" style="grid-column:1/-1;text-align:center;color:#64748b;">Belum ada foto presensi yang sesuai filter.</div>';
  } else {
    grid.innerHTML = pageItems.map(p => {
      const labelKat = p.sub_kategori ? `${p.kategori} - ${p.sub_kategori}` : p.kategori;
      return `
        <div class="galeri-item" onclick="openPhotoDetail('${p.id}')">
          <div class="galeri-thumb-4-3">
            <img src="${p.foto}" alt="${escapeHtml(p.nama)}" loading="lazy" />
          </div>
          <div class="galeri-meta">
            <span class="galeri-badge">${escapeHtml(labelKat)}</span>
            <div class="galeri-name">${escapeHtml(p.nama)}</div>
            <div class="galeri-nip">NIP. ${escapeHtml(p.nip || '-')}</div>
            <div class="galeri-time">${escapeHtml(p.tanggal_str)} • ${escapeHtml(p.waktu_str)}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  renderGaleriPagination(totalPages);
}

function renderGaleriPagination(totalPages) {
  const bar = document.getElementById('galeri-pagination');
  if (totalPages <= 1) {
    bar.innerHTML = '';
    return;
  }
  let html = '';
  if (APP_STATE.galeriPage > 1) {
    html += `<button type="button" class="page-btn" onclick="changeGaleriPage(${APP_STATE.galeriPage - 1})">‹ Prev</button>`;
  }
  for (let i = 1; i <= totalPages; i++) {
    html += `<button type="button" class="page-btn ${i === APP_STATE.galeriPage ? 'active' : ''}" onclick="changeGaleriPage(${i})">${i}</button>`;
  }
  if (APP_STATE.galeriPage < totalPages) {
    html += `<button type="button" class="page-btn" onclick="changeGaleriPage(${APP_STATE.galeriPage + 1})">Next ›</button>`;
  }
  bar.innerHTML = html;
}

function changeGaleriPage(page) {
  SoundFX.tap();
  APP_STATE.galeriPage = page;
  renderGaleri();
  document.getElementById('tab-galeri').scrollIntoView({ behavior: 'smooth' });
}

function openPhotoDetail(id) {
  const p = APP_STATE.presensiList.find(x => x.id === id);
  if (!p) return;
  SoundFX.tap();
  document.getElementById('modal-photo-img').src = p.foto;
  const labelKat = p.sub_kategori ? `${p.kategori} - ${p.sub_kategori}` : p.kategori;
  document.getElementById('modal-photo-details').innerHTML = `
    <p><strong>${escapeHtml(p.nama)}</strong><br><small>NIP. ${escapeHtml(p.nip || '-')}</small></p>
    <p style="margin-top:8px;"><strong>Status:</strong> ${escapeHtml(labelKat)}<br>
    <strong>Waktu:</strong> ${escapeHtml(p.tanggal_str)} pukul ${escapeHtml(p.waktu_str)} WIB<br>
    <strong>Koordinat:</strong> ${escapeHtml(p.lokasi_str)} (${p.jarak_meter} m dari sekolah)<br>
    ${p.tempat ? `<strong>Tempat DL:</strong> ${escapeHtml(p.tempat)}<br>` : ''}
    <strong>Keterangan:</strong> ${escapeHtml(p.keterangan || '-')}</p>
  `;
  document.getElementById('modal-photo').classList.remove('hidden');
}

/* ==========================================================================
   8. ENGINE KALENDER PEKAN (SENIN–MINGGU) & KALKULATOR ANALISIS KINERJA
========================================================================== */
// Mendapatkan Senin dari pekan tanggal tertentu
function getMondayOfDate(d) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = date.getDay(); // 0=Minggu, 1=Senin
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(date.setDate(diff));
}

function getWeekBounds(mondayDate) {
  const start = new Date(mondayDate.getFullYear(), mondayDate.getMonth(), mondayDate.getDate(), 0, 0, 0);
  const end = new Date(mondayDate.getFullYear(), mondayDate.getMonth(), mondayDate.getDate() + 6, 23, 59, 59);
  return {
    start,
    end,
    startIso: getLocalISODate(start),
    endIso: getLocalISODate(end),
    label: `${String(start.getDate()).padStart(2, '0')} ${BULAN_ID[start.getMonth()].slice(0, 3)} – ${String(end.getDate()).padStart(2, '0')} ${BULAN_ID[end.getMonth()].slice(0, 3)} ${end.getFullYear()}`
  };
}

// Bangun daftar 52 pekan terakhir + 4 pekan ke depan
function generateWeekOptions() {
  const options = [];
  const todayMonday = getMondayOfDate(new Date());
  for (let i = -24; i <= 2; i++) {
    const mon = new Date(todayMonday.getFullYear(), todayMonday.getMonth(), todayMonday.getDate() + i * 7);
    const bounds = getWeekBounds(mon);
    options.push({
      value: bounds.startIso,
      label: `Pekan (${bounds.label})`,
      bounds
    });
  }
  return options.reverse();
}

function generateMonthOptions() {
  const options = [];
  const now = new Date();
  for (let i = 0; i < 18; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    options.push({
      value: val,
      label: `${BULAN_ID[d.getMonth()]} ${d.getFullYear()}`
    });
  }
  return options;
}

function generateYearOptions() {
  const currentYear = new Date().getFullYear();
  return [currentYear, currentYear - 1, currentYear - 2].map(y => ({
    value: String(y),
    label: `Tahun ${y}`
  }));
}

function initPeriodSelectors() {
  updatePeriodDropdown('rekap');
  updatePeriodDropdown('stat');
  updateStatSubcategoryOptions();
  document.getElementById('ttd-date-line').textContent = `Mekarjaya, ${String(new Date().getDate()).padStart(2, '0')} ${BULAN_ID[new Date().getMonth()]} ${new Date().getFullYear()}`;
}

function updatePeriodDropdown(prefix) {
  const typeEl = document.getElementById(`${prefix}-period-type`);
  const valEl = document.getElementById(`${prefix}-period-value`);
  const type = typeEl.value;

  if (type === 'current_week') {
    const curBounds = getWeekBounds(getMondayOfDate(new Date()));
    valEl.innerHTML = `<option value="${curBounds.startIso}">Pekan Ini (${curBounds.label})</option>`;
    return;
  }

  let opts = [];
  if (type === 'weekly') opts = generateWeekOptions();
  else if (type === 'monthly') opts = generateMonthOptions();
  else if (type === 'yearly') opts = generateYearOptions();

  valEl.innerHTML = opts.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
  if (type === 'weekly') {
    const curMonIso = getLocalISODate(getMondayOfDate(new Date()));
    if (opts.some(o => o.value === curMonIso)) valEl.value = curMonIso;
  }
}

function getDateRangeFromPeriod(type, val) {
  if (type === 'current_week' || type === 'weekly') {
    const [y, m, d] = val.split('-').map(Number);
    const bounds = getWeekBounds(new Date(y, m - 1, d));
    return { startIso: bounds.startIso, endIso: bounds.endIso, label: `Pekan ${bounds.label}`, weeksCount: 1 };
  }
  if (type === 'monthly') {
    const [y, m] = val.split('-').map(Number);
    const start = new Date(y, m - 1, 1);
    const end = new Date(y, m, 0);
    return {
      startIso: getLocalISODate(start),
      endIso: getLocalISODate(end),
      label: `Bulan ${BULAN_ID[m - 1]} ${y}`,
      weeksCount: 4.33
    };
  }
  const y = Number(val);
  return {
    startIso: `${y}-01-01`,
    endIso: `${y}-12-31`,
    label: `Tahun ${y}`,
    weeksCount: 52
  };
}

function timeStrToSeconds(timeStr) {
  const parts = (timeStr || '00:00:00').split(':').map(Number);
  return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
}

function formatDurationHours(totalHours) {
  const h = Math.floor(totalHours);
  const m = Math.round((totalHours - h) * 60);
  return `${h} jam ${m} mnt`;
}

function formatMinutesDiff(mins) {
  const abs = Math.round(Math.abs(mins));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return h > 0 ? `${h}j ${m}m` : `${m} mnt`;
}

function getPerformanceBadge(weeklyHours) {
  if (weeklyHours > 40) return { label: 'Kinerja Sangat Baik', cls: 'perf-sangat-baik' };
  if (weeklyHours >= 37.5) return { label: 'Kinerja Baik', cls: 'perf-baik' };
  if (weeklyHours >= 35) return { label: 'Kinerja Cukup Baik', cls: 'perf-cukup' };
  return { label: 'Kinerja Kurang Baik', cls: 'perf-kurang' };
}

/* ==========================================================================
   KALKULATOR INTI ANALISIS GURU (SEMUA ATURAN WAKTU & LUPA ABSEN)
   - Datang & pulang hari sama = 1 kehadiran; datang/pulang saja = 1 kehadiran
   - Durasi Hadir + Dinas Luar digabungkan
   - Lupa Datang (pulang saja) -> dihitung datang pukul 10:20:00
   - Lupa Pulang (datang saja hingga hari berikutnya) -> dihitung pulang 13:10:00
   - Jam Masuk Standar: 07:40:00
   - Jam Pulang Standar: Senin-Rabu 15:10:00, Kamis 13:10:00, Jumat 11:00:00
   - Sabtu & Minggu: tidak diberlakukan perhitungan pulang awal/akhir
========================================================================== */
function computeTeacherMetricsForRange(startIso, endIso, weeksCount = 1) {
  const todayIso = getLocalISODate(new Date());
  const filtered = APP_STATE.presensiList.filter(p => p.tanggal_iso >= startIso && p.tanggal_iso <= endIso);

  return APP_STATE.guruList.map(guru => {
    const records = filtered.filter(p => p.guru_id === guru.id || p.nama === guru.nama);

    // Kelompokkan per tanggal YYYY-MM-DD
    const byDate = {};
    records.forEach(r => {
      if (!byDate[r.tanggal_iso]) byDate[r.tanggal_iso] = [];
      byDate[r.tanggal_iso].push(r);
    });

    let countHadir = 0;
    let countSakit = 0;
    let countIzin = 0;
    let countDL = 0;
    let totalWorkSeconds = 0;

    // Metrik kedatangan (patokan 07:40:00 = 27600 detik)
    const JAM_MASUK_SEC = 7 * 3600 + 40 * 60;
    let earlyArrivalMinsList = [];
    let lateCount = 0;
    let lateMinsList = [];

    // Metrik kepulangan (Senin-Rabu 15:10, Kamis 13:10, Jumat 11:00; Sabtu-Minggu dikecualikan)
    let earlyLeaveMinsList = [];
    let lateLeaveMinsList = [];

    const dailyLogs = [];

    Object.keys(byDate).sort().forEach(dateIso => {
      const dayRecs = byDate[dateIso];
      const [yy, mm, dd] = dateIso.split('-').map(Number);
      const dayOfWeek = new Date(yy, mm - 1, dd).getDay(); // 0=Minggu, 1=Senin..6=Sabtu

      const hadirRecs = dayRecs.filter(r => r.kategori === 'Hadir');
      const dlRecs = dayRecs.filter(r => r.kategori === 'Dinas Luar');
      const sakitRecs = dayRecs.filter(r => r.kategori === 'Sakit');
      const izinRecs = dayRecs.filter(r => r.kategori === 'Izin');

      if (hadirRecs.length > 0) countHadir += 1;
      if (dlRecs.length > 0) countDL += 1;
      if (sakitRecs.length > 0) countSakit += 1;
      if (izinRecs.length > 0) countIzin += 1;

      let dayWorkSec = 0;
      let noteList = [];

      // 1. Hitung durasi Hadir hari ini
      if (hadirRecs.length > 0) {
        const datang = hadirRecs.find(r => r.sub_kategori === 'Datang');
        const pulang = hadirRecs.find(r => r.sub_kategori === 'Pulang');

        let startSec = null;
        let endSec = null;

        if (datang && pulang) {
          startSec = timeStrToSeconds(datang.waktu_str);
          endSec = timeStrToSeconds(pulang.waktu_str);
        } else if (!datang && pulang) {
          // Lupa presensi datang -> otomatis dihitung datang pukul 10:20:00
          startSec = 10 * 3600 + 20 * 60;
          endSec = timeStrToSeconds(pulang.waktu_str);
          noteList.push('Lupa absen datang (dihitung 10:20)');
        } else if (datang && !pulang) {
          startSec = timeStrToSeconds(datang.waktu_str);
          if (dateIso < todayIso) {
            // Sudah lewat hari berikutnya -> otomatis dihitung pulang pukul 13:10:00
            endSec = 13 * 3600 + 10 * 60;
            noteList.push('Lupa absen pulang (dihitung 13:10)');
          } else {
            endSec = Math.max(startSec, timeStrToSeconds(formatJamDetik(new Date())));
            noteList.push('Belum absen pulang hari ini');
          }
        }

        if (startSec !== null && endSec !== null && endSec > startSec) {
          dayWorkSec += (endSec - startSec);
        }

        // Evaluasi kedatangan (jika ada presensi datang nyata)
        if (datang) {
          const arrSec = timeStrToSeconds(datang.waktu_str);
          if (arrSec <= JAM_MASUK_SEC) {
            earlyArrivalMinsList.push((JAM_MASUK_SEC - arrSec) / 60);
          } else {
            lateCount += 1;
            lateMinsList.push((arrSec - JAM_MASUK_SEC) / 60);
          }
        }

        // Evaluasi kepulangan (Hanya Senin=1 s.d. Jumat=5; Sabtu=6 & Minggu=0 dikecualikan)
        if (pulang && dayOfWeek >= 1 && dayOfWeek <= 5) {
          let stdPulangSec = 15 * 3600 + 10 * 60; // Senin-Rabu 15:10
          if (dayOfWeek === 4) stdPulangSec = 13 * 3600 + 10 * 60; // Kamis 13:10
          if (dayOfWeek === 5) stdPulangSec = 11 * 3600; // Jumat 11:00

          const depSec = timeStrToSeconds(pulang.waktu_str);
          if (depSec < stdPulangSec) {
            earlyLeaveMinsList.push((stdPulangSec - depSec) / 60);
          } else {
            lateLeaveMinsList.push((depSec - stdPulangSec) / 60);
          }
        }
      }

      // 2. Hitung durasi Dinas Luar hari ini (digabungkan ke total durasi kerja)
      if (dlRecs.length > 0) {
        const dlDatang = dlRecs.find(r => r.sub_kategori === 'Datang');
        const dlPulang = dlRecs.find(r => r.sub_kategori === 'Pulang');

        let dlStart = null;
        let dlEnd = null;
        if (dlDatang && dlPulang) {
          dlStart = timeStrToSeconds(dlDatang.waktu_str);
          dlEnd = timeStrToSeconds(dlPulang.waktu_str);
        } else if (!dlDatang && dlPulang) {
          dlStart = 10 * 3600 + 20 * 60;
          dlEnd = timeStrToSeconds(dlPulang.waktu_str);
          noteList.push('DL lupa datang (dihitung 10:20)');
        } else if (dlDatang && !dlPulang) {
          dlStart = timeStrToSeconds(dlDatang.waktu_str);
          if (dateIso < todayIso) {
            dlEnd = 13 * 3600 + 10 * 60;
            noteList.push('DL lupa pulang (dihitung 13:10)');
          } else {
            dlEnd = Math.max(dlStart, timeStrToSeconds(formatJamDetik(new Date())));
          }
        }
        if (dlStart !== null && dlEnd !== null && dlEnd > dlStart) {
          dayWorkSec += (dlEnd - dlStart);
        }
      }

      totalWorkSeconds += dayWorkSec;
      dailyLogs.push({
        dateIso,
        hari: HARI_ID[dayOfWeek],
        status: dayRecs.map(r => r.sub_kategori ? `${r.kategori} (${r.sub_kategori})` : r.kategori).join(', '),
        hours: +(dayWorkSec / 3600).toFixed(2),
        notes: noteList.join('; ')
      });
    });

    const totalWorkHours = +(totalWorkSeconds / 3600).toFixed(2);
    const avgWeeklyHours = +(totalWorkHours / Math.max(1, weeksCount)).toFixed(2);
    const badge = getPerformanceBadge(avgWeeklyHours);

    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    return {
      guru,
      countHadir,
      countSakit,
      countIzin,
      countDL,
      totalPresent: countHadir + countDL,
      totalAbsent: countSakit + countIzin,
      totalWorkHours,
      avgWeeklyHours,
      badge,
      avgEarlyArrivalMins: +avg(earlyArrivalMinsList).toFixed(1),
      lateCount,
      avgLateMins: +avg(lateMinsList).toFixed(1),
      avgEarlyLeaveMins: +avg(earlyLeaveMinsList).toFixed(1),
      avgLateLeaveMins: +avg(lateLeaveMinsList).toFixed(1),
      dailyLogs
    };
  });
}

/* ==========================================================================
   9. MENU 4: REKAP KEHADIRAN, PRINT A4, UNDUH PDF & DOCX
========================================================================== */
function renderRekap() {
  const type = document.getElementById('rekap-period-type').value;
  const val = document.getElementById('rekap-period-value').value;
  const search = document.getElementById('rekap-search').value.toLowerCase().trim();
  const sort = document.getElementById('rekap-sort').value;
  const groupMode = document.getElementById('rekap-group').value;

  const period = getDateRangeFromPeriod(type, val);
  document.getElementById('doc-period-subtitle').textContent = `Periode: ${period.label} (${period.startIso} s.d. ${period.endIso})`;

  let data = computeTeacherMetricsForRange(period.startIso, period.endIso, period.weeksCount);

  if (search) {
    data = data.filter(d =>
      d.guru.nama.toLowerCase().includes(search) ||
      (d.guru.nip || '').toLowerCase().includes(search)
    );
  }

  data.sort((a, b) => {
    if (sort === 'name_desc') return b.guru.nama.localeCompare(a.guru.nama);
    if (sort === 'hadir_desc') return b.countHadir - a.countHadir;
    if (sort === 'jam_desc') return b.avgWeeklyHours - a.avgWeeklyHours;
    if (sort === 'sakit_desc') return b.countSakit - a.countSakit;
    if (sort === 'izin_desc') return b.countIzin - a.countIzin;
    if (sort === 'dl_desc') return b.countDL - a.countDL;
    return a.guru.nama.localeCompare(b.guru.nama);
  });

  APP_STATE.lastRekapExportData = { period, rows: data };

  const container = document.getElementById('rekap-table-container');
  if (data.length === 0) {
    container.innerHTML = '<p style="text-align:center;padding:16px;">Tidak ada data guru untuk ditampilkan.</p>';
    return;
  }

  let tbodyHtml = '';
  if (groupMode === 'none') {
    tbodyHtml = data.map((d, idx) => renderRekapRow(d, idx + 1)).join('');
  } else {
    const groups = {};
    data.forEach(d => {
      const key = groupMode === 'badge'
        ? d.badge.label
        : (d.totalPresent > 0 ? 'Guru Aktif Hadir / Dinas Luar' : 'Belum Ada Kehadiran Tercatat');
      if (!groups[key]) groups[key] = [];
      groups[key].push(d);
    });
    let counter = 1;
    Object.keys(groups).forEach(gName => {
      tbodyHtml += `<tr class="rekap-group-row"><td colspan="8">${escapeHtml(gName)} (${groups[gName].length} Guru)</td></tr>`;
      groups[gName].forEach(d => {
        tbodyHtml += renderRekapRow(d, counter++);
      });
    });
  }

  container.innerHTML = `
    <table class="rekap-data-table">
      <thead>
        <tr>
          <th style="width:36px;">No</th>
          <th>Nama Guru & NIP</th>
          <th style="width:58px;">Hadir</th>
          <th style="width:58px;">Sakit</th>
          <th style="width:58px;">Izin</th>
          <th style="width:68px;">Dinas Luar</th>
          <th style="width:105px;">Rata-rata Jam / Pekan</th>
          <th style="width:115px;">Predikat</th>
        </tr>
      </thead>
      <tbody>${tbodyHtml}</tbody>
    </table>
  `;
}

function renderRekapRow(d, no) {
  return `
    <tr>
      <td style="text-align:center;">${no}</td>
      <td>
        <strong>${escapeHtml(d.guru.nama)}</strong><br>
        <span style="font-size:11px;">NIP. ${escapeHtml(d.guru.nip || '-')}</span>
      </td>
      <td style="text-align:center;">${d.countHadir}</td>
      <td style="text-align:center;">${d.countSakit}</td>
      <td style="text-align:center;">${d.countIzin}</td>
      <td style="text-align:center;">${d.countDL}</td>
      <td style="text-align:center;">${d.avgWeeklyHours} jam</td>
      <td style="text-align:center;">${d.badge.label}</td>
    </tr>
  `;
}

// Konversi gambar logo ke DataURL bersih untuk PDF & DOCX
async function imageUrlToDataUrl(url) {
  if (!url) return null;
  if (url.startsWith('data:')) return url;
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth || 120;
      c.height = img.naturalHeight || 120;
      c.getContext('2d').drawImage(img, 0, 0);
      try {
        resolve(c.toDataURL('image/png'));
      } catch (e) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function downloadRekapPDF() {
  SoundFX.tap();
  showToast('Menyiapkan dokumen PDF ukuran A4...', 'success');
  const element = document.getElementById('printable-rekap-a4');
  const opt = {
    margin: [12, 12, 12, 12],
    filename: `Rekap_Kehadiran_Guru_SMPN1_Mekarjaya_${getLocalISODate(new Date())}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
  };
  html2pdf().set(opt).from(element).save();
}

async function downloadRekapDOCX() {
  SoundFX.tap();
  if (!window.docx) {
    showToast('Library DOCX sedang dimuat, silakan coba beberapa detik lagi.', 'warning');
    return;
  }
  showToast('Menyusun file Microsoft Word (.docx) ukuran A4...', 'success');

  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, ImageRun } = window.docx;
  const exportData = APP_STATE.lastRekapExportData || { period: { label: 'Semua Periode' }, rows: [] };

  const kabDataUrl = await imageUrlToDataUrl(APP_STATE.config.logo_kabupaten);
  const sekDataUrl = await imageUrlToDataUrl(APP_STATE.config.logo_sekolah);

  const dataUrlToUint8Array = (dUrl) => {
    if (!dUrl) return null;
    const base64 = dUrl.split(',')[1];
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };

  const kabBytes = dataUrlToUint8Array(kabDataUrl);
  const sekBytes = dataUrlToUint8Array(sekDataUrl);

  const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

  // Kop Surat Resmi
  const kopTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: 15, type: WidthType.PERCENTAGE },
            borders: noBorders,
            children: kabBytes ? [new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new ImageRun({ data: kabBytes, transformation: { width: 58, height: 64 } })]
            })] : [new Paragraph('')]
          }),
          new TableCell({
            width: { size: 70, type: WidthType.PERCENTAGE },
            borders: { top: noBorder, left: noBorder, right: noBorder, bottom: { style: BorderStyle.DOUBLE, size: 12, color: '000000' } },
            children: [
              new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'PEMERINTAH KABUPATEN PANDEGLANG', bold: true, size: 22 })] }),
              new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'DINAS PENDIDIKAN, KEPEMUDAAN DAN OLAHRAGA', bold: true, size: 20 })] }),
              new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'SMP N 1 MEKARJAYA', bold: true, size: 30 })] }),
              new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 }, children: [new TextRun({ text: 'Jln.Cibiuk KM.01 Desa Medong, Kec.Mekarjaya – Kab. Pandeglang ( 42252 )', italics: true, size: 18 })] })
            ]
          }),
          new TableCell({
            width: { size: 15, type: WidthType.PERCENTAGE },
            borders: noBorders,
            children: sekBytes ? [new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new ImageRun({ data: sekBytes, transformation: { width: 58, height: 64 } })]
            })] : [new Paragraph('')]
          })
        ]
      })
    ]
  });

  // Tabel Data Rekap
  const headerCells = ['No', 'Nama Guru & NIP', 'Hadir', 'Sakit', 'Izin', 'Dinas Luar', 'Rata-rata Jam/Pekan'].map(txt =>
    new TableCell({
      shading: { fill: 'E2E8F0' },
      children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: txt, bold: true, size: 19 })] })]
    })
  );

  const dataRows = exportData.rows.map((d, i) => new TableRow({
    children: [
      new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(i + 1), size: 18 })] })] }),
      new TableCell({
        children: [
          new Paragraph({ children: [new TextRun({ text: d.guru.nama, bold: true, size: 19 })] }),
          new Paragraph({ children: [new TextRun({ text: `NIP. ${d.guru.nip || '-'}`, size: 16 })] })
        ]
      }),
      new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(d.countHadir), size: 18 })] })] }),
      new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(d.countSakit), size: 18 })] })] }),
      new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(d.countIzin), size: 18 })] })] }),
      new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(d.countDL), size: 18 })] })] }),
      new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${d.avgWeeklyHours} jam`, size: 18 })] })] })
    ]
  }));

  const dataTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: headerCells }), ...dataRows]
  });

  // Blok Tanda Tangan Resmi
  const tglSurat = `Mekarjaya, ${String(new Date().getDate()).padStart(2, '0')} ${BULAN_ID[new Date().getMonth()]} ${new Date().getFullYear()}`;
  const ttdTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: 50, type: WidthType.PERCENTAGE },
            borders: noBorders,
            children: [
              new Paragraph({ children: [new TextRun({ text: 'Mengetahui,', size: 20 })] }),
              new Paragraph({ spacing: { after: 700 }, children: [new TextRun({ text: 'Kepala SMP N 1 Mekarjaya', size: 20 })] }),
              new Paragraph({ children: [new TextRun({ text: 'R. Dudi Romdiansah, M.Pd', bold: true, underline: {}, size: 20 })] }),
              new Paragraph({ children: [new TextRun({ text: 'NIP. 19701102 199702 1 001', size: 19 })] })
            ]
          }),
          new TableCell({
            width: { size: 50, type: WidthType.PERCENTAGE },
            borders: noBorders,
            children: [
              new Paragraph({ children: [new TextRun({ text: tglSurat, size: 20 })] }),
              new Paragraph({ spacing: { after: 700 }, children: [new TextRun({ text: 'Wakasek Kurikulum', size: 20 })] }),
              new Paragraph({ children: [new TextRun({ text: 'Yana Fakhriyana, S.Pd', bold: true, underline: {}, size: 20 })] }),
              new Paragraph({ children: [new TextRun({ text: 'NIP. 19760904 200801 1 007', size: 19 })] })
            ]
          })
        ]
      })
    ]
  });

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 } // Ukuran A4 dalam twips (210mm x 297mm)
        }
      },
      children: [
        kopTable,
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 240, after: 60 },
          children: [new TextRun({ text: 'REKAP KEHADIRAN GURU', bold: true, underline: {}, size: 24 })]
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [new TextRun({ text: `Periode: ${exportData.period.label}`, size: 20 })]
        }),
        dataTable,
        new Paragraph({ spacing: { before: 320 }, children: [] }),
        ttdTable
      ]
    }]
  });

  const blob = await Packer.toBlob(doc);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Rekap_Kehadiran_Guru_SMPN1_Mekarjaya_${getLocalISODate(new Date())}.docx`;
  a.click();
}

/* ==========================================================================
   10. MENU 5: STATISTIK, LEADERBOARD PEKAN LALU & ANALISIS INDIVIDU
========================================================================== */
function updateStatSubcategoryOptions() {
  const cat = document.getElementById('stat-category').value;
  const subEl = document.getElementById('stat-subcategory');
  const map = {
    durasi: [
      { value: 'terlama', label: 'Durasi Jam Kerja Terlama' },
      { value: 'tersingkat', label: 'Durasi Jam Kerja Tersingkat' }
    ],
    kedatangan: [
      { value: 'awal', label: 'Waktu Kedatangan Awal (Sebelum 07:40)' },
      { value: 'terlambat', label: 'Frekuensi Datang Terlambat (> 07:40)' },
      { value: 'waktu_terlambat', label: 'Rata-rata Waktu Keterlambatan' }
    ],
    kepulangan: [
      { value: 'awal', label: 'Waktu Kepulangan Awal (Sebelum Jam Pulang)' },
      { value: 'akhir', label: 'Waktu Kepulangan Akhir (Setelah Jam Pulang)' }
    ],
    kehadiran: [
      { value: 'sering', label: 'Sering Hadir (Hadir + Dinas Luar)' },
      { value: 'jarang', label: 'Jarang Hadir (Izin + Sakit)' }
    ]
  };
  subEl.innerHTML = (map[cat] || []).map(o => `<option value="${o.value}">${o.label}</option>`).join('');
}

function renderLeaderboardLastWeek() {
  const thisMon = getMondayOfDate(new Date());
  const lastMon = new Date(thisMon.getFullYear(), thisMon.getMonth(), thisMon.getDate() - 7);
  const bounds = getWeekBounds(lastMon);

  document.getElementById('leaderboard-week-label').textContent =
    `Data Pekan Sebelumnya: Senin – Minggu (${bounds.label})`;

  const metrics = computeTeacherMetricsForRange(bounds.startIso, bounds.endIso, 1);

  const topDuration = [...metrics].sort((a, b) => b.totalWorkHours - a.totalWorkHours).slice(0, 3);
  const topEarlyIn = [...metrics].sort((a, b) => b.avgEarlyArrivalMins - a.avgEarlyArrivalMins).slice(0, 3);
  const topLateOut = [...metrics].sort((a, b) => b.avgLateLeaveMins - a.avgLateLeaveMins).slice(0, 3);
  const topDiligent = [...metrics].sort((a, b) => b.totalPresent - a.totalPresent || b.totalWorkHours - a.totalWorkHours).slice(0, 3);

  const buildBox = (title, list, valFn) => `
    <div class="lb-box">
      <div class="lb-box-title">${title}</div>
      ${list.length ? list.map((item, i) => `
        <div class="lb-row">
          <span><strong class="lb-rank">#${i + 1}</strong> ${escapeHtml(item.guru.nama)}</span>
          <strong>${valFn(item)}</strong>
        </div>
      `).join('') : '<div class="lb-row">Belum ada data pekan lalu</div>'}
    </div>
  `;

  document.getElementById('leaderboard-grid').innerHTML =
    buildBox('⏱️ Durasi Jam Kerja Terlama', topDuration, x => `${x.totalWorkHours} jam`) +
    buildBox('🌅 Waktu Kedatangan Awal', topEarlyIn, x => `${formatMinutesDiff(x.avgEarlyArrivalMins)} lebih awal`) +
    buildBox('🌇 Waktu Kepulangan Akhir', topLateOut, x => `+${formatMinutesDiff(x.avgLateLeaveMins)}`) +
    buildBox('⭐ Guru Paling Rajin', topDiligent, x => `${x.totalPresent} hari`);
}

function renderStatistik() {
  renderLeaderboardLastWeek();

  const pType = document.getElementById('stat-period-type').value;
  const pVal = document.getElementById('stat-period-value').value;
  const cat = document.getElementById('stat-category').value;
  const sub = document.getElementById('stat-subcategory').value;
  const search = document.getElementById('stat-search').value.toLowerCase().trim();

  const period = getDateRangeFromPeriod(pType, pVal);
  let list = computeTeacherMetricsForRange(period.startIso, period.endIso, period.weeksCount);

  if (search) {
    list = list.filter(d =>
      d.guru.nama.toLowerCase().includes(search) ||
      (d.guru.nip || '').toLowerCase().includes(search)
    );
  }

  // Pengurutan sesuai kombinasi kategori & subkategori
  list.sort((a, b) => {
    if (cat === 'durasi') {
      return sub === 'terlama' ? b.avgWeeklyHours - a.avgWeeklyHours : a.avgWeeklyHours - b.avgWeeklyHours;
    }
    if (cat === 'kedatangan') {
      if (sub === 'awal') return b.avgEarlyArrivalMins - a.avgEarlyArrivalMins;
      if (sub === 'terlambat') return b.lateCount - a.lateCount;
      return b.avgLateMins - a.avgLateMins;
    }
    if (cat === 'kepulangan') {
      return sub === 'awal' ? b.avgEarlyLeaveMins - a.avgEarlyLeaveMins : b.avgLateLeaveMins - a.avgLateLeaveMins;
    }
    if (cat === 'kehadiran') {
      return sub === 'sering' ? b.totalPresent - a.totalPresent : b.totalAbsent - a.totalAbsent;
    }
    return 0;
  });

  APP_STATE.lastStatMetrics = { period, list };

  // Catatan Analisis Kelompok Positif & Membangun Otomatis
  const totalGuru = list.length || 1;
  const memenuhiStandar = list.filter(x => x.avgWeeklyHours >= 37.5).length;
  const avgGroupHours = +(list.reduce((acc, x) => acc + x.avgWeeklyHours, 0) / totalGuru).toFixed(1);
  const totalHadirAll = list.reduce((acc, x) => acc + x.countHadir, 0);
  const totalDLAll = list.reduce((acc, x) => acc + x.countDL, 0);

  document.getElementById('stat-group-insight').innerHTML = `
    <h4 style="color:#065f46;margin-bottom:4px;">💡 Analisis & Rekomendasi Kinerja Kelompok (${escapeHtml(period.label)})</h4>
    <p style="font-size:13.5px;color:#0f172a;">
      Secara keseluruhan, rata-rata beban kerja guru mencapai <strong>${avgGroupHours} jam/minggu</strong> dengan
      <strong>${memenuhiStandar} dari ${list.length} guru</strong> telah memenuhi/melampaui standar minimal 37,5 jam/pekan
      (total ${totalHadirAll} kehadiran sekolah & ${totalDLAll} dinas luar).
      ${avgGroupHours >= 37.5
        ? 'Pertahankan ritme kolaborasi dan kedisiplinan yang sangat solid ini untuk terus menjaga mutu layanan pendidikan di SMP N 1 Mekarjaya.'
        : 'Mari terus tingkatkan konsistensi presensi datang dan pulang tepat waktu agar seluruh rekan guru dapat mencapai target ideal 37,5 jam/pekan secara optimal.'}
    </p>
  `;

  renderStatCharts(list);

  const listEl = document.getElementById('stat-teacher-list');
  if (list.length === 0) {
    listEl.innerHTML = '<p style="text-align:center;color:#64748b;">Tidak ada data guru ditemukan.</p>';
    return;
  }

  listEl.innerHTML = list.map((d, idx) => {
    let metricPrimary = `${d.avgWeeklyHours} jam/pekan`;
    let metricSecondary = `Total: ${d.totalWorkHours} jam`;

    if (cat === 'kedatangan') {
      if (sub === 'awal') {
        metricPrimary = `${formatMinutesDiff(d.avgEarlyArrivalMins)} lebih awal`;
        metricSecondary = 'Rata-rata sebelum 07:40';
      } else if (sub === 'terlambat') {
        metricPrimary = `${d.lateCount}x terlambat`;
        metricSecondary = `Rata-rata: ${formatMinutesDiff(d.avgLateMins)}`;
      } else {
        metricPrimary = `${formatMinutesDiff(d.avgLateMins)}`;
        metricSecondary = `${d.lateCount}x terlambat (>07:40)`;
      }
    } else if (cat === 'kepulangan') {
      if (sub === 'awal') {
        metricPrimary = `${formatMinutesDiff(d.avgEarlyLeaveMins)} lebih awal`;
        metricSecondary = 'Rata-rata sebelum jam pulang';
      } else {
        metricPrimary = `+${formatMinutesDiff(d.avgLateLeaveMins)}`;
        metricSecondary = 'Rata-rata setelah jam pulang';
      }
    } else if (cat === 'kehadiran') {
      if (sub === 'sering') {
        metricPrimary = `${d.totalPresent} hari hadir`;
        metricSecondary = `Hadir: ${d.countHadir} | DL: ${d.countDL}`;
      } else {
        metricPrimary = `${d.totalAbsent} hari tidak hadir`;
        metricSecondary = `Sakit: ${d.countSakit} | Izin: ${d.countIzin}`;
      }
    }

    return `
      <div class="stat-teacher-item" onclick="openTeacherDetailModal('${d.guru.id}')">
        <div class="stat-rank-num">${idx + 1}</div>
        <div class="stat-teacher-main">
          <div class="stat-teacher-name">${escapeHtml(d.guru.nama)}</div>
          <div class="stat-teacher-nip">NIP. ${escapeHtml(d.guru.nip || '-')}</div>
          <span class="perf-badge ${d.badge.cls}">${d.badge.label}</span>
        </div>
        <div class="stat-metric-box">
          <div class="stat-metric-val">${metricPrimary}</div>
          <div class="stat-metric-sub">${metricSecondary}</div>
        </div>
      </div>
    `;
  }).join('');
}

function renderStatCharts(list) {
  const top10 = list.slice(0, 10);
  const labels = top10.map(x => x.guru.nama.split(',')[0]);
  const hoursData = top10.map(x => x.avgWeeklyHours);

  if (APP_STATE.charts.workHours) APP_STATE.charts.workHours.destroy();
  const ctxBar = document.getElementById('chart-work-hours').getContext('2d');
  APP_STATE.charts.workHours = new Chart(ctxBar, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Jam Kerja / Pekan',
          data: hoursData,
          backgroundColor: hoursData.map(h => h >= 37.5 ? '#0f3d3e' : '#d97706'),
          borderRadius: 6
        },
        {
          label: 'Target Minimal (37,5 Jam)',
          data: labels.map(() => 37.5),
          type: 'line',
          borderColor: '#dc2626',
          borderDash: [5, 5],
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } }
    }
  });

  const sumH = list.reduce((a, b) => a + b.countHadir, 0);
  const sumDL = list.reduce((a, b) => a + b.countDL, 0);
  const sumI = list.reduce((a, b) => a + b.countIzin, 0);
  const sumS = list.reduce((a, b) => a + b.countSakit, 0);

  if (APP_STATE.charts.pie) APP_STATE.charts.pie.destroy();
  const ctxPie = document.getElementById('chart-attendance-pie').getContext('2d');
  APP_STATE.charts.pie = new Chart(ctxPie, {
    type: 'doughnut',
    data: {
      labels: ['Hadir', 'Dinas Luar', 'Izin', 'Sakit'],
      datasets: [{
        data: [sumH, sumDL, sumI, sumS],
        backgroundColor: ['#059669', '#0284c7', '#d97706', '#dc2626']
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } }
    }
  });
}

function openTeacherDetailModal(guruId) {
  const { period, list } = APP_STATE.lastStatMetrics || { period: { label: '' }, list: [] };
  const d = list.find(x => x.guru.id === guruId);
  if (!d) return;

  SoundFX.tap();

  // Narasi individu yang positif & membangun
  let personalAdvice = '';
  if (d.avgWeeklyHours > 40) {
    personalAdvice = `Luar biasa! Dedikasi waktu kerja Anda (${d.avgWeeklyHours} jam/pekan) melampaui standar minimal 37,5 jam. Komitmen tinggi Anda menjadi teladan positif bagi lingkungan sekolah.`;
  } else if (d.avgWeeklyHours >= 37.5) {
    personalAdvice = `Kinerja sangat terjaga! Anda telah memenuhi standar beban kerja minimal 37,5 jam/pekan dengan baik. Terus pertahankan konsistensi kehadiran Anda.`;
  } else if (d.avgWeeklyHours >= 35) {
    personalAdvice = `Capaian Anda sudah mendekati target minimal 37,5 jam/pekan (kurang ${(37.5 - d.avgWeeklyHours).toFixed(1)} jam). Sedikit optimalisasi waktu datang dan pulang akan membawa kinerja Anda ke predikat Baik.`;
  } else {
    personalAdvice = `Total jam kerja tercatat ${d.avgWeeklyHours} jam/pekan dari standar 37,5 jam. Pastikan selalu melakukan presensi datang dan pulang tepat waktu agar seluruh aktivitas kerja tercatat optimal.`;
  }

  document.getElementById('modal-teacher-body').innerHTML = `
    <h3 style="text-align:left;margin-bottom:2px;">${escapeHtml(d.guru.nama)}</h3>
    <p style="text-align:left;margin-bottom:10px;">NIP. ${escapeHtml(d.guru.nip || '-')} • <strong>${escapeHtml(period.label)}</strong></p>
    <div style="margin-bottom:12px;">
      <span class="perf-badge ${d.badge.cls}" style="font-size:12px;padding:4px 12px;">${d.badge.label} (${d.avgWeeklyHours} jam/pekan)</span>
    </div>

    <div style="background:#f0fdf4;border-left:4px solid #059669;padding:10px 12px;border-radius:10px;font-size:13px;margin-bottom:14px;">
      ${personalAdvice}
    </div>

    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;font-size:12.5px;margin-bottom:14px;">
      <div style="background:#f8fafc;padding:8px 10px;border-radius:10px;"><strong>Total Jam Kerja:</strong><br>${d.totalWorkHours} jam</div>
      <div style="background:#f8fafc;padding:8px 10px;border-radius:10px;"><strong>Hadir / Dinas Luar:</strong><br>${d.countHadir} hadir, ${d.countDL} DL</div>
      <div style="background:#f8fafc;padding:8px 10px;border-radius:10px;"><strong>Rata-rata Datang Awal:</strong><br>${formatMinutesDiff(d.avgEarlyArrivalMins)} (< 07:40)</div>
      <div style="background:#f8fafc;padding:8px 10px;border-radius:10px;"><strong>Keterlambatan:</strong><br>${d.lateCount}x (rata-rata ${formatMinutesDiff(d.avgLateMins)})</div>
    </div>

    <h4 style="font-size:13px;margin-bottom:6px;">Rincian Log Harian Periode Ini:</h4>
    <div style="max-height:200px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:10px;">
      <table class="rekap-data-table" style="font-size:11.5px;">
        <thead><tr><th>Tanggal</th><th>Status</th><th>Durasi</th><th>Catatan Sistem</th></tr></thead>
        <tbody>
          ${d.dailyLogs.length ? d.dailyLogs.map(l => `
            <tr>
              <td>${l.hari}, ${l.dateIso}</td>
              <td>${escapeHtml(l.status)}</td>
              <td>${l.hours} jam</td>
              <td>${escapeHtml(l.notes || '-')}</td>
            </tr>
          `).join('') : '<tr><td colspan="4" style="text-align:center;">Belum ada catatan harian</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
  document.getElementById('modal-teacher-detail').classList.remove('hidden');
}

/* ==========================================================================
   11. MENU 1: ADMINISTRATOR (AUTO-LOCK SAAT PINDAH MENU & PENGATURAN GLOBAL)
========================================================================== */
function renderAdminPanel() {
  const lockScreen = document.getElementById('admin-lock-screen');
  const panel = document.getElementById('admin-panel-content');

  if (!APP_STATE.isAdminUnlocked) {
    lockScreen.classList.remove('hidden');
    panel.classList.add('hidden');
    document.getElementById('input-admin-code').value = '';
    return;
  }

  lockScreen.classList.add('hidden');
  panel.classList.remove('hidden');

  const c = APP_STATE.config;
  document.getElementById('admin-webapp-url').value = c.webapp_url || '';
  document.getElementById('admin-center-coords').value = c.center_formatted || '';
  document.getElementById('admin-app-title').value = c.app_title || 'PRESENSI GURU';
  document.getElementById('admin-app-subtitle').value = c.app_subtitle || 'SMP N 1 Mekarjaya';
  document.getElementById('admin-splash-title').value = c.splash_title || 'PRESENSI GURU';
  document.getElementById('admin-splash-subtitle').value = c.splash_subtitle || 'SMP N 1 Mekarjaya';
  document.getElementById('admin-new-setup-code').value = c.setup_access_code || 'diwantara01';
  document.getElementById('admin-new-admin-code').value = c.admin_access_code || 'diwantara02';

  updateAdminLocationLockUI();
  renderAdminGuruList();
}

function updateAdminLocationLockUI() {
  const locked = !!APP_STATE.config.center_locked;
  const badge = document.getElementById('admin-loc-lock-badge');
  const input = document.getElementById('admin-center-coords');
  const btnGps = document.getElementById('btn-capture-center-gps');
  const btnSave = document.getElementById('btn-save-center-loc');
  const btnToggle = document.getElementById('btn-toggle-lock-loc');

  if (locked) {
    badge.textContent = '🔒 Terkunci Permanen';
    input.readOnly = true;
    btnGps.disabled = true;
    btnSave.disabled = true;
    btnToggle.textContent = 'Buka Kunci Lokasi';
  } else {
    badge.textContent = '🔓 Mode Edit Terbuka';
    input.readOnly = false;
    btnGps.disabled = false;
    btnSave.disabled = false;
    btnToggle.textContent = 'Batalkan Edit';
  }
}

function renderAdminGuruList() {
  const q = document.getElementById('admin-search-guru').value.toLowerCase().trim();
  const list = APP_STATE.guruList.filter(g =>
    g.nama.toLowerCase().includes(q) || (g.nip || '').toLowerCase().includes(q)
  );
  const el = document.getElementById('admin-guru-list');
  el.innerHTML = list.map(g => `
    <div class="guru-item-row">
      <div>
        <div class="guru-primary-name">${escapeHtml(g.nama)}</div>
        <div class="guru-secondary-nip">NIP. ${escapeHtml(g.nip || '-')}</div>
      </div>
      <div class="btn-row">
        <button type="button" class="btn-secondary btn-sm" onclick="editGuru('${g.id}')">Edit</button>
        <button type="button" class="btn-danger-soft btn-sm" onclick="confirmDeleteGuru('${g.id}')">Hapus</button>
      </div>
    </div>
  `).join('');
}

function editGuru(id) {
  const g = APP_STATE.guruList.find(x => x.id === id);
  if (!g) return;
  SoundFX.tap();
  document.getElementById('guru-edit-id').value = g.id;
  document.getElementById('guru-nama-input').value = g.nama;
  document.getElementById('guru-nip-input').value = g.nip || '';
  document.getElementById('btn-save-guru').textContent = 'Simpan Perubahan Guru';
  document.getElementById('btn-cancel-edit-guru').classList.remove('hidden');
}

function confirmDeleteGuru(id) {
  const g = APP_STATE.guruList.find(x => x.id === id);
  if (!g) return;
  SoundFX.error();
  openConfirmModal(
    'Konfirmasi Hapus Data Guru',
    `Apakah Anda yakin ingin menghapus data guru "${g.nama}"? Tindakan ini akan memperbarui daftar guru pada seluruh perangkat.`,
    async () => {
      APP_STATE.guruList = APP_STATE.guruList.filter(x => x.id !== id);
      saveGuruLocal();
      populateGuruDropdown();
      renderAdminGuruList();
      await postToGAS({ action: 'saveGuruList', guru: APP_STATE.guruList });
      showToast('Data guru berhasil dihapus.', 'success');
    }
  );
}

// Resize & kompres logo upload admin agar muat di Google Sheets (< 30 KB)
function handleLogoFileUpload(fileInput, targetKey) {
  const file = fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 220;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL('image/png');
      APP_STATE.config[targetKey] = dataUrl;
      applyBrandingToDOM();
      showToast('Pratinjau logo diperbarui. Klik "Simpan Permanen Judul & Logo" untuk menyinkronkan ke semua perangkat.', 'success');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function promptReset(type) {
  SoundFX.error();
  const labels = {
    presensi: 'menghapus seluruh data presensi dan galeri foto',
    guru: 'menghapus seluruh daftar data guru',
    branding: 'mengembalikan logo dan judul program ke pengaturan awal',
    local: 'membersihkan cache lokal pada perangkat ini',
    all: 'MERESET PROGRAM SECARA KESELURUHAN (seluruh presensi, galeri, data guru, dan pengaturan akan kembali ke kondisi awal)'
  };
  openConfirmModal(
    'Peringatan Konfirmasi Reset',
    `Anda akan ${labels[type]}. Apakah Anda benar-benar yakin ingin melanjutkan?`,
    async () => {
      if (type === 'presensi' || type === 'all') {
        APP_STATE.presensiList = [];
        APP_STATE.offlineQueue = [];
        await LocalDB.clear('presensi');
        await LocalDB.clear('queue');
      }
      if (type === 'guru' || type === 'all') {
        APP_STATE.guruList = [...DEFAULT_GURU];
        saveGuruLocal();
        populateGuruDropdown();
      }
      if (type === 'branding' || type === 'all') {
        const keepUrl = type === 'all' ? '' : APP_STATE.config.webapp_url;
        APP_STATE.config = { ...DEFAULT_CONFIG, webapp_url: keepUrl };
        saveConfigLocal();
        applyBrandingToDOM();
      }
      if (type === 'local' || type === 'all') {
        localStorage.removeItem('smpn1_device_activated');
      }

      if (type !== 'local') {
        await postToGAS({ action: 'reset', resetType: type, config: APP_STATE.config, guru: APP_STATE.guruList });
      }

      renderAdminPanel();
      updateSyncUI();
      showToast('Proses reset berhasil dijalankan.', 'success');
      if (type === 'all' || type === 'local') {
        setTimeout(() => window.location.reload(), 1000);
      }
    }
  );
}

/* ==========================================================================
   12. EVENT BINDINGS & MODAL HELPERS
========================================================================== */
function bindAllEvents() {
  // First-time setup button "Masuk Disini"
  document.getElementById('btn-setup-enter').addEventListener('click', () => {
    const code = document.getElementById('input-setup-code').value.trim();
    const serverUrl = document.getElementById('input-setup-server').value.trim();
    const errEl = document.getElementById('setup-error');

    if (code !== APP_STATE.config.setup_access_code) {
      SoundFX.error();
      errEl.textContent = 'Kode akses salah! Silakan periksa kembali kode masuk program.';
      errEl.classList.remove('hidden');
      return;
    }

    SoundFX.unlock();
    errEl.classList.add('hidden');
    if (serverUrl) {
      APP_STATE.config.webapp_url = serverUrl;
      saveConfigLocal();
    }
    localStorage.setItem('smpn1_device_activated', 'true');
    requestAppFullscreen();
    document.getElementById('screen-setup').classList.add('hidden');
    runSplashAndBoot();
  });

  // Tombol Header
  document.getElementById('btn-sync-now').addEventListener('click', () => {
    SoundFX.tap();
    syncWithServer(false);
  });
  document.getElementById('btn-fullscreen').addEventListener('click', () => {
    SoundFX.tap();
    if (!document.fullscreenElement) requestAppFullscreen();
    else if (document.exitFullscreen) document.exitFullscreen();
  });

  // Navigasi Bawah 5 Menu (Otomatis mengunci menu Admin saat berpindah menu!)
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;
      SoundFX.tap();

      // Auto-close & lock Admin jika berpindah ke menu selain Admin
      if (targetTab !== 'tab-admin' && APP_STATE.isAdminUnlocked) {
        APP_STATE.isAdminUnlocked = false;
      }

      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById(targetTab).classList.add('active');

      if (targetTab === 'tab-admin') renderAdminPanel();
      if (targetTab === 'tab-galeri') renderGaleri();
      if (targetTab === 'tab-rekap') renderRekap();
      if (targetTab === 'tab-statistik') renderStatistik();
    });
  });

  // Kontrol Kamera & GPS di Menu Presensi
  document.getElementById('btn-refresh-gps').addEventListener('click', () => {
    SoundFX.tap();
    initGeolocation();
    showToast('Memperbarui titik koordinat GPS...', 'success');
  });
  document.getElementById('btn-capture-photo').addEventListener('click', captureLivePhoto4x3);
  document.getElementById('btn-retake-photo').addEventListener('click', retakeLivePhoto);

  // Radio Kategori Presensi
  document.querySelectorAll('input[name="kategori_presensi"]').forEach(radio => {
    radio.addEventListener('change', () => {
      SoundFX.tap();
      hideAllPresensiSubboxes();
      const val = radio.value;
      if (val === 'Hadir') document.getElementById('box-hadir').classList.remove('hidden');
      if (val === 'Sakit') document.getElementById('box-sakit').classList.remove('hidden');
      if (val === 'Izin') document.getElementById('box-izin').classList.remove('hidden');
      if (val === 'Dinas Luar') document.getElementById('box-dinas-luar').classList.remove('hidden');
    });
  });

  // Sub-radio Dinas Luar (Datang / Pulang)
  document.querySelectorAll('input[name="sub_dl"]').forEach(radio => {
    radio.addEventListener('change', () => {
      SoundFX.tap();
      document.getElementById('box-dl-datang').classList.toggle('hidden', radio.value !== 'Datang');
      document.getElementById('box-dl-pulang').classList.toggle('hidden', radio.value !== 'Pulang');
    });
  });

  // Word counter real-time untuk Dinas Luar Pulang (minimal 30 kata)
  document.getElementById('dl-catatan-pulang').addEventListener('input', (e) => {
    const words = countWords(e.target.value);
    const counter = document.getElementById('dl-word-counter');
    counter.textContent = `${words} / 30 kata minimal`;
    counter.className = words >= 30 ? 'word-counter valid' : 'word-counter invalid';
  });

  document.getElementById('form-presensi').addEventListener('submit', handlePresensiSubmit);

  // Filter Galeri
  ['galeri-search', 'galeri-filter-kategori', 'galeri-sort', 'galeri-filter-date'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      APP_STATE.galeriPage = 1;
      renderGaleri();
    });
  });

  // Filter & Export Rekap
  document.getElementById('rekap-period-type').addEventListener('change', () => {
    updatePeriodDropdown('rekap');
    renderRekap();
  });
  ['rekap-period-value', 'rekap-search', 'rekap-sort', 'rekap-group'].forEach(id => {
    document.getElementById(id).addEventListener('input', renderRekap);
  });
  document.getElementById('btn-print-rekap').addEventListener('click', () => {
    SoundFX.tap();
    window.print();
  });
  document.getElementById('btn-pdf-rekap').addEventListener('click', downloadRekapPDF);
  document.getElementById('btn-docx-rekap').addEventListener('click', downloadRekapDOCX);

  // Filter Statistik
  document.getElementById('stat-period-type').addEventListener('change', () => {
    updatePeriodDropdown('stat');
    renderStatistik();
  });
  document.getElementById('stat-category').addEventListener('change', () => {
    updateStatSubcategoryOptions();
    renderStatistik();
  });
  ['stat-period-value', 'stat-subcategory', 'stat-search'].forEach(id => {
    document.getElementById(id).addEventListener('input', renderStatistik);
  });

  // Admin Login & Controls
  document.getElementById('btn-unlock-admin').addEventListener('click', () => {
    const input = document.getElementById('input-admin-code').value.trim();
    const err = document.getElementById('admin-lock-error');
    if (input !== APP_STATE.config.admin_access_code) {
      SoundFX.error();
      err.textContent = 'Kode akses Admin tidak valid!';
      err.classList.remove('hidden');
      return;
    }
    SoundFX.unlock();
    err.classList.add('hidden');
    APP_STATE.isAdminUnlocked = true;
    renderAdminPanel();
  });

  document.getElementById('btn-lock-admin-now').addEventListener('click', () => {
    SoundFX.tap();
    APP_STATE.isAdminUnlocked = false;
    renderAdminPanel();
  });

  document.getElementById('btn-save-server').addEventListener('click', async () => {
    const url = document.getElementById('admin-webapp-url').value.trim();
    if (!url.startsWith('http')) {
      showToast('Masukkan URL Google Apps Script Web App yang valid!', 'error');
      return;
    }
    APP_STATE.config.webapp_url = url;
    saveConfigLocal();
    await postToGAS({ action: 'saveConfig', config: APP_STATE.config });
    await syncWithServer(false);
  });

  document.getElementById('btn-test-server').addEventListener('click', () => syncWithServer(false));

  document.getElementById('btn-toggle-lock-loc').addEventListener('click', () => {
    APP_STATE.config.center_locked = !APP_STATE.config.center_locked;
    updateAdminLocationLockUI();
  });

  document.getElementById('btn-capture-center-gps').addEventListener('click', () => {
    if (!APP_STATE.currentCoords) {
      showToast('GPS perangkat belum siap.', 'warning');
      return;
    }
    document.getElementById('admin-center-coords').value = APP_STATE.currentCoords.formatted;
    showToast('Titik koordinat saat ini diambil. Klik Simpan & Kunci Lokasi.', 'success');
  });

  document.getElementById('btn-save-center-loc').addEventListener('click', async () => {
    const raw = document.getElementById('admin-center-coords').value.trim();
    const parts = raw.split(',').map(s => parseFloat(s.trim()));
    if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) {
      showToast('Format koordinat tidak valid. Gunakan format: -6.391234, 105.981234', 'error');
      return;
    }
    APP_STATE.config.center_lat = Number(parts[0].toFixed(6));
    APP_STATE.config.center_lng = Number(parts[1].toFixed(6));
    APP_STATE.config.center_formatted = formatCoordsStandard(APP_STATE.config.center_lat, APP_STATE.config.center_lng);
    APP_STATE.config.center_locked = true;
    saveConfigLocal();
    updateAdminLocationLockUI();
    initGeolocation();
    await postToGAS({ action: 'saveConfig', config: APP_STATE.config });
    SoundFX.success();
    showToast('Lokasi pusat sekolah berhasil disimpan dan dikunci permanen!', 'success');
  });

  document.getElementById('upload-logo-sekolah').addEventListener('change', e => handleLogoFileUpload(e.target, 'logo_sekolah'));
  document.getElementById('upload-logo-kab').addEventListener('change', e => handleLogoFileUpload(e.target, 'logo_kabupaten'));

  document.getElementById('btn-save-branding').addEventListener('click', async () => {
    APP_STATE.config.app_title = document.getElementById('admin-app-title').value.trim() || 'PRESENSI GURU';
    APP_STATE.config.app_subtitle = document.getElementById('admin-app-subtitle').value.trim() || 'SMP N 1 Mekarjaya';
    APP_STATE.config.splash_title = document.getElementById('admin-splash-title').value.trim() || 'PRESENSI GURU';
    APP_STATE.config.splash_subtitle = document.getElementById('admin-splash-subtitle').value.trim() || 'SMP N 1 Mekarjaya';
    saveConfigLocal();
    applyBrandingToDOM();
    await postToGAS({ action: 'saveConfig', config: APP_STATE.config });
    SoundFX.success();
    showToast('Judul dan logo instansi disimpan permanen untuk seluruh perangkat!', 'success');
  });

  document.getElementById('btn-save-access-codes').addEventListener('click', async () => {
    const newSetup = document.getElementById('admin-new-setup-code').value.trim();
    const newAdmin = document.getElementById('admin-new-admin-code').value.trim();
    if (!newSetup || !newAdmin) {
      showToast('Kedua kode akses tidak boleh kosong.', 'error');
      return;
    }
    if (newSetup === newAdmin) {
      SoundFX.error();
      showToast('Kode masuk program harus berbeda dengan kode menu Admin!', 'error');
      return;
    }
    APP_STATE.config.setup_access_code = newSetup;
    APP_STATE.config.admin_access_code = newAdmin;
    saveConfigLocal();
    await postToGAS({ action: 'saveConfig', config: APP_STATE.config });
    SoundFX.success();
    showToast('Kode akses keamanan berhasil diperbarui!', 'success');
  });

  // Tambah / Edit Guru
  document.getElementById('btn-save-guru').addEventListener('click', async () => {
    const nama = document.getElementById('guru-nama-input').value.trim();
    const nip = document.getElementById('guru-nip-input').value.trim();
    const editId = document.getElementById('guru-edit-id').value;

    if (!nama) {
      showToast('Nama lengkap guru wajib diisi!', 'error');
      return;
    }

    if (editId) {
      const idx = APP_STATE.guruList.findIndex(g => g.id === editId);
      if (idx !== -1) APP_STATE.guruList[idx] = { id: editId, nama, nip };
    } else {
      APP_STATE.guruList.push({ id: `G-${Date.now()}`, nama, nip });
    }

    document.getElementById('guru-edit-id').value = '';
    document.getElementById('guru-nama-input').value = '';
    document.getElementById('guru-nip-input').value = '';
    document.getElementById('btn-save-guru').textContent = 'Tambah Guru';
    document.getElementById('btn-cancel-edit-guru').classList.add('hidden');

    saveGuruLocal();
    populateGuruDropdown();
    renderAdminGuruList();
    await postToGAS({ action: 'saveGuruList', guru: APP_STATE.guruList });
    SoundFX.success();
    showToast('Daftar data guru berhasil diperbarui & tersinkron!', 'success');
  });

  document.getElementById('btn-cancel-edit-guru').addEventListener('click', () => {
    document.getElementById('guru-edit-id').value = '';
    document.getElementById('guru-nama-input').value = '';
    document.getElementById('guru-nip-input').value = '';
    document.getElementById('btn-save-guru').textContent = 'Tambah Guru';
    document.getElementById('btn-cancel-edit-guru').classList.add('hidden');
  });

  document.getElementById('admin-search-guru').addEventListener('input', renderAdminGuruList);
}

function refreshActiveTabViews() {
  const active = document.querySelector('.tab-panel.active');
  if (!active) return;
  if (active.id === 'tab-galeri') renderGaleri();
  if (active.id === 'tab-rekap') renderRekap();
  if (active.id === 'tab-statistik') renderStatistik();
}

function togglePassVisibility(inputId) {
  const el = document.getElementById(inputId);
  el.type = el.type === 'password' ? 'text' : 'password';
}

function openConfirmModal(title, message, onConfirm) {
  document.getElementById('modal-confirm-title').textContent = title;
  document.getElementById('modal-confirm-message').textContent = message;
  const modal = document.getElementById('modal-confirm');
  modal.classList.remove('hidden');

  const okBtn = document.getElementById('btn-confirm-ok');
  const cancelBtn = document.getElementById('btn-confirm-cancel');

  const cleanup = () => modal.classList.add('hidden');
  cancelBtn.onclick = cleanup;
  okBtn.onclick = async () => {
    cleanup();
    await onConfirm();
  };
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 3600);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}