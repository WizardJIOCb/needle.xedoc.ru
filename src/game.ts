import * as THREE from 'three';
import type { ActionEvent, PlayerState, RoomSnapshot, Vec3State } from './shared/protocol';
import { HAY_COUNT, HAY_RADIUS, mulberry32, needlePosition, surfaceHeight } from './shared/hay';

const PLAYER_HEIGHT = 1.62;
const ARENA_RADIUS = 15.5;
const STRAW_HALF_LENGTH = 0.36;
const STRAW_COLLIDER_RADIUS = 0.028;
const STRAW_CELL_SIZE = 0.58;
const MAX_ACTIVE_STRAWS = 640;

interface GameCallbacks {
  onMove: (position: Vec3State, yaw: number) => void;
  onSearch: () => void;
  onPullStraw: (instanceId: number) => void;
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

function fieldHeight(x: number, z: number): number {
  const radius = Math.hypot(x, z);
  const outside = THREE.MathUtils.smoothstep(radius, 17.5, 27);
  const rolling = Math.sin(x * 0.115) * Math.cos(z * 0.09) * 0.34
    + Math.sin((x + z) * 0.047) * 0.22;
  return -0.08 - outside * 0.36 + rolling * outside;
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
  readonly hayOriginalMatrices: THREE.Matrix4[] = [];
  readonly pulledStrawIds = new Set<number>();
  readonly activeStrawIds = new Set<number>();
  readonly strawSpatial = new Map<number, Set<number>>();
  readonly strawPositions = new Float32Array(HAY_COUNT * 3);
  readonly strawOriginalPositions = new Float32Array(HAY_COUNT * 3);
  readonly strawQuaternions = new Float32Array(HAY_COUNT * 4);
  readonly strawOriginalQuaternions = new Float32Array(HAY_COUNT * 4);
  readonly strawScales = new Float32Array(HAY_COUNT);
  readonly strawOriginalScales = new Float32Array(HAY_COUNT);
  readonly strawVelocities = new Float32Array(HAY_COUNT * 3);
  readonly strawSpins = new Float32Array(HAY_COUNT * 3);
  readonly strawSleepTimers = new Float32Array(HAY_COUNT);
  readonly strawActiveAges = new Float32Array(HAY_COUNT);
  readonly strawAwake = new Uint8Array(HAY_COUNT);
  readonly strawContacts = new Uint8Array(HAY_COUNT);
  readonly strawCells = new Int32Array(HAY_COUNT).fill(-1);
  readonly dirtyStrawIds = new Set<number>();
  readonly strawMatrix = new THREE.Matrix4();
  readonly strawMatrixPosition = new THREE.Vector3();
  readonly strawMatrixQuaternion = new THREE.Quaternion();
  readonly strawMatrixScale = new THREE.Vector3();

  hay!: THREE.InstancedMesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
  hayGeometry!: THREE.CylinderGeometry;

  yaw = Math.PI;
  pitch = -0.2;
  playing = false;
  localPlayerId = '';
  roundSeed = 0;
  virtualMove = new THREE.Vector2();
  lastMoveSent = 0;
  lastGooseHit = 0;
  footstep = 0;
  currentFov = 68;
  attractAngle = 0;
  pulling = false;
  lastInteraction = 0;
  collisionWakeBudget = 0;

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
    const fieldGeometry = new THREE.PlaneGeometry(158, 158, 96, 96);
    fieldGeometry.rotateX(-Math.PI / 2);
    const fieldPositions = fieldGeometry.getAttribute('position') as THREE.BufferAttribute;
    for (let index = 0; index < fieldPositions.count; index += 1) {
      const x = fieldPositions.getX(index);
      const z = fieldPositions.getZ(index);
      fieldPositions.setY(index, fieldHeight(x, z));
    }
    fieldPositions.needsUpdate = true;
    const fieldColors = new Float32Array(fieldPositions.count * 3);
    const dryField = new THREE.Color(0x71662f);
    const greenField = new THREE.Color(0x3d5427);
    const fieldColor = new THREE.Color();
    for (let index = 0; index < fieldPositions.count; index += 1) {
      const x = fieldPositions.getX(index);
      const z = fieldPositions.getZ(index);
      const patch = THREE.MathUtils.clamp(0.48 + Math.sin(x * 0.19) * 0.2 + Math.cos(z * 0.16) * 0.18, 0, 1);
      fieldColor.copy(greenField).lerp(dryField, patch).toArray(fieldColors, index * 3);
    }
    fieldGeometry.setAttribute('color', new THREE.BufferAttribute(fieldColors, 3));
    fieldGeometry.computeVertexNormals();
    const field = new THREE.Mesh(
      fieldGeometry,
      new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 1, metalness: 0 }),
    );
    field.receiveShadow = true;
    this.scene.add(field);

    const grassGeometry = new THREE.ConeGeometry(0.028, 0.42, 3, 1);
    const grassMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      vertexColors: true,
      side: THREE.DoubleSide,
      emissive: 0x20310f,
      emissiveIntensity: 0.24,
    });
    const grassCount = 36_000;
    const grass = new THREE.InstancedMesh(grassGeometry, grassMaterial, grassCount);
    const grassRandom = mulberry32(0x6a55c0);
    const grassDummy = new THREE.Object3D();
    const grassColors = [0x657b31, 0x78883b, 0x536c2b, 0x8a8439, 0x6f7130].map((color) => new THREE.Color(color));
    for (let index = 0; index < grassCount; index += 1) {
      const angle = grassRandom() * Math.PI * 2;
      const radius = Math.sqrt(18.2 * 18.2 + grassRandom() * (77 * 77 - 18.2 * 18.2));
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const heightScale = 0.58 + grassRandom() * 1.18;
      grassDummy.position.set(x, fieldHeight(x, z) + 0.21 * heightScale, z);
      grassDummy.rotation.set((grassRandom() - 0.5) * 0.22, grassRandom() * Math.PI * 2, (grassRandom() - 0.5) * 0.18);
      grassDummy.scale.set(0.7 + grassRandom() * 0.75, heightScale, 0.7 + grassRandom() * 0.75);
      grassDummy.updateMatrix();
      grass.setMatrixAt(index, grassDummy.matrix);
      grass.setColorAt(index, grassColors[Math.floor(grassRandom() * grassColors.length)]);
    }
    grass.instanceMatrix.needsUpdate = true;
    if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
    grass.frustumCulled = false;
    this.scene.add(grass);

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
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      dummy.position.set(x, fieldHeight(x, z) + 0.42, z);
      dummy.rotation.set((random() - 0.5) * 0.8, random() * Math.PI, (random() - 0.5) * 0.8);
      dummy.scale.setScalar(0.7 + random() * 1.4);
      dummy.updateMatrix();
      weeds.setMatrixAt(i, dummy.matrix);
    }
    this.scene.add(weeds);
  }

  private createHaystack(): void {
    const geometry = new THREE.CylinderGeometry(0.012, 0.018, 0.72, 5, 1);
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0.01,
      vertexColors: true,
      emissive: 0x7a3c0b,
      emissiveIntensity: 0.28,
    });
    const hay = new THREE.InstancedMesh(geometry, material, HAY_COUNT);
    const random = mulberry32(0x5eed123);
    const dummy = new THREE.Object3D();
    const colors = [new THREE.Color(0xe1a43b), new THREE.Color(0xb87423), new THREE.Color(0xf5c75d), new THREE.Color(0x986022), new THREE.Color(0xce8628)];
    for (let i = 0; i < HAY_COUNT; i += 1) {
      const angle = random() * Math.PI * 2;
      const radius = Math.sqrt(random()) * HAY_RADIUS;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const height = surfaceHeight(x, z);
      const nearSurface = random() < 0.52;
      const y = nearSurface ? height - random() * 0.46 : 0.06 + random() * Math.max(0.08, height - 0.06);
      dummy.position.set(x + (random() - 0.5) * 0.18, Math.max(0.045, y), z + (random() - 0.5) * 0.18);
      dummy.rotation.set(Math.PI / 2 + (random() - 0.5) * 0.9, random() * Math.PI, (random() - 0.5) * 1.1);
      const scale = 0.72 + random() * 0.78;
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      hay.setMatrixAt(i, dummy.matrix);
      this.hayOriginalMatrices.push(dummy.matrix.clone());
      const positionOffset = i * 3;
      const quaternionOffset = i * 4;
      this.strawPositions[positionOffset] = this.strawOriginalPositions[positionOffset] = dummy.position.x;
      this.strawPositions[positionOffset + 1] = this.strawOriginalPositions[positionOffset + 1] = dummy.position.y;
      this.strawPositions[positionOffset + 2] = this.strawOriginalPositions[positionOffset + 2] = dummy.position.z;
      this.strawQuaternions[quaternionOffset] = this.strawOriginalQuaternions[quaternionOffset] = dummy.quaternion.x;
      this.strawQuaternions[quaternionOffset + 1] = this.strawOriginalQuaternions[quaternionOffset + 1] = dummy.quaternion.y;
      this.strawQuaternions[quaternionOffset + 2] = this.strawOriginalQuaternions[quaternionOffset + 2] = dummy.quaternion.z;
      this.strawQuaternions[quaternionOffset + 3] = this.strawOriginalQuaternions[quaternionOffset + 3] = dummy.quaternion.w;
      this.strawScales[i] = this.strawOriginalScales[i] = scale;
      const color = colors[Math.floor(random() * colors.length)].clone().multiplyScalar(0.88 + random() * 0.24);
      hay.setColorAt(i, color);
    }
    hay.instanceMatrix.needsUpdate = true;
    if (hay.instanceColor) hay.instanceColor.needsUpdate = true;
    // The dense pile receives the arena shadow, but self-shadowing 36k crossed
    // slivers turns the surface into a black thicket on lower-end WebGL GPUs.
    hay.castShadow = false;
    hay.receiveShadow = true;
    hay.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    hay.frustumCulled = false;
    this.scene.add(hay);
    this.hay = hay;
    this.hayGeometry = geometry;
    for (let instanceId = 0; instanceId < HAY_COUNT; instanceId += 1) this.addStrawToSpatial(instanceId);
  }

  private createNeedle(): void {
    const metal = new THREE.MeshPhysicalMaterial({
      color: 0xe8f5ff,
      metalness: 1,
      roughness: 0.12,
      clearcoat: 1,
      emissive: 0x8dc7df,
      emissiveIntensity: 0.08,
    });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.011, 0.48, 8), metal);
    shaft.rotation.z = Math.PI / 2;
    shaft.castShadow = true;
    const eye = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.006, 7, 14), metal);
    eye.rotation.y = Math.PI / 2;
    eye.position.x = -0.25;
    const glintMaterial = new THREE.SpriteMaterial({ color: 0xc9f8ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending });
    const glint = new THREE.Sprite(glintMaterial);
    glint.scale.set(0.07, 0.07, 0.07);
    glint.position.x = 0.12;
    glint.name = 'glint';
    const hitbox = new THREE.Mesh(
      new THREE.BoxGeometry(0.58, 0.12, 0.12),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    hitbox.name = 'needle-hitbox';
    this.needle.add(shaft, eye, glint, hitbox);
    this.needle.rotation.set(0.15, 0.3, -0.18);
    const initial = needlePosition(0);
    this.needle.position.set(initial.x, initial.y, initial.z);
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
      if (document.pointerLockElement !== this.renderer.domElement) {
        this.pulling = false;
        return this.requestControl();
      }
      if (event.button === 0) {
        this.pulling = true;
        this.interact();
      }
    });
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== this.renderer.domElement) this.pulling = false;
    });
    window.addEventListener('mouseup', (event) => { if (event.button === 0) this.pulling = false; });
    window.addEventListener('blur', () => { this.pulling = false; });
  }

  private resize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, window.innerWidth < 700 ? 1.25 : 1.65));
  }

  enterRoom(room: RoomSnapshot, playerId: string): void {
    this.playing = true;
    this.pulling = false;
    this.localPlayerId = playerId;
    this.roundSeed = room.seed;
    const local = room.players.find((player) => player.id === playerId);
    if (local) {
      this.localPosition.set(local.position.x, 0, local.position.z);
      this.yaw = local.yaw;
    }
    this.placeCameraAtPlayer();
    this.resetHay();
    this.setNeedle(room.seed);
    room.pulledStraws.forEach((instanceId) => this.pullStraw(instanceId, undefined, false));
    this.clearRemotes();
    room.players.forEach((player) => this.upsertPlayer(player));
  }

  leaveRoom(): void {
    this.playing = false;
    this.pulling = false;
    this.localPlayerId = '';
    this.clearRemotes();
    this.resetHay();
    this.releaseControl();
  }

  syncRoom(room: RoomSnapshot): void {
    if (room.seed !== this.roundSeed) {
      this.resetHay();
      this.setNeedle(room.seed);
    }
    room.pulledStraws.forEach((instanceId) => this.pullStraw(instanceId, undefined, false));
    const ids = new Set(room.players.map((player) => player.id));
    for (const id of this.remotes.keys()) if (!ids.has(id)) this.removePlayer(id);
    room.players.forEach((player) => this.upsertPlayer(player));
  }

  resetRound(seed: number, players: PlayerState[], localPlayerId: string, pulledStraws: number[] = []): void {
    this.resetHay();
    this.setNeedle(seed);
    pulledStraws.forEach((instanceId) => this.pullStraw(instanceId, undefined, false));
    const local = players.find((player) => player.id === localPlayerId);
    if (local) this.localPosition.set(local.position.x, 0, local.position.z);
    this.placeCameraAtPlayer();
    this.clearRemotes();
    players.forEach((player) => this.upsertPlayer(player));
    this.createBurst(new THREE.Vector3(0, 3, 0), 260, 0xdfff48);
  }

  private setNeedle(seed: number): void {
    this.roundSeed = seed;
    const position = needlePosition(seed);
    this.needle.position.set(position.x, position.y, position.z);
    const random = mulberry32(seed);
    this.needle.rotation.set((random() - 0.5) * 0.65, random() * Math.PI, (random() - 0.5) * 0.5);
    this.needle.visible = true;
  }

  private placeCameraAtPlayer(): void {
    const ground = surfaceHeight(this.localPosition.x, this.localPosition.z);
    this.localPosition.y = ground;
    this.camera.position.set(this.localPosition.x, ground + PLAYER_HEIGHT, this.localPosition.z);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    this.camera.updateMatrixWorld(true);
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

  interact(): void {
    if (!this.playing || performance.now() - this.lastInteraction < 95) return;
    this.lastInteraction = performance.now();
    this.camera.updateMatrixWorld(true);
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const reach = 7.5;
    this.raycaster.far = reach;
    const hit = this.raycaster.intersectObject(this.needle, true)[0];
    const approximate = this.approximateStrawHit(reach);

    if (approximate && (!hit || approximate.distance < hit.distance)) {
      this.callbacks.onPullStraw(approximate.instanceId);
      return;
    }
    if (!hit || hit.distance > reach) return;
    this.callbacks.onSearch();
    this.createPulse(this.localPosition, 0xf4f0da, 1.1);
  }

  private approximateStrawHit(maxDistance: number): { instanceId: number; distance: number } | null {
    const origin = this.raycaster.ray.origin;
    const direction = this.raycaster.ray.direction;
    let bestDistance = maxDistance;
    let bestInstance = -1;
    for (let instanceId = 0; instanceId < HAY_COUNT; instanceId += 1) {
      if (this.pulledStrawIds.has(instanceId)) continue;
      const offset = instanceId * 3;
      const x = this.strawPositions[offset] - origin.x;
      const y = this.strawPositions[offset + 1] - origin.y;
      const z = this.strawPositions[offset + 2] - origin.z;
      const distance = x * direction.x + y * direction.y + z * direction.z;
      if (distance < 0.15 || distance >= maxDistance) continue;
      const perpendicularSq = x * x + y * y + z * z - distance * distance;
      if (distance >= bestDistance) continue;
      if (perpendicularSq <= 0.09) {
        bestDistance = distance;
        bestInstance = instanceId;
      }
    }
    return bestInstance >= 0 ? { instanceId: bestInstance, distance: bestDistance } : null;
  }

  private strawCellKey(x: number, y: number, z: number): number {
    return this.strawCellKeyFromIndices(
      Math.floor(x / STRAW_CELL_SIZE),
      Math.floor(y / STRAW_CELL_SIZE),
      Math.floor(z / STRAW_CELL_SIZE),
    );
  }

  private strawCellKeyFromIndices(x: number, y: number, z: number): number {
    return ((x + 128) & 0xff) | (((z + 128) & 0xff) << 8) | (((y + 32) & 0x7f) << 16);
  }

  private addStrawToSpatial(instanceId: number): void {
    const offset = instanceId * 3;
    const key = this.strawCellKey(
      this.strawPositions[offset],
      this.strawPositions[offset + 1],
      this.strawPositions[offset + 2],
    );
    let bucket = this.strawSpatial.get(key);
    if (!bucket) {
      bucket = new Set<number>();
      this.strawSpatial.set(key, bucket);
    }
    bucket.add(instanceId);
    this.strawCells[instanceId] = key;
  }

  private updateStrawSpatial(instanceId: number): void {
    const offset = instanceId * 3;
    const nextKey = this.strawCellKey(
      this.strawPositions[offset],
      this.strawPositions[offset + 1],
      this.strawPositions[offset + 2],
    );
    const previousKey = this.strawCells[instanceId];
    if (nextKey === previousKey) return;
    const previous = this.strawSpatial.get(previousKey);
    previous?.delete(instanceId);
    if (previous?.size === 0) this.strawSpatial.delete(previousKey);
    let next = this.strawSpatial.get(nextKey);
    if (!next) {
      next = new Set<number>();
      this.strawSpatial.set(nextKey, next);
    }
    next.add(instanceId);
    this.strawCells[instanceId] = nextKey;
  }

  private writeStrawMatrix(instanceId: number): void {
    const positionOffset = instanceId * 3;
    const quaternionOffset = instanceId * 4;
    this.strawMatrixPosition.fromArray(this.strawPositions, positionOffset);
    this.strawMatrixQuaternion.fromArray(this.strawQuaternions, quaternionOffset);
    this.strawMatrixScale.setScalar(this.strawScales[instanceId]);
    this.strawMatrix.compose(this.strawMatrixPosition, this.strawMatrixQuaternion, this.strawMatrixScale);
    this.hay.setMatrixAt(instanceId, this.strawMatrix);
  }

  private activateStraw(instanceId: number): void {
    if (this.strawAwake[instanceId]) return;
    if (this.activeStrawIds.size >= MAX_ACTIVE_STRAWS) this.sleepOldestStraw();
    this.strawAwake[instanceId] = 1;
    this.strawSleepTimers[instanceId] = 0;
    this.strawActiveAges[instanceId] = 0;
    this.activeStrawIds.add(instanceId);
    this.dirtyStrawIds.add(instanceId);
  }

  private sleepStraw(instanceId: number): void {
    this.strawAwake[instanceId] = 0;
    this.activeStrawIds.delete(instanceId);
    const offset = instanceId * 3;
    this.strawVelocities.fill(0, offset, offset + 3);
    this.strawSpins.fill(0, offset, offset + 3);
    this.strawSleepTimers[instanceId] = 0;
    this.dirtyStrawIds.add(instanceId);
  }

  private sleepOldestStraw(): void {
    let fallback = -1;
    for (const instanceId of this.activeStrawIds) {
      fallback = instanceId;
      if (!this.pulledStrawIds.has(instanceId)) break;
    }
    if (fallback >= 0) this.sleepStraw(fallback);
  }

  private wakeUnsupportedStraws(sourceId: number): void {
    const sourceOffset = sourceId * 3;
    const sourceX = this.strawPositions[sourceOffset];
    const sourceY = this.strawPositions[sourceOffset + 1];
    const sourceZ = this.strawPositions[sourceOffset + 2];
    const centerX = Math.floor(sourceX / STRAW_CELL_SIZE);
    const centerY = Math.floor(sourceY / STRAW_CELL_SIZE);
    const centerZ = Math.floor(sourceZ / STRAW_CELL_SIZE);
    let woken = 0;
    for (let cellY = centerY - 1; cellY <= centerY + 2 && woken < 20; cellY += 1) {
      for (let cellZ = centerZ - 2; cellZ <= centerZ + 2 && woken < 20; cellZ += 1) {
        for (let cellX = centerX - 2; cellX <= centerX + 2 && woken < 20; cellX += 1) {
          const bucket = this.strawSpatial.get(this.strawCellKeyFromIndices(cellX, cellY, cellZ));
          if (!bucket) continue;
          for (const instanceId of bucket) {
            if (instanceId === sourceId || this.strawAwake[instanceId] || this.pulledStrawIds.has(instanceId)) continue;
            const offset = instanceId * 3;
            const dx = this.strawPositions[offset] - sourceX;
            const dy = this.strawPositions[offset + 1] - sourceY;
            const dz = this.strawPositions[offset + 2] - sourceZ;
            if (dy < -0.18 || dy > 1.45 || dx * dx + dz * dz > 0.92 * 0.92) continue;
            this.activateStraw(instanceId);
            const jitter = ((Math.imul(instanceId ^ sourceId, 2654435761) >>> 8) & 0xffff) / 0xffff - 0.5;
            this.strawVelocities[offset] = dx * 0.08 + jitter * 0.06;
            this.strawVelocities[offset + 1] = -0.05;
            this.strawVelocities[offset + 2] = dz * 0.08 - jitter * 0.06;
            woken += 1;
            if (woken >= 20) break;
          }
        }
      }
    }
  }

  private placeHistoricalStraw(instanceId: number): void {
    const random = mulberry32((this.roundSeed ^ Math.imul(instanceId + 1, 0x45d9f3b)) >>> 0);
    const angle = random() * Math.PI * 2;
    const radius = HAY_RADIUS + 0.9 + random() * 5.1;
    const offset = instanceId * 3;
    const quaternionOffset = instanceId * 4;
    this.strawPositions[offset] = Math.cos(angle) * radius;
    this.strawPositions[offset + 1] = 0.075 + random() * 0.035;
    this.strawPositions[offset + 2] = Math.sin(angle) * radius;
    this.strawMatrixQuaternion.setFromEuler(new THREE.Euler(
      Math.PI / 2 + (random() - 0.5) * 0.32,
      random() * Math.PI * 2,
      (random() - 0.5) * 0.45,
    ));
    this.strawMatrixQuaternion.toArray(this.strawQuaternions, quaternionOffset);
    this.updateStrawSpatial(instanceId);
    this.writeStrawMatrix(instanceId);
    this.hay.instanceMatrix.needsUpdate = true;
  }

  pullStraw(instanceId: number, playerId?: string, animate = true): void {
    if (!Number.isInteger(instanceId) || instanceId < 0 || instanceId >= HAY_COUNT) return;
    if (this.pulledStrawIds.has(instanceId)) return;
    if (animate) this.wakeUnsupportedStraws(instanceId);
    this.pulledStrawIds.add(instanceId);
    if (!animate) {
      this.placeHistoricalStraw(instanceId);
      return;
    }

    this.activateStraw(instanceId);
    const offset = instanceId * 3;
    const source = playerId === this.localPlayerId
      ? this.camera.position
      : this.remotes.get(playerId ?? '')?.group.position ?? this.camera.position;
    const dx = source.x - this.strawPositions[offset];
    const dy = source.y - this.strawPositions[offset + 1] + 0.65;
    const dz = source.z - this.strawPositions[offset + 2];
    const length = Math.max(0.001, Math.hypot(dx, dy, dz));
    const random = mulberry32((this.roundSeed ^ Math.imul(instanceId + 1, 0x9e3779b1)) >>> 0);
    const speed = 3.25 + random() * 1.65;
    this.strawVelocities[offset] = dx / length * speed;
    this.strawVelocities[offset + 1] = dy / length * speed + 1.2 + random() * 0.75;
    this.strawVelocities[offset + 2] = dz / length * speed;
    this.strawSpins[offset] = (random() - 0.5) * 13;
    this.strawSpins[offset + 1] = (random() - 0.5) * 13;
    this.strawSpins[offset + 2] = (random() - 0.5) * 13;
  }

  private resetHay(): void {
    if (!this.hay) return;
    this.strawPositions.set(this.strawOriginalPositions);
    this.strawQuaternions.set(this.strawOriginalQuaternions);
    this.strawScales.set(this.strawOriginalScales);
    this.strawVelocities.fill(0);
    this.strawSpins.fill(0);
    this.strawSleepTimers.fill(0);
    this.strawActiveAges.fill(0);
    this.strawAwake.fill(0);
    this.strawContacts.fill(0);
    this.strawCells.fill(-1);
    this.activeStrawIds.clear();
    this.dirtyStrawIds.clear();
    this.strawSpatial.clear();
    for (let instanceId = 0; instanceId < HAY_COUNT; instanceId += 1) {
      this.hay.setMatrixAt(instanceId, this.hayOriginalMatrices[instanceId]);
      this.addStrawToSpatial(instanceId);
    }
    this.hay.instanceMatrix.needsUpdate = true;
    this.pulledStrawIds.clear();
  }

  playLocalAction(type: 'sneeze' | 'magnet'): void {
    if (type === 'sneeze') {
      const origin = this.localPosition.clone().add(new THREE.Vector3(0, 1.1, 0));
      this.createBurst(origin, 150, 0xe3ae4c);
      this.blastStraws(origin, 3.1, 7.2);
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
    if (action.type === 'sneeze') {
      this.createBurst(position, 120, 0xe3ae4c);
      this.blastStraws(position, 3.1, 7.2);
    }
    if (action.type === 'magnet') this.createPulse(position, 0xdfff48, 3.8);
  }

  private blastStraws(origin: THREE.Vector3, radius: number, power: number): void {
    const radiusSq = radius * radius;
    let affected = 0;
    for (let instanceId = 0; instanceId < HAY_COUNT && affected < 360; instanceId += 1) {
      if (this.pulledStrawIds.has(instanceId)) continue;
      const offset = instanceId * 3;
      const dx = this.strawPositions[offset] - origin.x;
      const dy = this.strawPositions[offset + 1] - origin.y;
      const dz = this.strawPositions[offset + 2] - origin.z;
      const distanceSq = dx * dx + dy * dy + dz * dz;
      if (distanceSq > radiusSq) continue;
      const distance = Math.max(0.18, Math.sqrt(distanceSq));
      const force = (1 - distance / radius) * power;
      if (force <= 0.12) continue;
      this.activateStraw(instanceId);
      this.strawVelocities[offset] += dx / distance * force;
      this.strawVelocities[offset + 1] += Math.max(0.8, dy / distance * force + force * 0.44);
      this.strawVelocities[offset + 2] += dz / distance * force;
      const twist = ((Math.imul(instanceId + 7, 1103515245) >>> 9) & 0xffff) / 0xffff - 0.5;
      this.strawSpins[offset] += twist * 10;
      this.strawSpins[offset + 1] -= twist * 8;
      this.strawSpins[offset + 2] += twist * 12;
      affected += 1;
    }
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

  private integrateStrawRotation(instanceId: number, delta: number): void {
    const velocityOffset = instanceId * 3;
    const quaternionOffset = instanceId * 4;
    const wx = this.strawSpins[velocityOffset];
    const wy = this.strawSpins[velocityOffset + 1];
    const wz = this.strawSpins[velocityOffset + 2];
    const angularSpeed = Math.hypot(wx, wy, wz);
    if (angularSpeed < 0.0001) return;
    const halfAngle = angularSpeed * delta * 0.5;
    const scale = Math.sin(halfAngle) / angularSpeed;
    const dx = wx * scale;
    const dy = wy * scale;
    const dz = wz * scale;
    const dw = Math.cos(halfAngle);
    const qx = this.strawQuaternions[quaternionOffset];
    const qy = this.strawQuaternions[quaternionOffset + 1];
    const qz = this.strawQuaternions[quaternionOffset + 2];
    const qw = this.strawQuaternions[quaternionOffset + 3];
    const nx = dw * qx + dx * qw + dy * qz - dz * qy;
    const ny = dw * qy - dx * qz + dy * qw + dz * qx;
    const nz = dw * qz + dx * qy - dy * qx + dz * qw;
    const nw = dw * qw - dx * qx - dy * qy - dz * qz;
    const inverseLength = 1 / Math.max(0.0001, Math.hypot(nx, ny, nz, nw));
    this.strawQuaternions[quaternionOffset] = nx * inverseLength;
    this.strawQuaternions[quaternionOffset + 1] = ny * inverseLength;
    this.strawQuaternions[quaternionOffset + 2] = nz * inverseLength;
    this.strawQuaternions[quaternionOffset + 3] = nw * inverseLength;
  }

  private resolveStrawCollision(instanceId: number, otherId: number): boolean {
    const offsetA = instanceId * 3;
    const offsetB = otherId * 3;
    const quaternionA = instanceId * 4;
    const quaternionB = otherId * 4;
    const centerDx = this.strawPositions[offsetA] - this.strawPositions[offsetB];
    const centerDy = this.strawPositions[offsetA + 1] - this.strawPositions[offsetB + 1];
    const centerDz = this.strawPositions[offsetA + 2] - this.strawPositions[offsetB + 2];
    const halfA = STRAW_HALF_LENGTH * this.strawScales[instanceId];
    const halfB = STRAW_HALF_LENGTH * this.strawScales[otherId];
    const radius = STRAW_COLLIDER_RADIUS * (this.strawScales[instanceId] + this.strawScales[otherId]);
    const broadDistance = halfA + halfB + radius;
    if (centerDx * centerDx + centerDy * centerDy + centerDz * centerDz > broadDistance * broadDistance) return false;

    const qax = this.strawQuaternions[quaternionA];
    const qay = this.strawQuaternions[quaternionA + 1];
    const qaz = this.strawQuaternions[quaternionA + 2];
    const qaw = this.strawQuaternions[quaternionA + 3];
    const qbx = this.strawQuaternions[quaternionB];
    const qby = this.strawQuaternions[quaternionB + 1];
    const qbz = this.strawQuaternions[quaternionB + 2];
    const qbw = this.strawQuaternions[quaternionB + 3];
    const axisAx = 2 * (qax * qay - qaw * qaz);
    const axisAy = 1 - 2 * (qax * qax + qaz * qaz);
    const axisAz = 2 * (qay * qaz + qaw * qax);
    const axisBx = 2 * (qbx * qby - qbw * qbz);
    const axisBy = 1 - 2 * (qbx * qbx + qbz * qbz);
    const axisBz = 2 * (qby * qbz + qbw * qbx);
    const ux = axisAx * halfA * 2;
    const uy = axisAy * halfA * 2;
    const uz = axisAz * halfA * 2;
    const vx = axisBx * halfB * 2;
    const vy = axisBy * halfB * 2;
    const vz = axisBz * halfB * 2;
    const wx = centerDx - axisAx * halfA + axisBx * halfB;
    const wy = centerDy - axisAy * halfA + axisBy * halfB;
    const wz = centerDz - axisAz * halfA + axisBz * halfB;
    const a = ux * ux + uy * uy + uz * uz;
    const b = ux * vx + uy * vy + uz * vz;
    const c = vx * vx + vy * vy + vz * vz;
    const d = ux * wx + uy * wy + uz * wz;
    const e = vx * wx + vy * wy + vz * wz;
    const denominator = a * c - b * b;
    let sNumerator: number;
    let sDenominator = denominator;
    let tNumerator: number;
    let tDenominator = denominator;
    if (denominator < 0.000001) {
      sNumerator = 0;
      sDenominator = 1;
      tNumerator = e;
      tDenominator = c;
    } else {
      sNumerator = b * e - c * d;
      tNumerator = a * e - b * d;
      if (sNumerator < 0) {
        sNumerator = 0;
        tNumerator = e;
        tDenominator = c;
      } else if (sNumerator > sDenominator) {
        sNumerator = sDenominator;
        tNumerator = e + b;
        tDenominator = c;
      }
    }
    if (tNumerator < 0) {
      tNumerator = 0;
      if (-d < 0) sNumerator = 0;
      else if (-d > a) sNumerator = sDenominator;
      else {
        sNumerator = -d;
        sDenominator = a;
      }
    } else if (tNumerator > tDenominator) {
      tNumerator = tDenominator;
      if (-d + b < 0) sNumerator = 0;
      else if (-d + b > a) sNumerator = sDenominator;
      else {
        sNumerator = -d + b;
        sDenominator = a;
      }
    }
    const segmentA = Math.abs(sNumerator) < 0.000001 ? 0 : sNumerator / sDenominator;
    const segmentB = Math.abs(tNumerator) < 0.000001 ? 0 : tNumerator / tDenominator;
    let normalX = wx + segmentA * ux - segmentB * vx;
    let normalY = wy + segmentA * uy - segmentB * vy;
    let normalZ = wz + segmentA * uz - segmentB * vz;
    let distance = Math.hypot(normalX, normalY, normalZ);
    if (distance >= radius) return false;
    if (distance < 0.0001) {
      normalX = centerDx || (instanceId & 1 ? 1 : -1);
      normalY = centerDy;
      normalZ = centerDz || (instanceId & 2 ? 1 : -1);
      distance = Math.max(0.0001, Math.hypot(normalX, normalY, normalZ));
    }
    normalX /= distance;
    normalY /= distance;
    normalZ /= distance;

    const speedA = Math.hypot(
      this.strawVelocities[offsetA],
      this.strawVelocities[offsetA + 1],
      this.strawVelocities[offsetA + 2],
    );
    if (!this.strawAwake[otherId] && this.collisionWakeBudget > 0
      && this.strawActiveAges[instanceId] > 0.035 && (radius - distance > 0.012 || speedA > 0.85)) {
      this.activateStraw(otherId);
      this.collisionWakeBudget -= 1;
    }
    const otherAwake = Boolean(this.strawAwake[otherId]);
    const youngExtraction = this.pulledStrawIds.has(instanceId) && this.strawActiveAges[instanceId] < 0.16;
    const correction = (radius - distance) * (youngExtraction ? 0.28 : 0.82);
    const shareA = otherAwake ? 0.5 : 1;
    this.strawPositions[offsetA] += normalX * correction * shareA;
    this.strawPositions[offsetA + 1] += normalY * correction * shareA;
    this.strawPositions[offsetA + 2] += normalZ * correction * shareA;
    if (otherAwake) {
      this.strawPositions[offsetB] -= normalX * correction * 0.5;
      this.strawPositions[offsetB + 1] -= normalY * correction * 0.5;
      this.strawPositions[offsetB + 2] -= normalZ * correction * 0.5;
      this.dirtyStrawIds.add(otherId);
      this.updateStrawSpatial(otherId);
    }

    const velocityBX = otherAwake ? this.strawVelocities[offsetB] : 0;
    const velocityBY = otherAwake ? this.strawVelocities[offsetB + 1] : 0;
    const velocityBZ = otherAwake ? this.strawVelocities[offsetB + 2] : 0;
    const relativeVelocity = (this.strawVelocities[offsetA] - velocityBX) * normalX
      + (this.strawVelocities[offsetA + 1] - velocityBY) * normalY
      + (this.strawVelocities[offsetA + 2] - velocityBZ) * normalZ;
    if (relativeVelocity < 0) {
      const impulse = -(1.08 * relativeVelocity) / (otherAwake ? 2 : 1);
      this.strawVelocities[offsetA] += normalX * impulse;
      this.strawVelocities[offsetA + 1] += normalY * impulse;
      this.strawVelocities[offsetA + 2] += normalZ * impulse;
      if (otherAwake) {
        this.strawVelocities[offsetB] -= normalX * impulse;
        this.strawVelocities[offsetB + 1] -= normalY * impulse;
        this.strawVelocities[offsetB + 2] -= normalZ * impulse;
      }
    }
    this.strawContacts[instanceId] = 1;
    if (otherAwake) this.strawContacts[otherId] = 1;
    return true;
  }

  private updateStrawPhysics(delta: number): void {
    if (this.activeStrawIds.size === 0) return;
    const steps = delta > 1 / 45 ? 2 : 1;
    const stepDelta = delta / steps;
    const linearDamping = Math.exp(-stepDelta * 0.72);
    const angularDamping = Math.exp(-stepDelta * 1.08);
    this.collisionWakeBudget = 4;

    for (let step = 0; step < steps; step += 1) {
      const active = [...this.activeStrawIds];
      for (const instanceId of active) {
        if (!this.strawAwake[instanceId]) continue;
        const offset = instanceId * 3;
        const quaternionOffset = instanceId * 4;
        this.strawContacts[instanceId] = 0;
        this.strawActiveAges[instanceId] += stepDelta;
        this.strawVelocities[offset + 1] -= 9.35 * stepDelta;
        this.strawPositions[offset] += this.strawVelocities[offset] * stepDelta;
        this.strawPositions[offset + 1] += this.strawVelocities[offset + 1] * stepDelta;
        this.strawPositions[offset + 2] += this.strawVelocities[offset + 2] * stepDelta;
        this.integrateStrawRotation(instanceId, stepDelta);
        this.strawVelocities[offset] *= linearDamping;
        this.strawVelocities[offset + 1] *= linearDamping;
        this.strawVelocities[offset + 2] *= linearDamping;
        this.strawSpins[offset] *= angularDamping;
        this.strawSpins[offset + 1] *= angularDamping;
        this.strawSpins[offset + 2] *= angularDamping;

        const qx = this.strawQuaternions[quaternionOffset];
        const qz = this.strawQuaternions[quaternionOffset + 2];
        const verticalAxis = Math.abs(1 - 2 * (qx * qx + qz * qz));
        const bottom = this.strawPositions[offset + 1]
          - verticalAxis * STRAW_HALF_LENGTH * this.strawScales[instanceId]
          - STRAW_COLLIDER_RADIUS * this.strawScales[instanceId];
        const radiusFromCenter = Math.hypot(this.strawPositions[offset], this.strawPositions[offset + 2]);
        const floor = radiusFromCenter <= 18 ? 0.035 : fieldHeight(this.strawPositions[offset], this.strawPositions[offset + 2]) + 0.025;
        if (bottom < floor) {
          this.strawPositions[offset + 1] += floor - bottom;
          if (this.strawVelocities[offset + 1] < 0) this.strawVelocities[offset + 1] *= -0.14;
          this.strawVelocities[offset] *= 0.68;
          this.strawVelocities[offset + 2] *= 0.68;
          this.strawSpins[offset] *= 0.72;
          this.strawSpins[offset + 1] *= 0.72;
          this.strawSpins[offset + 2] *= 0.72;
          this.strawContacts[instanceId] = 1;
        }
        if (radiusFromCenter > 16.75) {
          const inverseRadius = 1 / radiusFromCenter;
          const normalX = this.strawPositions[offset] * inverseRadius;
          const normalZ = this.strawPositions[offset + 2] * inverseRadius;
          this.strawPositions[offset] = normalX * 16.75;
          this.strawPositions[offset + 2] = normalZ * 16.75;
          const radialVelocity = this.strawVelocities[offset] * normalX + this.strawVelocities[offset + 2] * normalZ;
          if (radialVelocity > 0) {
            this.strawVelocities[offset] -= normalX * radialVelocity * 1.28;
            this.strawVelocities[offset + 2] -= normalZ * radialVelocity * 1.28;
          }
          this.strawContacts[instanceId] = 1;
        }
        this.updateStrawSpatial(instanceId);
        this.dirtyStrawIds.add(instanceId);
      }

      const collisionActive = [...this.activeStrawIds];
      for (const instanceId of collisionActive) {
        if (!this.strawAwake[instanceId]) continue;
        const offset = instanceId * 3;
        const centerX = Math.floor(this.strawPositions[offset] / STRAW_CELL_SIZE);
        const centerY = Math.floor(this.strawPositions[offset + 1] / STRAW_CELL_SIZE);
        const centerZ = Math.floor(this.strawPositions[offset + 2] / STRAW_CELL_SIZE);
        let checked = 0;
        collisionSearch:
        for (let cellY = centerY - 1; cellY <= centerY + 1; cellY += 1) {
          for (let cellZ = centerZ - 1; cellZ <= centerZ + 1; cellZ += 1) {
            for (let cellX = centerX - 1; cellX <= centerX + 1; cellX += 1) {
              const bucket = this.strawSpatial.get(this.strawCellKeyFromIndices(cellX, cellY, cellZ));
              if (!bucket) continue;
              for (const otherId of bucket) {
                if (otherId === instanceId || (this.strawAwake[otherId] && otherId < instanceId)) continue;
                if (this.resolveStrawCollision(instanceId, otherId)) checked += 3;
                else checked += 1;
                if (checked >= 28) break collisionSearch;
              }
            }
          }
        }
        this.updateStrawSpatial(instanceId);

        const speedSq = this.strawVelocities[offset] ** 2
          + this.strawVelocities[offset + 1] ** 2
          + this.strawVelocities[offset + 2] ** 2;
        const spinSq = this.strawSpins[offset] ** 2
          + this.strawSpins[offset + 1] ** 2
          + this.strawSpins[offset + 2] ** 2;
        if (this.strawContacts[instanceId] && speedSq < 0.045 && spinSq < 0.42 && this.strawActiveAges[instanceId] > 0.2) {
          this.strawSleepTimers[instanceId] += stepDelta;
          if (this.strawSleepTimers[instanceId] > 0.72) this.sleepStraw(instanceId);
        } else this.strawSleepTimers[instanceId] = 0;
      }
    }

    if (this.dirtyStrawIds.size > 0) {
      for (const instanceId of this.dirtyStrawIds) this.writeStrawMatrix(instanceId);
      this.hay.instanceMatrix.needsUpdate = true;
      this.dirtyStrawIds.clear();
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
    if (this.playing) {
      this.updatePlayer(delta, elapsed);
      if (this.pulling && document.pointerLockElement === this.renderer.domElement
        && performance.now() - this.lastInteraction >= 115) this.interact();
    }
    else {
      this.attractAngle += delta * 0.065;
      const radius = 15.5 + Math.sin(elapsed * 0.17) * 1.7;
      this.camera.position.set(Math.cos(this.attractAngle) * radius, 6.7 + Math.sin(elapsed * 0.22), Math.sin(this.attractAngle) * radius);
      this.camera.lookAt(0, 2.2, 0);
    }
    this.updateGoose(delta, elapsed);
    this.updateBursts(delta);
    this.updateStrawPhysics(delta);
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
      glint.scale.setScalar(0.035 + pulse * 0.028);
    }
    this.sun.position.x = -13 + Math.sin(elapsed * 0.03) * 3;
    this.renderer.render(this.scene, this.camera);
  };
}
