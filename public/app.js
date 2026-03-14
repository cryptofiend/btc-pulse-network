/* ============================================================
   BTC Pulse Network — 3D Time-series transaction visualization
   Three.js + OrbitControls + UnrealBloomPass
   ============================================================ */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';

(function () {
  'use strict';

  /* =========== CONSTANTS =========== */
  const NODE_BASE_SIZE = 0.25;
  const NODE_MAX_SIZE = 1.5;
  const PULSE_DURATION_BASE = 2500;
  let SIM_HOUR_DURATION = 3000; // ms per sim-hour, recalculated dynamically in initTimeline
  const TARGET_PLAYBACK_SECS = 180; // full playback at 1x should take ~3 minutes
  const WIRE_FADE_SEC = 86400;  // 1 day in seconds — wire fully fades after this
  const WIRE_BASE_WIDTH = 0.5;   // px width for 1st transaction
  const WIRE_WIDTH_PER_TX = 0.4; // additional px per subsequent transaction
  const WIRE_MAX_WIDTH = 6;      // cap
  const WIRE_BRIGHT_OPACITY = 0.55; // opacity at moment of transaction
  const LAYOUT_SPREAD = 40;  // world-unit spread for 3D layout
  const CYAN = new THREE.Color(0x00d4ff);
  const ORANGE = new THREE.Color(0xff6b35);
  const DIM_CYAN = new THREE.Color(0x104858);
  const WIRE_COLOR = new THREE.Color(0x008cb4);
  const WIRE_GLOW = new THREE.Color(0x00d4ff);

  /* =========== STATE =========== */
  let allTransactions = [];
  let filteredTxns = [];
  let nodes = new Map();
  let edges = [];
  let activePulses = [];
  let activatedEdges = new Set();
  let recentEdges = new Map();
  // Per-edge persistent state: { txCount, lastTxTime }
  let edgeState = new Map();
  let simulationTime = 0, timeStart = 0, timeEnd = 0;
  let isPlaying = false, playbackSpeed = 1, lastFrameTime = 0;
  let filterMinBtc = 1, filterMinWallet = 0;

  /* =========== AUDIO — Laser "pew pew" =========== */
  let audioCtx = null;
  let audioEnabled = true;
  const MAX_CONCURRENT_SOUNDS = 8;
  let activeSoundCount = 0;

  function ensureAudioCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  /**
   * Synthesized laser "pew" sound.
   * @param {number} amountBtc – transaction size in BTC (governs volume/intensity)
   * @param {number} confNorm – 0.1-1, higher = slower confirmation (governs pitch: faster tx → higher pitch)
   */
  function playLaserSound(amountBtc, confNorm) {
    if (!audioEnabled) return;
    if (activeSoundCount >= MAX_CONCURRENT_SOUNDS) return;
    const ctx = ensureAudioCtx();
    if (!ctx) return;

    activeSoundCount++;

    // --- Volume from transaction size ---
    // amountBtc ranges ~1-20000. Use log scale, map to 0.05-0.6 gain.
    const amountLog = Math.log10(Math.max(amountBtc, 1));  // 0 - ~4.3
    const volume = Math.min(0.6, 0.05 + (amountLog / 4.3) * 0.55);

    // --- Pitch from confirmation speed ---
    // confNorm: 0.1 (fastest) → 1 (slowest)
    // Faster tx = lower confNorm = higher starting frequency
    const freqStart = 1800 - confNorm * 1200;   // 600-1800 Hz (fast→high, slow→low)
    const freqEnd = 80 + (1 - confNorm) * 60;    // sweep down to 80-140 Hz

    // Duration: slightly shorter for faster txns (snappier)
    const duration = 0.12 + confNorm * 0.18;  // 0.12-0.30s

    const now = ctx.currentTime;

    // --- Oscillator 1: main sweep (sawtooth for that buzzy laser feel) ---
    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(freqStart, now);
    osc1.frequency.exponentialRampToValueAtTime(freqEnd, now + duration);

    // --- Oscillator 2: higher harmonic for brightness ---
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.setValueAtTime(freqStart * 1.5, now);
    osc2.frequency.exponentialRampToValueAtTime(freqEnd * 1.5, now + duration * 0.7);

    // --- Gain envelope ---
    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(volume, now);
    gainNode.gain.setValueAtTime(volume * 0.9, now + duration * 0.1);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + duration);

    // Secondary gain for the harmonic (quieter)
    const gain2 = ctx.createGain();
    gain2.gain.setValueAtTime(volume * 0.3, now);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + duration * 0.7);

    // --- Noise burst for attack (short white noise for "pew" crack) ---
    const noiseLen = Math.floor(ctx.sampleRate * 0.03);
    const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const noiseData = noiseBuf.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) {
      noiseData[i] = (Math.random() * 2 - 1) * 0.5;
    }
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuf;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(volume * 0.5, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);

    // --- Filter to shape the laser tone ---
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(freqStart, now);
    filter.frequency.exponentialRampToValueAtTime(freqEnd * 2, now + duration);
    filter.Q.value = 2;

    // --- Wiring ---
    osc1.connect(gainNode);
    gainNode.connect(filter);
    filter.connect(ctx.destination);

    osc2.connect(gain2);
    gain2.connect(ctx.destination);

    noiseSrc.connect(noiseGain);
    noiseGain.connect(ctx.destination);

    // --- Start & stop ---
    osc1.start(now);
    osc1.stop(now + duration + 0.01);
    osc2.start(now);
    osc2.stop(now + duration * 0.7 + 0.01);
    noiseSrc.start(now);
    noiseSrc.stop(now + 0.04);

    // Cleanup
    const cleanup = () => {
      activeSoundCount = Math.max(0, activeSoundCount - 1);
    };
    osc1.onended = cleanup;
  }

  // Three.js handles
  let scene, camera, renderer, composer, controls;
  let nodeGroup, wireGroup, pulseGroup, labelGroup;
  let raycaster, mouse;
  let nodeMeshMap = new Map();   // addr -> mesh
  let wireMeshMap = new Map();   // edgeKey -> line
  let clock = new THREE.Clock();

  // Wallet timeline for dynamic stats
  let walletTimeline = new Map();

  /* =========== DOM =========== */
  const elCurrentTime = document.getElementById('current-time');
  const elStatTxns = document.getElementById('stat-txns');
  const elStatBtc = document.getElementById('stat-btc');
  const elStatWallets = document.getElementById('stat-wallets');
  const elBtnPlay = document.getElementById('btn-play');
  const elIconPlay = document.getElementById('icon-play');
  const elIconPause = document.getElementById('icon-pause');
  const elBtnRewind = document.getElementById('btn-rewind');
  const elBtnForward = document.getElementById('btn-forward');
  const elSpeedSelect = document.getElementById('speed-select');
  const elTimeline = document.getElementById('timeline-slider');
  const elTimeStart = document.getElementById('timeline-start');
  const elTimeEnd = document.getElementById('timeline-end');
  const elFilterMinBtc = document.getElementById('filter-min-btc');
  const elFilterMinWallet = document.getElementById('filter-min-wallet');
  const elTooltip = document.getElementById('tooltip');
  const elThumbLabel = document.getElementById('timeline-thumb-label');
  const container = document.getElementById('three-container');
  const elBtnSound = document.getElementById('btn-sound');
  const elIconSoundOn = document.getElementById('icon-sound-on');
  const elIconSoundOff = document.getElementById('icon-sound-off');
  const elRangeStart = document.getElementById('range-start');
  const elRangeEnd = document.getElementById('range-end');
  const elBtnLoadRange = document.getElementById('btn-load-range');
  const elRangeStatus = document.getElementById('range-status');
  const elBtnRefresh = document.getElementById('btn-refresh-data');

  /* =========== THREE.JS SETUP =========== */
  function initThree() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0f);
    scene.fog = new THREE.FogExp2(0x0a0a0f, 0.003);

    camera = new THREE.PerspectiveCamera(55, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.set(0, 20, 55);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    container.appendChild(renderer.domElement);

    // Post-processing: bloom
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(container.clientWidth, container.clientHeight),
      0.6,   // strength
      0.3,   // radius
      0.3    // threshold
    );
    composer.addPass(bloomPass);
    composer.addPass(new OutputPass());

    // Controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 10;
    controls.maxDistance = 200;
    controls.target.set(0, 0, 0);

    // Groups
    nodeGroup = new THREE.Group();
    wireGroup = new THREE.Group();
    pulseGroup = new THREE.Group();
    labelGroup = new THREE.Group();
    scene.add(wireGroup, nodeGroup, pulseGroup, labelGroup);

    // Ambient + point lights
    scene.add(new THREE.AmbientLight(0x1a2a3a, 0.5));
    const pl = new THREE.PointLight(0x00d4ff, 1.5, 200);
    pl.position.set(0, 40, 0);
    scene.add(pl);

    // Subtle starfield background
    const starGeo = new THREE.BufferGeometry();
    const starPositions = new Float32Array(3000);
    for (let i = 0; i < 3000; i++) {
      starPositions[i] = (Math.random() - 0.5) * 400;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const starMat = new THREE.PointsMaterial({ color: 0x334466, size: 0.15, transparent: true, opacity: 0.6 });
    scene.add(new THREE.Points(starGeo, starMat));

    // Grid plane
    const gridHelper = new THREE.GridHelper(200, 80, 0x112233, 0x0a1520);
    gridHelper.position.y = -20;
    gridHelper.material.transparent = true;
    gridHelper.material.opacity = 0.3;
    scene.add(gridHelper);

    // Raycaster for hover
    raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 1.5 };
    mouse = new THREE.Vector2(-999, -999);
  }

  /* =========== DATA LOADING =========== */
  // Available data bounds from the database
  let dbEarliest = 0, dbLatest = 0, dbTotalTxns = 0;
  let useDatabase = false;

  function initWithData(data) {
    // Ensure all numeric fields are proper numbers (Postgres BIGINT can arrive as strings)
    allTransactions = data.map(tx => ({
      ...tx,
      timestamp: Number(tx.timestamp),
      amount_btc: Number(tx.amount_btc),
      sender_balance: Number(tx.sender_balance),
      confirmation_time_min: Number(tx.confirmation_time_min),
    }));
    timeStart = allTransactions[0].timestamp;
    timeEnd = allTransactions[allTransactions.length - 1].timestamp;
    simulationTime = timeStart;
    applyFilters();
    buildGraph();
    buildWalletTimeline();
    layoutNodes3D();
    createNodeMeshes();
    createWireMeshes();
    initTimeline();
    updateDisplay();
  }

  function resetScene() {
    clearPulses();
    activatedEdges.clear();
    recentEdges.clear();
    edgeState.clear();
    isPlaying = false;
    elIconPlay.classList.remove('hidden');
    elIconPause.classList.add('hidden');
    for (const [, mesh] of nodeMeshMap) { nodeGroup.remove(mesh); mesh.geometry?.dispose(); mesh.material?.dispose(); }
    nodeMeshMap.clear();
    for (const [, line] of wireMeshMap) { wireGroup.remove(line); line.geometry?.dispose(); line.material?.dispose(); }
    wireMeshMap.clear();
    nodes.clear();
    edges = [];
  }

  function showLoadingStatus(msg) {
    const el = document.getElementById('loading-status');
    if (el) el.textContent = msg;
  }

  function setRangeStatus(msg) {
    if (elRangeStatus) elRangeStatus.textContent = msg;
  }

  function unixToLocalDatetime(ts) {
    const d = new Date(ts * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function datetimeToUnix(dtStr) {
    return Math.floor(new Date(dtStr).getTime() / 1000);
  }

  async function loadFromDatabase(startTs, endTs) {
    showLoadingStatus('Loading transactions from database…');
    setRangeStatus('Loading…');
    elBtnLoadRange.disabled = true;
    try {
      const url = `/api/transactions?start=${startTs}&end=${endTs}&min_btc=1`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!resp.ok) throw new Error(`API returned ${resp.status}`);
      const data = await resp.json();
      if (!Array.isArray(data) || data.length === 0) {
        showLoadingStatus('No transactions found in this range');
        setRangeStatus('No data');
        elBtnLoadRange.disabled = false;
        return;
      }
      console.log(`Loaded ${data.length} transactions from database`);
      resetScene();
      initWithData(data);
      showLoadingStatus('');
      setRangeStatus(`${data.length} transactions loaded`);
    } catch (e) {
      console.error('Database load failed:', e);
      showLoadingStatus('Failed to load data');
      setRangeStatus('Error');
    }
    elBtnLoadRange.disabled = false;
  }

  async function loadData() {
    // Try to connect to the database first
    try {
      const rangeResp = await fetch('/api/range', { signal: AbortSignal.timeout(10000) });
      if (rangeResp.ok) {
        const range = await rangeResp.json();
        if (range.earliest && range.latest && range.totalTransactions > 0) {
          useDatabase = true;
          dbEarliest = range.earliest;
          dbLatest = range.latest;
          dbTotalTxns = range.totalTransactions;

          // Set date picker bounds
          elRangeStart.min = unixToLocalDatetime(dbEarliest);
          elRangeStart.max = unixToLocalDatetime(dbLatest);
          elRangeEnd.min = unixToLocalDatetime(dbEarliest);
          elRangeEnd.max = unixToLocalDatetime(dbLatest);

          // Default: last 24 hours of data
          const defaultStart = Math.max(dbEarliest, dbLatest - 86400);
          elRangeStart.value = unixToLocalDatetime(defaultStart);
          elRangeEnd.value = unixToLocalDatetime(dbLatest);

          setRangeStatus(`${dbTotalTxns.toLocaleString()} total transactions available`);

          // Load default range
          await loadFromDatabase(defaultStart, dbLatest);
          return;
        }
      }
    } catch (e) {
      console.warn('Database not available:', e.message);
    }

    // Fallback: load static JSON
    useDatabase = false;
    showLoadingStatus('Loading transaction data…');
    const staticResp = await fetch('./transactions.json');
    const staticData = await staticResp.json();
    console.log(`Loaded ${staticData.length} transactions from static file (database unavailable)`);
    initWithData(staticData);
    showLoadingStatus('');

    // Set date picker to static data range
    elRangeStart.value = unixToLocalDatetime(timeStart);
    elRangeEnd.value = unixToLocalDatetime(timeEnd);
    setRangeStatus('Using cached data (database unavailable)');
  }

  /* =========== FILTERING =========== */
  function applyFilters() {
    filteredTxns = allTransactions.filter(tx =>
      tx.amount_btc >= filterMinBtc &&
      tx.sender_balance >= filterMinWallet
    );
  }

  /* =========== GRAPH BUILDING =========== */
  function buildGraph() {
    nodes.clear();
    edges = [];
    const edgeMap = new Map();

    for (const tx of filteredTxns) {
      if (!nodes.has(tx.sender)) {
        nodes.set(tx.sender, { addr: tx.sender, balance: tx.sender_balance, txCount: 0, x: 0, y: 0, z: 0 });
      }
      if (!nodes.has(tx.receiver)) {
        nodes.set(tx.receiver, { addr: tx.receiver, balance: 0, txCount: 0, x: 0, y: 0, z: 0 });
      }
      const sNode = nodes.get(tx.sender);
      const rNode = nodes.get(tx.receiver);
      sNode.txCount++;
      rNode.txCount++;
      sNode.balance = Math.max(sNode.balance, tx.sender_balance);

      const eKey = tx.sender < tx.receiver ? `${tx.sender}-${tx.receiver}` : `${tx.receiver}-${tx.sender}`;
      if (!edgeMap.has(eKey)) {
        edgeMap.set(eKey, { source: tx.sender, target: tx.receiver, txns: [], key: eKey });
      }
      edgeMap.get(eKey).txns.push(tx);
    }
    edges = Array.from(edgeMap.values());
  }

  /* =========== 3D FORCE-DIRECTED LAYOUT =========== */
  function layoutNodes3D() {
    const nodeArr = Array.from(nodes.values());
    const n = nodeArr.length;
    if (n === 0) return;

    // Build adjacency map for edge-based attraction
    const adjCount = new Map();
    for (const edge of edges) {
      const key = edge.key;
      const count = edge.txns.length;
      if (!adjCount.has(edge.source)) adjCount.set(edge.source, new Map());
      if (!adjCount.has(edge.target)) adjCount.set(edge.target, new Map());
      adjCount.get(edge.source).set(edge.target, count);
      adjCount.get(edge.target).set(edge.source, count);
    }

    // Initialize positions: Fibonacci sphere
    for (let i = 0; i < n; i++) {
      const node = nodeArr[i];
      const phi = Math.acos(1 - 2 * (i + 0.5) / n);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const r = LAYOUT_SPREAD * 0.5;
      node.x = r * Math.sin(phi) * Math.cos(theta);
      node.y = r * Math.sin(phi) * Math.sin(theta) * 0.5; // flatten Y
      node.z = r * Math.cos(phi);
    }

    // Build index map for O(1) lookup
    const nodeIndex = new Map();
    for (let i = 0; i < n; i++) nodeIndex.set(nodeArr[i].addr, i);

    // Velocity arrays
    const vx = new Float64Array(n);
    const vy = new Float64Array(n);
    const vz = new Float64Array(n);

    // Force simulation iterations
    const iterations = 200;
    const repulsionStrength = 800;
    const attractionStrength = 0.02;
    const idealEdgeDist = 8; // base distance for 1 tx — more txns = closer
    const damping = 0.85;
    const maxForce = 4;

    for (let iter = 0; iter < iterations; iter++) {
      const alpha = 1 - iter / iterations; // cooling

      // Reset velocities
      vx.fill(0); vy.fill(0); vz.fill(0);

      // Repulsion (all pairs, approximated for n < 600)
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let dx = nodeArr[j].x - nodeArr[i].x;
          let dy = nodeArr[j].y - nodeArr[i].y;
          let dz = nodeArr[j].z - nodeArr[i].z;
          let dist2 = dx * dx + dy * dy + dz * dz;
          if (dist2 < 0.1) dist2 = 0.1;
          const dist = Math.sqrt(dist2);
          const force = Math.min(repulsionStrength / dist2, maxForce) * alpha;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          const fz = (dz / dist) * force;
          vx[i] -= fx; vy[i] -= fy; vz[i] -= fz;
          vx[j] += fx; vy[j] += fy; vz[j] += fz;
        }
      }

      // Attraction along edges (distance inversely proportional to tx count)
      for (const edge of edges) {
        const si = nodeIndex.get(edge.source);
        const ti = nodeIndex.get(edge.target);
        if (si === undefined || ti === undefined) continue;
        const a = nodeArr[si], b = nodeArr[ti];
        let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        let dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < 0.1) dist = 0.1;

        // More transactions = shorter ideal distance
        const txCount = edge.txns.length;
        const targetDist = idealEdgeDist / Math.sqrt(txCount);
        const displacement = dist - targetDist;
        const force = displacement * attractionStrength * alpha;

        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        const fz = (dz / dist) * force;
        vx[si] += fx; vy[si] += fy; vz[si] += fz;
        vx[ti] -= fx; vy[ti] -= fy; vz[ti] -= fz;
      }

      // Centering force
      for (let i = 0; i < n; i++) {
        vx[i] -= nodeArr[i].x * 0.002 * alpha;
        vy[i] -= nodeArr[i].y * 0.002 * alpha;
        vz[i] -= nodeArr[i].z * 0.002 * alpha;
      }

      // Apply velocities with damping
      for (let i = 0; i < n; i++) {
        nodeArr[i].x += vx[i] * damping;
        nodeArr[i].y += vy[i] * damping;
        nodeArr[i].z += vz[i] * damping;
      }
    }

    // Normalize: scale positions to fit within desired bounds
    let maxR = 0;
    for (let i = 0; i < n; i++) {
      const r = Math.sqrt(nodeArr[i].x ** 2 + nodeArr[i].y ** 2 + nodeArr[i].z ** 2);
      if (r > maxR) maxR = r;
    }
    if (maxR > 0) {
      const scaleFactor = LAYOUT_SPREAD / maxR;
      for (let i = 0; i < n; i++) {
        nodeArr[i].x *= scaleFactor;
        nodeArr[i].y *= scaleFactor;
        nodeArr[i].z *= scaleFactor;
      }
    }

    // Index lookup for edges (cache for pulse spawning)
    for (const edge of edges) {
      const s = nodes.get(edge.source);
      const t = nodes.get(edge.target);
      if (s && t) {
        edge.sx = s.x; edge.sy = s.y; edge.sz = s.z;
        edge.tx = t.x; edge.ty = t.y; edge.tz = t.z;
      }
    }
  }

  /* =========== CREATE NODE MESHES =========== */
  function createNodeMeshes() {
    // Clear old
    while (nodeGroup.children.length) nodeGroup.remove(nodeGroup.children[0]);
    nodeMeshMap.clear();

    const geo = new THREE.SphereGeometry(1, 16, 12);

    for (const [addr, node] of nodes) {
      const balLog = Math.log10(Math.max(node.balance, 1));
      const size = NODE_BASE_SIZE + (balLog / 5) * (NODE_MAX_SIZE - NODE_BASE_SIZE);

      const mat = new THREE.MeshStandardMaterial({
        color: DIM_CYAN,
        emissive: DIM_CYAN,
        emissiveIntensity: 0.3,
        transparent: true,
        opacity: 0.6,
        roughness: 0.5,
        metalness: 0.3,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.setScalar(size);
      mesh.position.set(node.x, node.y, node.z);
      mesh.userData = { addr, node };
      nodeGroup.add(mesh);
      nodeMeshMap.set(addr, mesh);
    }
  }

  /* =========== CREATE WIRE MESHES =========== */
  function createWireMeshes() {
    while (wireGroup.children.length) wireGroup.remove(wireGroup.children[0]);
    wireMeshMap.clear();

    const res = new THREE.Vector2(container.clientWidth, container.clientHeight);

    for (const edge of edges) {
      const sNode = nodes.get(edge.source);
      const tNode = nodes.get(edge.target);
      if (!sNode || !tNode) continue;

      const geo = new LineGeometry();
      geo.setPositions([
        sNode.x, sNode.y, sNode.z,
        tNode.x, tNode.y, tNode.z
      ]);
      const mat = new LineMaterial({
        color: WIRE_COLOR.getHex(),
        transparent: true,
        opacity: 0,  // hidden until activated
        linewidth: WIRE_BASE_WIDTH,
        resolution: res,
        depthWrite: false,
        worldUnits: false,  // pixel-space width
      });
      const line = new Line2(geo, mat);
      line.computeLineDistances();
      line.userData = { edgeKey: edge.key };
      wireGroup.add(line);
      wireMeshMap.set(edge.key, line);
    }
  }

  /* =========== WALLET TIMELINE (dynamic stats) =========== */
  function buildWalletTimeline() {
    walletTimeline.clear();
    const walletState = new Map();

    for (const tx of filteredTxns) {
      if (!walletState.has(tx.sender)) walletState.set(tx.sender, { balance: tx.sender_balance, txCount: 0 });
      const sState = walletState.get(tx.sender);
      sState.balance = tx.sender_balance - tx.amount_btc;
      sState.txCount++;
      if (!walletTimeline.has(tx.sender)) walletTimeline.set(tx.sender, []);
      walletTimeline.get(tx.sender).push({ timestamp: tx.timestamp, balance: Math.max(sState.balance, 0), txCount: sState.txCount });

      if (!walletState.has(tx.receiver)) walletState.set(tx.receiver, { balance: 0, txCount: 0 });
      const rState = walletState.get(tx.receiver);
      rState.balance += tx.amount_btc;
      rState.txCount++;
      if (!walletTimeline.has(tx.receiver)) walletTimeline.set(tx.receiver, []);
      walletTimeline.get(tx.receiver).push({ timestamp: tx.timestamp, balance: Math.max(rState.balance, 0), txCount: rState.txCount });
    }
  }

  function getWalletStatsAtTime(addr, time) {
    const timeline = walletTimeline.get(addr);
    if (!timeline || timeline.length === 0) {
      const node = nodes.get(addr);
      return { txCount: 0, balance: node ? node.balance : 0 };
    }
    let lo = 0, hi = timeline.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (timeline[mid].timestamp <= time) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (best === -1) {
      const firstTx = filteredTxns.find(tx => tx.sender === addr);
      return { txCount: 0, balance: firstTx ? firstTx.sender_balance : 0 };
    }
    return { txCount: timeline[best].txCount, balance: timeline[best].balance };
  }

  /* =========== TIMELINE / DISPLAY =========== */
  function initTimeline() {
    const sd = new Date(timeStart * 1000), ed = new Date(timeEnd * 1000);
    elTimeStart.textContent = formatDate(sd);
    elTimeEnd.textContent = formatDate(ed);
    // Adapt simulation speed so full playback takes ~TARGET_PLAYBACK_SECS at 1x
    const totalSimHours = (timeEnd - timeStart) / 3600;
    if (totalSimHours > 0) {
      SIM_HOUR_DURATION = (TARGET_PLAYBACK_SECS * 1000) / totalSimHours;
      // Clamp: at least 50ms per hour (very dense data) and at most 10s per hour (very sparse)
      SIM_HOUR_DURATION = Math.max(50, Math.min(10000, SIM_HOUR_DURATION));
    }
    updateTimelinePosition();
  }
  function updateTimelinePosition() {
    const progress = (simulationTime - timeStart) / (timeEnd - timeStart);
    elTimeline.value = Math.round(progress * 1000);
    updateThumbLabel(progress);
  }
  function updateThumbLabel(progress) {
    const d = new Date(simulationTime * 1000);
    elThumbLabel.textContent = formatDateTime(d);
    const sliderRect = elTimeline.getBoundingClientRect();
    const thumbR = 7, usable = sliderRect.width - thumbR * 2;
    elThumbLabel.style.left = (thumbR + progress * usable) + 'px';
  }
  function formatDate(d) {
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${mon[d.getMonth()]} ${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  }
  function formatDateTime(d) {
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    return `${day[d.getDay()]} ${mon[d.getMonth()]} ${d.getDate()}, ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  }
  function updateDisplay() {
    const d = new Date(simulationTime * 1000);
    elCurrentTime.textContent = formatDateTime(d);
    updateTimelinePosition();

    const hourStart = simulationTime - 3600;
    const visibleTxns = filteredTxns.filter(tx => tx.timestamp >= hourStart && tx.timestamp <= simulationTime);
    const totalBtc = visibleTxns.reduce((s, tx) => s + tx.amount_btc, 0);
    const walletSet = new Set();
    visibleTxns.forEach(tx => { walletSet.add(tx.sender); walletSet.add(tx.receiver); });

    elStatTxns.textContent = visibleTxns.length.toLocaleString();
    elStatBtc.textContent = totalBtc.toFixed(1);
    elStatWallets.textContent = walletSet.size.toLocaleString();
  }

  /* =========== UPDATE NODES (active glow, dynamic size) =========== */
  function updateNodes() {
    const hourStart = simulationTime - 3600;
    const activeWallets = new Set();
    for (const tx of filteredTxns) {
      if (tx.timestamp >= hourStart && tx.timestamp <= simulationTime) {
        activeWallets.add(tx.sender);
        activeWallets.add(tx.receiver);
      }
    }

    for (const [addr, mesh] of nodeMeshMap) {
      const isActive = activeWallets.has(addr);
      const stats = getWalletStatsAtTime(addr, simulationTime);
      const balLog = Math.log10(Math.max(stats.balance, 1));
      const size = NODE_BASE_SIZE + (balLog / 5) * (NODE_MAX_SIZE - NODE_BASE_SIZE);
      mesh.scale.setScalar(size);

      if (isActive) {
        mesh.material.color.copy(CYAN);
        mesh.material.emissive.copy(CYAN);
        mesh.material.emissiveIntensity = 0.8;
        mesh.material.opacity = 0.85;
      } else {
        mesh.material.color.copy(DIM_CYAN);
        mesh.material.emissive.copy(DIM_CYAN);
        mesh.material.emissiveIntensity = 0.5;
        mesh.material.opacity = 0.65;
      }
    }
  }

  /* =========== UPDATE WIRES =========== */
  function updateWires() {
    for (const [key, line] of wireMeshMap) {
      const es = edgeState.get(key);

      // Not yet activated — fully hidden
      if (!es || es.txCount === 0) {
        line.material.opacity = 0;
        continue;
      }

      const hasActivePulse = activePulses.some(p => p.alive && p.edgeKey === key);
      const age = simulationTime - es.lastTxTime; // seconds since last tx

      // Thickness: grows with each transaction, keeps thickness even while fading
      const width = Math.min(WIRE_BASE_WIDTH + WIRE_WIDTH_PER_TX * (es.txCount - 1), WIRE_MAX_WIDTH);
      line.material.linewidth = width;

      if (hasActivePulse) {
        // Wire glows cyan during active pulse
        line.material.color.copy(WIRE_GLOW);
        line.material.opacity = WIRE_BRIGHT_OPACITY;
      } else {
        // Fade the wire over WIRE_FADE_SEC after last transaction
        const fadeT = Math.max(0, 1 - age / WIRE_FADE_SEC);
        const baseOpacity = 0.08 + 0.32 * fadeT; // fades from 0.40 to 0.08
        line.material.color.copy(WIRE_COLOR);
        line.material.opacity = baseOpacity;
      }
    }
  }

  /* =========== PULSE SYSTEM =========== */
  function spawnPulse(tx, edge) {
    const geo = new THREE.SphereGeometry(0.25, 8, 6);
    const mat = new THREE.MeshStandardMaterial({
      color: ORANGE,
      emissive: ORANGE,
      emissiveIntensity: 1.2,
      transparent: true,
      opacity: 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    pulseGroup.add(mesh);

    const confNorm = Math.min(1, Math.max(0.1, tx.confirmation_time_min / 60));
    playLaserSound(tx.amount_btc, confNorm);

    const size = 0.15 + Math.log10(Math.max(tx.amount_btc, 1)) * 0.15;
    const duration = PULSE_DURATION_BASE * (0.5 + confNorm * 0.5);

    activePulses.push({
      mesh, alive: true,
      sx: edge.sx, sy: edge.sy, sz: edge.sz,
      tx: edge.tx, ty: edge.ty, tz: edge.tz,
      startTime: performance.now(),
      duration,
      size,
      edgeKey: edge.key,
    });
  }

  function updatePulses(nowMs) {
    for (const p of activePulses) {
      if (!p.alive) continue;
      const t = (nowMs - p.startTime) / p.duration;
      if (t >= 1) {
        p.alive = false;
        pulseGroup.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        continue;
      }
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      p.mesh.position.set(
        p.sx + (p.tx - p.sx) * ease,
        p.sy + (p.ty - p.sy) * ease,
        p.sz + (p.tz - p.sz) * ease
      );
      const scale = p.size * (1 - 0.3 * Math.sin(t * Math.PI));
      p.mesh.scale.setScalar(scale);
      p.mesh.material.opacity = 1 - t * 0.5;
    }
    activePulses = activePulses.filter(p => p.alive);
  }

  function clearPulses() {
    for (const p of activePulses) {
      pulseGroup.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
    }
    activePulses = [];
  }

  /* =========== SIMULATION TICK =========== */
  function tickSimulation(nowMs) {
    if (!isPlaying) return;
    if (lastFrameTime === 0) { lastFrameTime = nowMs; return; }
    const dt = nowMs - lastFrameTime;
    lastFrameTime = nowMs;

    // Advance simulation time
    const simDtSec = (dt / SIM_HOUR_DURATION) * 3600 * playbackSpeed;
    simulationTime += simDtSec;
    if (simulationTime >= timeEnd) {
      simulationTime = timeEnd;
      isPlaying = false;
      elIconPlay.classList.remove('hidden');
      elIconPause.classList.add('hidden');
      lastFrameTime = 0;
    }

    // Find transactions that fall in [prevTime, simulationTime]
    const prevTime = simulationTime - simDtSec;
    for (const tx of filteredTxns) {
      if (tx.timestamp > prevTime && tx.timestamp <= simulationTime) {
        // Find matching edge
        const eKey = tx.sender < tx.receiver ? `${tx.sender}-${tx.receiver}` : `${tx.receiver}-${tx.sender}`;
        const edge = edges.find(e => e.key === eKey);
        if (!edge) continue;

        // Update edge state
        if (!edgeState.has(eKey)) edgeState.set(eKey, { txCount: 0, lastTxTime: 0 });
        const es = edgeState.get(eKey);
        es.txCount++;
        es.lastTxTime = tx.timestamp;

        activatedEdges.add(eKey);
        spawnPulse(tx, edge);
      }
    }

    updateDisplay();
  }

  /* =========== HOVER / TOOLTIP =========== */
  function onMouseMove(e) {
    const rect = container.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const meshes = Array.from(nodeMeshMap.values());
    const hits = raycaster.intersectObjects(meshes, false);

    if (hits.length > 0) {
      const hit = hits[0];
      const { addr, node } = hit.object.userData;
      const stats = getWalletStatsAtTime(addr, simulationTime);
      const shortAddr = addr.slice(0, 6) + '…' + addr.slice(-4);
      elTooltip.style.display = 'block';
      elTooltip.style.left = (e.clientX - rect.left + 14) + 'px';
      elTooltip.style.top = (e.clientY - rect.top - 10) + 'px';
      elTooltip.innerHTML = `
        <div class="font-mono text-xs text-cyan-300">${shortAddr}</div>
        <div class="text-xs mt-1">Balance: <span class="text-orange-400">${stats.balance.toFixed(2)} BTC</span></div>
        <div class="text-xs">Txns: <span class="text-cyan-400">${stats.txCount}</span></div>
      `;
    } else {
      elTooltip.style.display = 'none';
    }
  }

  /* =========== CONTROLS =========== */
  function setupControls() {
    elBtnPlay.addEventListener('click', () => {
      if (simulationTime >= timeEnd) {
        simulationTime = timeStart;
        clearPulses();
        activatedEdges.clear();
        recentEdges.clear();
        edgeState.clear();
      }
      isPlaying = !isPlaying;
      lastFrameTime = 0;
      elIconPlay.classList.toggle('hidden', isPlaying);
      elIconPause.classList.toggle('hidden', !isPlaying);
    });

    elBtnRewind.addEventListener('click', () => {
      simulationTime = Math.max(timeStart, simulationTime - 3600);
      clearPulses();
      activatedEdges.clear();
      recentEdges.clear();
      edgeState.clear();
      updateDisplay();
    });

    elBtnForward.addEventListener('click', () => {
      simulationTime = Math.min(timeEnd, simulationTime + 3600);
      updateDisplay();
    });

    elSpeedSelect.addEventListener('change', () => {
      playbackSpeed = parseFloat(elSpeedSelect.value);
    });

    elTimeline.addEventListener('input', () => {
      const progress = elTimeline.value / 1000;
      simulationTime = timeStart + progress * (timeEnd - timeStart);
      clearPulses();
      activatedEdges.clear();
      recentEdges.clear();
      edgeState.clear();
      updateDisplay();
    });

    elFilterMinBtc.addEventListener('change', () => {
      filterMinBtc = parseFloat(elFilterMinBtc.value) || 0;
      applyFilters();
      resetScene();
      buildGraph();
      buildWalletTimeline();
      layoutNodes3D();
      createNodeMeshes();
      createWireMeshes();
      initTimeline();
      updateDisplay();
    });

    elFilterMinWallet.addEventListener('change', () => {
      filterMinWallet = parseFloat(elFilterMinWallet.value) || 0;
      applyFilters();
      resetScene();
      buildGraph();
      buildWalletTimeline();
      layoutNodes3D();
      createNodeMeshes();
      createWireMeshes();
      initTimeline();
      updateDisplay();
    });

    elBtnLoadRange.addEventListener('click', async () => {
      const startTs = datetimeToUnix(elRangeStart.value);
      const endTs = datetimeToUnix(elRangeEnd.value);
      if (!startTs || !endTs || startTs >= endTs) {
        setRangeStatus('Invalid date range');
        return;
      }
      await loadFromDatabase(startTs, endTs);
    });

    if (elBtnRefresh) {
      elBtnRefresh.addEventListener('click', async () => {
        await loadData();
      });
    }

    if (elBtnSound) {
      elBtnSound.addEventListener('click', () => {
        audioEnabled = !audioEnabled;
        elIconSoundOn.classList.toggle('hidden', !audioEnabled);
        elIconSoundOff.classList.toggle('hidden', audioEnabled);
      });
    }

    container.addEventListener('mousemove', onMouseMove);
    container.addEventListener('mouseleave', () => { elTooltip.style.display = 'none'; });

    window.addEventListener('resize', () => {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
      composer.setSize(container.clientWidth, container.clientHeight);
      for (const [, line] of wireMeshMap) {
        line.material.resolution.set(container.clientWidth, container.clientHeight);
      }
    });
  }

  /* =========== RENDER LOOP =========== */
  function animate() {
    const nowMs = performance.now();
    tickSimulation(nowMs);
    updatePulses(nowMs);
    updateNodes();
    updateWires();
    controls.update();
    composer.render();
  }

  /* =========== INIT =========== */
  initThree();
  setupControls();
  loadData().then(() => {
    requestAnimationFrame(animate);
  });

})();

