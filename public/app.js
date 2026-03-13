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
  const SIM_HOUR_DURATION = 3000;
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
  function initWithData(data) {
    allTransactions = data;
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

  function showLoadingStatus(msg) {
    const el = document.getElementById('loading-status');
    if (el) el.textContent = msg;
  }

  async function loadData() {
    // Load static data first for instant display
    showLoadingStatus('Loading transaction data\u2026');
    const staticResp = await fetch('./transactions.json');
    const staticData = await staticResp.json();
    console.log(`Loaded ${staticData.length} transactions from static file`);
    initWithData(staticData);
    showLoadingStatus('');

    // Then try to upgrade to live data in the background
    try {
      showLoadingStatus('Fetching live blockchain data\u2026');
      const apiResp = await fetch('/api/transactions?blocks=30', { signal: AbortSignal.timeout(120000) });
      if (apiResp.ok) {
        const liveData = await apiResp.json();
        if (Array.isArray(liveData) && liveData.length > 10) {
          console.log(`Upgraded to ${liveData.length} live transactions from API`);
          // Reset and reinitialize with live data
          clearPulses();
          activatedEdges.clear();
          recentEdges.clear();
          edgeState.clear();
          // Clear existing meshes
          for (const [, mesh] of nodeMeshMap) { nodeGroup.remove(mesh); mesh.geometry?.dispose(); mesh.material?.dispose(); }
          nodeMeshMap.clear();
          for (const [, line] of wireMeshMap) { wireGroup.remove(line); line.geometry?.dispose(); line.material?.dispose(); }
          wireMeshMap.clear();
          nodes.clear();
          edges = [];
          initWithData(liveData);
          showLoadingStatus('');
        }
      }
    } catch (e) {
      console.warn('Live API unavailable, keeping static data:', e.message);
    }
    showLoadingStatus('');
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
        // Active pulse on this wire — full glow
        line.material.color.set(WIRE_GLOW.getHex());
        line.material.opacity = WIRE_BRIGHT_OPACITY;
      } else if (age < WIRE_FADE_SEC) {
        // Fading: linear from WIRE_BRIGHT_OPACITY to 0 over WIRE_FADE_SEC
        const fade = WIRE_BRIGHT_OPACITY * (1 - age / WIRE_FADE_SEC);
        line.material.color.set(WIRE_COLOR.getHex());
        line.material.opacity = Math.max(fade, 0);
      } else {
        // Fully faded — 1 day since last tx
        line.material.opacity = 0;
      }
    }
  }

  /* =========== PULSE SYSTEM =========== */
  // Create a radial gradient texture for round sprites
  function createGlowTexture() {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.3, 'rgba(255,255,255,0.8)');
    gradient.addColorStop(0.6, 'rgba(255,255,255,0.3)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    return tex;
  }
  const glowTexture = createGlowTexture();

  function spawnPulses(prevTime) {
    for (const tx of filteredTxns) {
      if (tx.timestamp > prevTime && tx.timestamp <= simulationTime) {
        const sNode = nodes.get(tx.sender);
        const rNode = nodes.get(tx.receiver);
        if (!sNode || !rNode) continue;

        const confNorm = Math.max(0.1, Math.min(1, tx.confirmation_time_min / 120));
        const travelMs = PULSE_DURATION_BASE * (0.5 + confNorm * 1.5);
        const amountLog = Math.log10(Math.max(tx.amount_btc, 1));
        const pulseSize = 0.15 + amountLog * 0.25;
        const isLarge = tx.amount_btc >= 100;
        const color = isLarge ? ORANGE : CYAN;

        const eKey = tx.sender < tx.receiver ? `${tx.sender}-${tx.receiver}` : `${tx.receiver}-${tx.sender}`;
        activatedEdges.add(eKey);
        recentEdges.set(eKey, simulationTime);

        // Update persistent edge state
        if (!edgeState.has(eKey)) {
          edgeState.set(eKey, { txCount: 0, lastTxTime: 0 });
        }
        const es = edgeState.get(eKey);
        es.txCount++;
        es.lastTxTime = simulationTime;

        // Play laser sound
        playLaserSound(tx.amount_btc, confNorm);

        // Create sprite for pulse head
        const mat = new THREE.SpriteMaterial({
          map: glowTexture,
          color: color.clone(),
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        const sprite = new THREE.Sprite(mat);
        sprite.scale.setScalar(pulseSize * 2);
        sprite.position.set(sNode.x, sNode.y, sNode.z);
        pulseGroup.add(sprite);

        // Create label sprite
        const labelCanvas = document.createElement('canvas');
        const labelCtx = labelCanvas.getContext('2d');
        const labelText = tx.amount_btc.toFixed(2) + ' BTC';
        labelCanvas.width = 256;
        labelCanvas.height = 48;
        labelCtx.clearRect(0, 0, 256, 48);
        labelCtx.font = '600 24px JetBrains Mono, monospace';
        labelCtx.textAlign = 'center';
        labelCtx.textBaseline = 'middle';
        // Shadow
        labelCtx.fillStyle = 'rgba(0,0,0,0.8)';
        labelCtx.fillText(labelText, 129, 25);
        // Text
        labelCtx.fillStyle = isLarge ? '#ff6b35' : '#00d4ff';
        labelCtx.fillText(labelText, 128, 24);
        const labelTex = new THREE.CanvasTexture(labelCanvas);
        const labelMat = new THREE.SpriteMaterial({
          map: labelTex,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.NormalBlending,
        });
        const labelSprite = new THREE.Sprite(labelMat);
        labelSprite.scale.set(4, 0.75, 1);
        labelSprite.position.set(sNode.x, sNode.y + 1.2, sNode.z);
        labelGroup.add(labelSprite);

        activePulses.push({
          sprite, labelSprite, labelTex,
          sx: sNode.x, sy: sNode.y, sz: sNode.z,
          tx: rNode.x, ty: rNode.y, tz: rNode.z,
          startMs: performance.now(),
          durationMs: travelMs,
          color, pulseSize, isLarge,
          alive: true,
          edgeKey: eKey,
          txData: tx,
        });
      }
    }
  }

  function updatePulses() {
    const now = performance.now();
    for (const pulse of activePulses) {
      if (!pulse.alive) continue;
      const t = Math.min(1, (now - pulse.startMs) / pulse.durationMs);
      const easedT = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;  // ease in-out

      // Interpolate position
      pulse.sprite.position.set(
        pulse.sx + (pulse.tx - pulse.sx) * easedT,
        pulse.sy + (pulse.ty - pulse.sy) * easedT,
        pulse.sz + (pulse.tz - pulse.sz) * easedT,
      );

      // Label follows slightly behind pulse head
      const labelT = Math.max(0, easedT - 0.05);
      pulse.labelSprite.position.set(
        pulse.sx + (pulse.tx - pulse.sx) * labelT,
        pulse.sy + (pulse.ty - pulse.sy) * labelT + 1.2,
        pulse.sz + (pulse.tz - pulse.sz) * labelT,
      );

      // Fade in quickly, hold, then fade out near destination
      let opacity;
      if (t < 0.12) opacity = t / 0.12;
      else if (t < 0.8) opacity = 1;
      else opacity = (1 - t) / 0.2;
      pulse.sprite.material.opacity = Math.max(0, opacity) * 0.95;

      // Label: fade in at 20%, hold, fade out at 80%
      let labelOp;
      if (t < 0.2) labelOp = 0;
      else if (t < 0.3) labelOp = (t - 0.2) / 0.1;
      else if (t < 0.75) labelOp = 0.9;
      else labelOp = Math.max(0, (1 - t) / 0.25 * 0.9);
      pulse.labelSprite.material.opacity = labelOp;

      // Pulse size oscillation (breathing)
      const breathe = 1 + 0.15 * Math.sin(t * Math.PI * 6);
      pulse.sprite.scale.setScalar(pulse.pulseSize * 2 * breathe);

      if (t >= 1) {
        pulse.alive = false;
        // Node flash on arrival
        const arrivalMesh = nodeMeshMap.get(pulse.txData.receiver);
        if (arrivalMesh) {
          arrivalMesh.material.emissiveIntensity = 3.0;
          setTimeout(() => {
            if (arrivalMesh.material) arrivalMesh.material.emissiveIntensity = 0.8;
          }, 400);
        }
        // Cleanup
        pulseGroup.remove(pulse.sprite);
        pulse.sprite.geometry?.dispose();
        pulse.sprite.material.map?.dispose();
        pulse.sprite.material.dispose();
        labelGroup.remove(pulse.labelSprite);
        pulse.labelSprite.geometry?.dispose();
        pulse.labelTex?.dispose();
        pulse.labelSprite.material.dispose();
      }
    }
    activePulses = activePulses.filter(p => p.alive);
  }

  function clearPulses() {
    for (const pulse of activePulses) {
      pulseGroup.remove(pulse.sprite);
      pulse.sprite.geometry?.dispose();
      pulse.sprite.material.map?.dispose();
      pulse.sprite.material.dispose();
      labelGroup.remove(pulse.labelSprite);
      pulse.labelSprite.geometry?.dispose();
      pulse.labelTex?.dispose();
      pulse.labelSprite.material.dispose();
    }
    activePulses = [];
  }

  /* =========== SIMULATION LOOP =========== */
  function animate(timestamp) {
    requestAnimationFrame(animate);

    if (isPlaying) {
      const wallDelta = lastFrameTime ? (timestamp - lastFrameTime) : 0;
      lastFrameTime = timestamp;

      const prevTime = simulationTime;
      const simDelta = (wallDelta / SIM_HOUR_DURATION) * 3600 * playbackSpeed;
      simulationTime = Math.min(simulationTime + simDelta, timeEnd);

      if (simulationTime > prevTime) {
        spawnPulses(prevTime);
      }

      if (simulationTime >= timeEnd) {
        isPlaying = false;
        lastFrameTime = 0;
        elIconPlay.classList.remove('hidden');
        elIconPause.classList.add('hidden');
      }
    } else {
      lastFrameTime = 0;
    }

    updatePulses();
    updateWires();
    updateNodes();
    updateDisplay();
    controls.update();
    composer.render();
  }

  /* =========== HOVER (raycasting) =========== */
  function onMouseMove(event) {
    const rect = container.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const meshes = Array.from(nodeMeshMap.values());
    const intersects = raycaster.intersectObjects(meshes);

    if (intersects.length > 0) {
      const hit = intersects[0].object;
      const { addr, node } = hit.userData;
      const stats = getWalletStatsAtTime(addr, simulationTime);

      const shortAddr = addr.length > 20 ? addr.slice(0, 10) + '\u2026' + addr.slice(-8) : addr;
      elTooltip.innerHTML = `
        <div class="tt-label">Wallet</div>
        <div class="tt-amount">${shortAddr}</div>
        <div class="tt-label">Balance</div>
        <div class="tt-amount">${stats.balance.toLocaleString(undefined, { maximumFractionDigits: 4 })} BTC</div>
        <div class="tt-label">Transactions</div>
        <div class="tt-amount">${stats.txCount}</div>
      `;
      const rect2 = container.getBoundingClientRect();
      elTooltip.style.left = (event.clientX - rect2.left + 12) + 'px';
      elTooltip.style.top = (event.clientY - rect2.top - 10) + 'px';
      elTooltip.classList.remove('hidden');
      container.style.cursor = 'pointer';
    } else {
      elTooltip.classList.add('hidden');
      container.style.cursor = '';
    }
  }

  /* =========== CONTROLS =========== */
  elBtnPlay.addEventListener('click', () => {
    if (simulationTime >= timeEnd) {
      simulationTime = timeStart;
      clearPulses();
      activatedEdges.clear();
      recentEdges.clear();
      edgeState.clear();
      updateWires();
    }
    isPlaying = !isPlaying;
    lastFrameTime = 0;
    if (isPlaying) {
      elIconPlay.classList.add('hidden');
      elIconPause.classList.remove('hidden');
    } else {
      elIconPlay.classList.remove('hidden');
      elIconPause.classList.add('hidden');
    }
  });

  elBtnRewind.addEventListener('click', () => {
    simulationTime = timeStart;
    clearPulses();
    activatedEdges.clear();
    recentEdges.clear();
    edgeState.clear();
    updateWires();
    updateDisplay();
    isPlaying = false;
    lastFrameTime = 0;
    elIconPlay.classList.remove('hidden');
    elIconPause.classList.add('hidden');
  });

  elBtnForward.addEventListener('click', () => {
    const jump = (timeEnd - timeStart) * 0.1;
    const prevTime = simulationTime;
    simulationTime = Math.min(simulationTime + jump, timeEnd);
    spawnPulses(prevTime);
    updateDisplay();
  });

  elSpeedSelect.addEventListener('change', () => {
    playbackSpeed = parseFloat(elSpeedSelect.value);
  });

  elTimeline.addEventListener('input', () => {
    const prevTime = simulationTime;
    simulationTime = timeStart + (elTimeline.value / 1000) * (timeEnd - timeStart);
    if (simulationTime > prevTime) spawnPulses(prevTime);
    else { clearPulses(); edgeState.clear(); }
    updateDisplay();
  });

  elFilterMinBtc.addEventListener('change', () => {
    filterMinBtc = parseFloat(elFilterMinBtc.value) || 1;
    rebuildVisualization();
  });

  elFilterMinWallet.addEventListener('change', () => {
    filterMinWallet = parseFloat(elFilterMinWallet.value) || 0;
    rebuildVisualization();
  });

  function rebuildVisualization() {
    clearPulses();
    activatedEdges.clear();
    recentEdges.clear();
    edgeState.clear();
    const savedTime = simulationTime;
    applyFilters();
    buildGraph();
    buildWalletTimeline();
    layoutNodes3D();
    // Clear and rebuild meshes
    for (const [, mesh] of nodeMeshMap) { nodeGroup.remove(mesh); mesh.geometry?.dispose(); mesh.material?.dispose(); }
    nodeMeshMap.clear();
    for (const [, line] of wireMeshMap) { wireGroup.remove(line); line.geometry?.dispose(); line.material?.dispose(); }
    wireMeshMap.clear();
    createNodeMeshes();
    createWireMeshes();
    simulationTime = savedTime;
    initTimeline();
    updateDisplay();
  }

  // Sound toggle
  elBtnSound.addEventListener('click', () => {
    audioEnabled = !audioEnabled;
    if (audioEnabled) {
      elIconSoundOn.classList.remove('hidden');
      elIconSoundOff.classList.add('hidden');
    } else {
      elIconSoundOn.classList.add('hidden');
      elIconSoundOff.classList.remove('hidden');
    }
  });

  /* =========== RESIZE =========== */
  window.addEventListener('resize', () => {
    const w = container.clientWidth, h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    const res = new THREE.Vector2(w, h);
    for (const [, line] of wireMeshMap) {
      line.material.resolution.set(w, h);
    }
  });

  container.addEventListener('mousemove', onMouseMove);
  container.addEventListener('mouseleave', () => elTooltip.classList.add('hidden'));

  /* =========== INIT =========== */
  initThree();
  loadData().then(() => {
    requestAnimationFrame(animate);
  });

})();
