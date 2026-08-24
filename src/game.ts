import * as THREE from 'three';
import type { ActionEvent, PlayerState, RoomSnapshot, Vec3State } from './shared/protocol';

const PLAYER_HEIGHT = 1.62;
const HAY_RADIUS = 9.2;
const ARENA_RADIUS = 15.5;

interface GameCallbacks {
  onMove: (position: Vec3State, yaw: number) => void;
  onSearch: () => void;
  onAction: (type: 'sneeze' | 'magnet') => void;
  onGooseHit: () => void;
}

interface RemoteAvatar {
  group: THREE.Group;
  target: THREE.Vector3;
  targetYaw: number;
}

interface Burst {
  points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  velocities: THREE.Vector3[];
  age: number;
}

interface Pulse {
  mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  age: number;
  duration: number;
}

function mulberry32(seed: number): () => number {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function surfaceHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r >= HAY_RADIUS) return 0;
  const normalized = r / HAY_RADIUS;
  const mound = 4.7 * Math.pow(1 - normalized * normalized, 0.72);
  const ripple = Math.sin(x * 1.7) * Math.cos(z * 1.4) * 0.11 * (1 - normalized);
  return Math.max(0, mound + ripple);
}

function needlePosition(seed: number): THREE.Vector3 {
  const random = mulberry32(seed ^ 0x51e2d);
  const angle = random() * Math.PI * 2;
  const radius = 1.2 + Math.sqrt(random()) * 7.25;
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  return new THREE.Vector3(x, surfaceHeight(x, z) + 0.16, z);
}

export class HaywireGame {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(68, 1, 0.05, 140);
  readonly clock = new THREE.Clock();
  readonly localPosition = new THREE.Vector3(12, 0, 0);
  readonly remotes = new Map<string, RemoteAvatar>();
  readonly keys = new Set<string>();
  readonly bursts: Burst[] = [];
  readonly pulses: Pulse[] = [];
  readonly callbacks: GameCallbacks;
  readonly host: HTMLDivElement;
  readonly goose = new THREE.Group();
  readonly sun = new THREE.DirectionalLight(0xffe1a4, 4.7);
  readonly needle = new THREE.Group();
  readonly raycaster = new THREE.Raycaster();
  readonly lookDirection = new THREE.Vector3();
  readonly avatarPalette: Record<string, number> = {
    rust: 0xff6b35, lime: 0xd8ff53, sky: 0x57c7ff, pink: 0xff77b7, cream: 0xffe4ae, violet: 0x9b7bff,
  };

  yaw = Math.PI;
  pitch = -0.08;
  playing = false;
  localPlayerId = '';
  roundSeed = 0;
  virtualMove = new THREE.Vector2();
  lastMoveSent = 0;
  lastGooseHit = 0;
  footstep = 0;
  currentFov = 68;
  attractAngle = 0;

  constructor(host: HTMLDivElement, callbacks: GameCallbacks) {
    this.host = host;
    this.callbacks = callbacks;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.65));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    host.append(this.renderer.domElement);
    this.createWorld();
    this.bindEvents();
    this.animate();
  }

  private createWorld(): void {
    this.scene.fog = new THREE.FogExp2(0x96836b, 0.0115);
    this.createSky();
    this.createArena();
    this.createHaystack();
    this.createGoose();
    this.createNeedle();

    const hemi = new THREE.HemisphereLight(0xc7e2ff, 0x76512b, 3.05);
    this.scene.add(hemi);
    this.sun.position.set(-13, 24, 8);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -22;
    this.sun.shadow.camera.right = 22;
    this.sun.shadow.camera.top = 22;
    this.sun.shadow.camera.bottom = -22;
    this.sun.shadow.bias = -0.00035;
    this.scene.add(this.sun);

    const rim = new THREE.PointLight(0xff7b35, 95, 26, 2);
    rim.position.set(10, 8, -12);
    this.scene.add(rim);
  }

  private createSky(): void {
    const geometry = new THREE.SphereGeometry(90, 36, 18);
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        topColor: { value: new THREE.Color(0x65a8dc) },
        horizonColor: { value: new THREE.Color(0xf0bd78) },
        bottomColor: { value: new THREE.Color(0x403324) },
      },
      vertexShader: `varying vec3 vWorld; void main(){ vec4 world=modelMatrix*vec4(position,1.0); vWorld=world.xyz; gl_Position=projectionMatrix*viewMatrix*world; }`,
      fragmentShader: `varying vec3 vWorld; uniform vec3 topColor; uniform vec3 horizonColor; uniform vec3 bottomColor; void main(){ float h=normalize(vWorld).y; vec3 c=mix(horizonColor,topColor,smoothstep(0.0,.58,h)); c=mix(bottomColor,c,smoothstep(-.2,.05,h)); gl_FragColor=vec4(c,1.0); }`,
    });
    this.scene.add(new THREE.Mesh(geometry, material));

    const cloudMaterial = new THREE.MeshStandardMaterial({ color: 0xfff5df, roughness: 1, transparent: true, opacity: 0.68 });
    const random = mulberry32(22391);
    for (let i = 0; i < 13; i += 1) {
      const cloud = new THREE.Group();
      const pieces = 3 + Math.floor(random() * 4);
      for (let j = 0; j < pieces; j += 1) {
        const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(1.2 + random() * 1.5, 1), cloudMaterial);
        puff.position.set(j * 1.45, random() * 0.7, random() * 0.9);
        puff.scale.y = 0.55;
        cloud.add(puff);
      }
      const angle = random() * Math.PI * 2;
      const radius = 38 + random() * 25;
      cloud.position.set(Math.cos(angle) * radius, 15 + random() * 13, Math.sin(angle) * radius);
      cloud.rotation.y = -angle;
      cloud.scale.setScalar(0.8 + random() * 1.35);
      this.scene.add(cloud);
    }
  }

  private createArena(): void {
    const earth = new THREE.Mesh(
      new THREE.CylinderGeometry(18, 18.8, 0.6, 96),
      new THREE.MeshStandardMaterial({ color: 0x3b3224, roughness: 1, metalness: 0 }),
    );
    earth.position.y = -0.35;
    earth.receiveShadow = true;
    this.scene.add(earth);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(9.8, 17.7, 96),
      new THREE.MeshStandardMaterial({ color: 0x5c5139, roughness: 1, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.035;
    ring.receiveShadow = true;
    this.scene.add(ring);

    const postGeometry = new THREE.CylinderGeometry(0.12, 0.15, 2.35, 7);
    const postMaterial = new THREE.MeshStandardMaterial({ color: 0x2c2117, roughness: 0.95 });
    const railGeometry = new THREE.BoxGeometry(4.1, 0.12, 0.13);
    const rails = new THREE.InstancedMesh(railGeometry, postMaterial, 24);
    const posts = new THREE.InstancedMesh(postGeometry, postMaterial, 24);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < 24; i += 1) {
      const angle = (i / 24) * Math.PI * 2;
      matrix.makeRotationY(-angle);
      matrix.setPosition(Math.cos(angle) * 17.2, 1.05, Math.sin(angle) * 17.2);
      posts.setMatrixAt(i, matrix);
      const railMatrix = new THREE.Matrix4().makeRotationY(-angle - Math.PI / 2);
      railMatrix.setPosition(Math.cos(angle + Math.PI / 24) * 17.05, i % 2 ? 1.65 : 0.65, Math.sin(angle + Math.PI / 24) * 17.05);
      rails.setMatrixAt(i, railMatrix);
    }
    posts.castShadow = rails.castShadow = true;
    this.scene.add(posts, rails);

    const siloMaterial = new THREE.MeshStandardMaterial({ color: 0x262b28, roughness: 0.72, metalness: 0.45 });
    const silo = new THREE.Mesh(new THREE.CylinderGeometry(3.3, 3.6, 12, 32), siloMaterial);
    silo.position.set(-29, 5.9, -24);
    silo.castShadow = true;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(4, 2.5, 32), new THREE.MeshStandardMaterial({ color: 0x8f4c32, roughness: 0.8 }));
    roof.position.set(-29, 13.1, -24);
    this.scene.add(silo, roof);

    const mountains = new THREE.Group();
    const mountainMaterial = new THREE.MeshStandardMaterial({ color: 0x5a5b50, roughness: 1 });
    for (let i = 0; i < 18; i += 1) {
      const angle = (i / 18) * Math.PI * 2;
      const mountain = new THREE.Mesh(new THREE.ConeGeometry(9 + (i % 3) * 3, 12 + (i % 4) * 4, 5), mountainMaterial);
      mountain.position.set(Math.cos(angle) * 62, 3, Math.sin(angle) * 62);
      mountain.rotation.y = angle;
      mountains.add(mountain);
    }
    this.scene.add(mountains);

    const weedsGeometry = new THREE.BoxGeometry(0.025, 0.025, 0.8);
    const weedsMaterial = new THREE.MeshStandardMaterial({ color: 0x846c36, roughness: 1 });
    const weeds = new THREE.InstancedMesh(weedsGeometry, weedsMaterial, 1000);
    const random = mulberry32(81922);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 1000; i += 1) {
      const angle = random() * Math.PI * 2;
      const radius = 18.5 + random() * 34;
      dummy.position.set(Math.cos(angle) * radius, random() * 0.15, Math.sin(angle) * radius);
      dummy.rotation.set((random() - 0.5) * 0.8, random() * Math.PI, (random() - 0.5) * 0.8);
      dummy.scale.setScalar(0.7 + random() * 1.4);
      dummy.updateMatrix();
      weeds.setMatrixAt(i, dummy.matrix);
    }
    this.scene.add(weeds);
  }

  private createHaystack(): void {
    const geometry = new THREE.BoxGeometry(0.023, 0.023, 0.68);
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0.01,
      vertexColors: true,
      emissive: 0x7a3c0b,
      emissiveIntensity: 0.28,
    });
    const count = window.innerWidth < 700 ? 14000 : 30000;
    const hay = new THREE.InstancedMesh(geometry, material, count);
    const random = mulberry32(0x5eed123);
    const dummy = new THREE.Object3D();
    const colors = [new THREE.Color(0xe1a43b), new THREE.Color(0xb87423), new THREE.Color(0xf5c75d), new THREE.Color(0x986022), new THREE.Color(0xce8628)];
    for (let i = 0; i < count; i += 1) {
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random()) * HAY_RADIUS;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const height = surfaceHeight(x, z);
      const nearSurface = i < count * 0.82;
      const y = nearSurface ? height - random() * 0.58 : random() * height;
      dummy.position.set(x + (random() - 0.5) * 0.18, Math.max(0.045, y), z + (random() - 0.5) * 0.18);
      dummy.rotation.set((random() - 0.5) * 0.95, random() * Math.PI, (random() - 0.5) * 0.95);
      const scale = 0.72 + random() * 0.78;
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      hay.setMatrixAt(i, dummy.matrix);
      const color = colors[Math.floor(random() * colors.length)].clone().multiplyScalar(0.88 + random() * 0.24);
      hay.setColorAt(i, color);
    }
    hay.instanceMatrix.needsUpdate = true;
    if (hay.instanceColor) hay.instanceColor.needsUpdate = true;
    // The dense pile receives the arena shadow, but self-shadowing 30k crossed
    // slivers turns the surface into a black thicket on lower-end WebGL GPUs.
    hay.castShadow = false;
    hay.receiveShadow = true;
    this.scene.add(hay);

    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(8.67, 5),
      new THREE.MeshStandardMaterial({ color: 0x9e661f, roughness: 1, emissive: 0x291204, emissiveIntensity: 0.12 }),
    );
    core.scale.y = 0.42;
    core.position.y = 0.18;
    core.receiveShadow = true;
    this.scene.add(core);
  }

  private createNeedle(): void {
    const metal = new THREE.MeshPhysicalMaterial({
      color: 0xe8f5ff,
      metalness: 1,
      roughness: 0.12,
      clearcoat: 1,
      emissive: 0x8dc7df,
      emissiveIntensity: 0.22,
    });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.95, 10), metal);
    shaft.rotation.z = Math.PI / 2;
    shaft.castShadow = true;
    const eye = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.02, 8, 16), metal);
    eye.rotation.y = Math.PI / 2;
    eye.position.x = -0.48;
    const glintMaterial = new THREE.SpriteMaterial({ color: 0xc9f8ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending });
    const glint = new THREE.Sprite(glintMaterial);
    glint.scale.set(0.35, 0.35, 0.35);
    glint.position.x = 0.28;
    glint.name = 'glint';
    this.needle.add(shaft, eye, glint);
    this.needle.rotation.set(0.15, 0.3, -0.18);
    this.needle.position.copy(needlePosition(0));
    this.scene.add(this.needle);
  }

  private createGoose(): void {
    const white = new THREE.MeshStandardMaterial({ color: 0xf0eee1, roughness: 0.8 });
    const orange = new THREE.MeshStandardMaterial({ color: 0xff8b22, roughness: 0.72 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x11110f, roughness: 1 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.43, 0.75, 5, 10), white);
    body.rotation.z = Math.PI / 2;
    body.castShadow = true;
    const neck = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.75, 4, 8), white);
    neck.position.set(0.53, 0.61, 0);
    neck.rotation.z = -0.22;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 12), white);
    head.position.set(0.68, 1.12, 0);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.42, 8), orange);
    beak.position.set(0.99, 1.1, 0);
    beak.rotation.z = -Math.PI / 2;
    const eyeA = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), dark);
    eyeA.position.set(0.79, 1.19, 0.2);
    const eyeB = eyeA.clone(); eyeB.position.z = -0.2;
    const legA = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.52, 6), orange);
    legA.position.set(-0.2, -0.65, 0.18);
    const legB = legA.clone(); legB.position.z = -0.18;
    const wingA = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.44, 4, 7), white);
    wingA.position.set(-0.12, 0.08, 0.4); wingA.rotation.z = Math.PI / 2.3;
    const wingB = wingA.clone(); wingB.position.z = -0.4;
    this.goose.add(body, neck, head, beak, eyeA, eyeB, legA, legB, wingA, wingB);
    this.goose.scale.setScalar(1.12);
    this.scene.add(this.goose);
  }

  private bindEvents(): void {
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (event) => this.keys.add(event.code));
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
    document.addEventListener('mousemove', (event) => {
      if (!this.playing || document.pointerLockElement !== this.renderer.domElement) return;
      this.yaw -= event.movementX * 0.0018;
      this.pitch = THREE.MathUtils.clamp(this.pitch - event.movementY * 0.0016, -1.28, 1.18);
    });
    this.renderer.domElement.addEventListener('mousedown', (event) => {
      if (!this.playing) return;
      if (document.pointerLockElement !== this.renderer.domElement) return this.requestControl();
      if (event.button === 0) {
        this.callbacks.onSearch();
        this.createPulse(this.localPosition, 0xf4f0da, 1.1);
      }
    });
  }

  private resize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, window.innerWidth < 700 ? 1.25 : 1.65));
  }

  enterRoom(room: RoomSnapshot, playerId: string): void {
    this.playing = true;
    this.localPlayerId = playerId;
    this.roundSeed = room.seed;
    const local = room.players.find((player) => player.id === playerId);
    if (local) {
      this.localPosition.set(local.position.x, 0, local.position.z);
      this.yaw = local.yaw;
    }
    this.setNeedle(room.seed);
    this.clearRemotes();
    room.players.forEach((player) => this.upsertPlayer(player));
  }

  leaveRoom(): void {
    this.playing = false;
    this.localPlayerId = '';
    this.clearRemotes();
    this.releaseControl();
  }

  syncRoom(room: RoomSnapshot): void {
    if (room.seed !== this.roundSeed) this.setNeedle(room.seed);
    const ids = new Set(room.players.map((player) => player.id));
    for (const id of this.remotes.keys()) if (!ids.has(id)) this.removePlayer(id);
    room.players.forEach((player) => this.upsertPlayer(player));
  }

  resetRound(seed: number, players: PlayerState[], localPlayerId: string): void {
    this.setNeedle(seed);
    const local = players.find((player) => player.id === localPlayerId);
    if (local) this.localPosition.set(local.position.x, 0, local.position.z);
    this.clearRemotes();
    players.forEach((player) => this.upsertPlayer(player));
    this.createBurst(new THREE.Vector3(0, 3, 0), 260, 0xdfff48);
  }

  private setNeedle(seed: number): void {
    this.roundSeed = seed;
    this.needle.position.copy(needlePosition(seed));
    const random = mulberry32(seed);
    this.needle.rotation.set((random() - 0.5) * 0.65, random() * Math.PI, (random() - 0.5) * 0.5);
    this.needle.visible = true;
  }

  upsertPlayer(player: PlayerState): void {
    if (player.id === this.localPlayerId) return;
    const current = this.remotes.get(player.id);
    const position = new THREE.Vector3(player.position.x, surfaceHeight(player.position.x, player.position.z), player.position.z);
    if (current) {
      current.target.copy(position);
      current.targetYaw = player.yaw;
      return;
    }
    const group = this.createAvatar(player);
    group.position.copy(position);
    this.scene.add(group);
    this.remotes.set(player.id, { group, target: position.clone(), targetYaw: player.yaw });
  }

  movePlayer(player: Pick<PlayerState, 'id' | 'position' | 'yaw'>): void {
    const remote = this.remotes.get(player.id);
    if (!remote) return;
    remote.target.set(player.position.x, surfaceHeight(player.position.x, player.position.z), player.position.z);
    remote.targetYaw = player.yaw;
  }

  removePlayer(id: string): void {
    const remote = this.remotes.get(id);
    if (!remote) return;
    this.scene.remove(remote.group);
    remote.group.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Sprite) {
        object.geometry?.dispose();
        if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
        else object.material?.dispose();
      }
    });
    this.remotes.delete(id);
  }

  private clearRemotes(): void {
    [...this.remotes.keys()].forEach((id) => this.removePlayer(id));
  }

  private createAvatar(player: PlayerState): THREE.Group {
    const group = new THREE.Group();
    const suit = new THREE.MeshStandardMaterial({ color: this.avatarPalette[player.avatar] ?? 0xff6b35, roughness: 0.82 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xe7aa76, roughness: 0.92 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x22231f, roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.65, 4, 8), suit);
    body.position.y = 0.83;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 10), skin);
    head.position.y = 1.62;
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.06, 16), dark);
    brim.position.y = 1.83;
    const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.3, 0.24, 12), suit);
    hat.position.y = 1.95;
    const armGeometry = new THREE.CapsuleGeometry(0.08, 0.55, 3, 7);
    const armA = new THREE.Mesh(armGeometry, suit); armA.position.set(0.39, 0.93, 0); armA.rotation.z = -0.18;
    const armB = armA.clone(); armB.position.x = -0.39; armB.rotation.z = 0.18;
    const legGeometry = new THREE.CapsuleGeometry(0.09, 0.55, 3, 7);
    const legA = new THREE.Mesh(legGeometry, dark); legA.position.set(0.15, 0.22, 0);
    const legB = legA.clone(); legB.position.x = -0.15;
    group.add(body, head, brim, hat, armA, armB, legA, legB, this.createNameTag(player.name));
    group.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; });
    return group;
  }

  private createNameTag(name: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 96;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'rgba(8,9,7,.78)';
    context.fillRect(0, 7, 512, 76);
    context.strokeStyle = '#dfff48'; context.lineWidth = 3; context.strokeRect(3, 10, 506, 70);
    context.fillStyle = '#ffffff'; context.font = '700 34px Manrope, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
    context.fillText(name.slice(0, 18), 256, 47);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
    sprite.position.y = 2.35; sprite.scale.set(2.65, 0.5, 1); sprite.renderOrder = 10;
    return sprite;
  }

  requestControl(): void {
    if (this.playing && window.matchMedia('(pointer:fine)').matches) {
      void this.renderer.domElement.requestPointerLock().catch(() => undefined);
    }
  }

  releaseControl(): void {
    if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
  }

  setVirtualMove(x: number, y: number): void {
    this.virtualMove.set(x, y);
  }

  playLocalAction(type: 'sneeze' | 'magnet'): void {
    if (type === 'sneeze') {
      this.createBurst(this.localPosition.clone().add(new THREE.Vector3(0, 1.1, 0)), 150, 0xe3ae4c);
      document.body.animate([
        { transform: 'translate(0,0)' }, { transform: 'translate(-6px,3px)' }, { transform: 'translate(5px,-3px)' }, { transform: 'translate(0,0)' },
      ], { duration: 420, iterations: 1 });
    } else this.createPulse(this.localPosition, 0xdfff48, 3.8);
  }

  playNetworkAction(action: ActionEvent): void {
    if (action.type === 'found') {
      this.needle.visible = false;
      if (action.position) this.createBurst(new THREE.Vector3(action.position.x, 2.4, action.position.z), 260, 0xdfff48);
      return;
    }
    if (action.playerId === this.localPlayerId || !action.position) return;
    const position = new THREE.Vector3(action.position.x, surfaceHeight(action.position.x, action.position.z) + 1, action.position.z);
    if (action.type === 'sneeze') this.createBurst(position, 120, 0xe3ae4c);
    if (action.type === 'magnet') this.createPulse(position, 0xdfff48, 3.8);
  }

  private createBurst(origin: THREE.Vector3, count: number, color: number): void {
    const positions = new Float32Array(count * 3);
    const velocities: THREE.Vector3[] = [];
    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = origin.x;
      positions[i * 3 + 1] = origin.y;
      positions[i * 3 + 2] = origin.z;
      const direction = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.25, Math.random() - 0.5).normalize();
      velocities.push(direction.multiplyScalar(2.8 + Math.random() * 6.5));
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({ color, size: 0.13, transparent: true, opacity: 0.95, depthWrite: false });
    const points = new THREE.Points(geometry, material);
    this.scene.add(points);
    this.bursts.push({ points, velocities, age: 0 });
  }

  private createPulse(origin: THREE.Vector3, color: number, maxScale: number): void {
    const geometry = new THREE.RingGeometry(0.55, 0.61, 64);
    const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(origin.x, surfaceHeight(origin.x, origin.z) + 0.11, origin.z);
    mesh.userData.maxScale = maxScale;
    this.scene.add(mesh);
    this.pulses.push({ mesh, age: 0, duration: 1.2 });
  }

  private updateBursts(delta: number): void {
    for (let index = this.bursts.length - 1; index >= 0; index -= 1) {
      const burst = this.bursts[index];
      burst.age += delta;
      const attribute = burst.points.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < burst.velocities.length; i += 1) {
        const velocity = burst.velocities[i];
        velocity.y -= delta * 5.3;
        attribute.array[i * 3] += velocity.x * delta;
        attribute.array[i * 3 + 1] += velocity.y * delta;
        attribute.array[i * 3 + 2] += velocity.z * delta;
        velocity.multiplyScalar(0.988);
      }
      attribute.needsUpdate = true;
      burst.points.material.opacity = Math.max(0, 1 - burst.age / 1.7);
      if (burst.age > 1.8) {
        this.scene.remove(burst.points); burst.points.geometry.dispose(); burst.points.material.dispose(); this.bursts.splice(index, 1);
      }
    }
    for (let index = this.pulses.length - 1; index >= 0; index -= 1) {
      const pulse = this.pulses[index];
      pulse.age += delta;
      const progress = pulse.age / pulse.duration;
      const scale = 1 + progress * Number(pulse.mesh.userData.maxScale);
      pulse.mesh.scale.setScalar(scale);
      pulse.mesh.material.opacity = Math.max(0, 0.85 * (1 - progress));
      if (progress >= 1) {
        this.scene.remove(pulse.mesh); pulse.mesh.geometry.dispose(); pulse.mesh.material.dispose(); this.pulses.splice(index, 1);
      }
    }
  }

  private updatePlayer(delta: number, elapsed: number): void {
    const forwardInput = (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) - (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0) - this.virtualMove.y;
    const sideInput = (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0) + this.virtualMove.x;
    const input = new THREE.Vector2(sideInput, forwardInput);
    const moving = input.lengthSq() > 0.01;
    if (input.length() > 1) input.normalize();
    const sprinting = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const speed = sprinting ? 6.2 : 3.65;
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.localPosition.addScaledVector(forward, input.y * speed * delta).addScaledVector(right, input.x * speed * delta);
    const radius = Math.hypot(this.localPosition.x, this.localPosition.z);
    if (radius > ARENA_RADIUS) this.localPosition.multiplyScalar(ARENA_RADIUS / radius);
    const ground = surfaceHeight(this.localPosition.x, this.localPosition.z);
    this.localPosition.y = ground;
    this.footstep += moving ? delta * (sprinting ? 14 : 9) : delta * 2;
    const bob = moving ? Math.sin(this.footstep) * 0.045 : Math.sin(elapsed * 1.8) * 0.014;
    this.camera.position.set(this.localPosition.x, ground + PLAYER_HEIGHT + bob, this.localPosition.z);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.pitch, this.yaw, moving ? Math.sin(this.footstep * 0.5) * 0.006 : 0);
    const targetFov = sprinting && moving ? 75 : 68;
    this.currentFov = THREE.MathUtils.lerp(this.currentFov, targetFov, 1 - Math.exp(-delta * 7));
    this.camera.fov = this.currentFov;
    this.camera.updateProjectionMatrix();

    if (elapsed * 1000 - this.lastMoveSent > 70) {
      this.callbacks.onMove({ x: this.localPosition.x, y: 0, z: this.localPosition.z }, this.yaw);
      this.lastMoveSent = elapsed * 1000;
    }
  }

  private updateGoose(delta: number, elapsed: number): void {
    const angle = elapsed * 0.24;
    const radius = 9.8 + Math.sin(elapsed * 0.7) * 1.25;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    this.goose.position.set(x, surfaceHeight(x, z) + 0.8 + Math.abs(Math.sin(elapsed * 5.5)) * 0.08, z);
    this.goose.rotation.y = -angle + Math.PI / 2 + Math.sin(elapsed * 1.4) * 0.25;
    const wings = [this.goose.children[8], this.goose.children[9]];
    wings.forEach((wing, index) => { wing.rotation.x = Math.sin(elapsed * 8) * 0.55 * (index ? -1 : 1); });
    if (this.playing && this.goose.position.distanceTo(this.localPosition) < 1.45 && elapsed - this.lastGooseHit > 4) {
      this.lastGooseHit = elapsed;
      const push = this.localPosition.clone().sub(this.goose.position).setY(0).normalize().multiplyScalar(2.3);
      this.localPosition.add(push);
      this.callbacks.onGooseHit();
      document.body.animate([{ filter: 'none' }, { filter: 'sepia(1) saturate(3)', transform: 'rotate(1.2deg)' }, { filter: 'none' }], { duration: 480 });
    }
    this.goose.position.y += Math.sin(elapsed * 10) * 0.018 * delta;
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    const delta = Math.min(this.clock.getDelta(), 0.05);
    const elapsed = this.clock.elapsedTime;
    if (this.playing) this.updatePlayer(delta, elapsed);
    else {
      this.attractAngle += delta * 0.065;
      const radius = 15.5 + Math.sin(elapsed * 0.17) * 1.7;
      this.camera.position.set(Math.cos(this.attractAngle) * radius, 6.7 + Math.sin(elapsed * 0.22), Math.sin(this.attractAngle) * radius);
      this.camera.lookAt(0, 2.2, 0);
    }
    this.updateGoose(delta, elapsed);
    this.updateBursts(delta);
    for (const remote of this.remotes.values()) {
      remote.group.position.lerp(remote.target, 1 - Math.exp(-delta * 9));
      let angleDelta = remote.targetYaw - remote.group.rotation.y;
      angleDelta = Math.atan2(Math.sin(angleDelta), Math.cos(angleDelta));
      remote.group.rotation.y += angleDelta * (1 - Math.exp(-delta * 8));
      remote.group.children[4].rotation.x = Math.sin(elapsed * 7 + remote.group.position.x) * 0.3;
      remote.group.children[5].rotation.x = -Math.sin(elapsed * 7 + remote.group.position.x) * 0.3;
    }
    const glint = this.needle.getObjectByName('glint') as THREE.Sprite | undefined;
    if (glint) {
      const pulse = 0.45 + Math.pow(Math.max(0, Math.sin(elapsed * 2.4)), 12) * 1.2;
      glint.material.opacity = pulse;
      glint.scale.setScalar(0.22 + pulse * 0.22);
    }
    this.sun.position.x = -13 + Math.sin(elapsed * 0.03) * 3;
    this.renderer.render(this.scene, this.camera);
  };
}
