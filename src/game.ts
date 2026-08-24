import * as THREE from 'three';
import type { ActionEvent, PlayerState, RoomSnapshot, Vec3State } from './shared/protocol';
import { HAY_COUNT, HAY_RADIUS, mulberry32, needlePosition, surfaceHeight } from './shared/hay';

const PLAYER_HEIGHT = 1.62;
const ARENA_RADIUS = 15.5;
const STRAW_HALF_LENGTH = 0.36;
const STRAW_COLLIDER_RADIUS = 0.028;
const STRAW_CELL_SIZE = 0.58;
const MAX_ACTIVE_STRAWS = 640;
const PLAYER_FOOT_RADIUS = 0.42;
const PLAYER_GRAVITY = 13.8;
const PLAYER_JUMP_SPEED = 5.55;

type GooseState = 'patrol' | 'inspect' | 'charge' | 'nap' | 'panic';

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
  readonly gooseHead = new THREE.Group();
  readonly gooseWingLeft = new THREE.Group();
  readonly gooseWingRight = new THREE.Group();
  readonly gooseLegLeft = new THREE.Group();
  readonly gooseLegRight = new THREE.Group();
  readonly gooseVelocity = new THREE.Vector3();
  readonly gooseTarget = new THREE.Vector3(8, 0, 0);
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
  playerVerticalVelocity = 0;
  playerGrounded = false;
  jumpRequested = false;
  gooseState: GooseState = 'patrol';
  gooseStateTime = 4;
  gooseDecision = 0;
  goosePanicTime = 0;
  gooseAbilityCooldown = 0;
  windmillRotor?: THREE.Group;

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
    this.resize();
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

    const woodTexture = new THREE.TextureLoader().load('/textures/weathered-farm-wood-v1.webp');
    woodTexture.colorSpace = THREE.SRGBColorSpace;
    woodTexture.wrapS = woodTexture.wrapT = THREE.RepeatWrapping;
    woodTexture.repeat.set(2.8, 1);
    woodTexture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const postGeometry = new THREE.CylinderGeometry(0.17, 0.22, 2.85, 10);
    const postMaterial = new THREE.MeshStandardMaterial({ color: 0xa88962, map: woodTexture, roughness: 0.96 });
    const railGeometry = new THREE.BoxGeometry(3.95, 0.19, 0.16, 3, 1, 1);
    const rails = new THREE.InstancedMesh(railGeometry, postMaterial, 56);
    const posts = new THREE.InstancedMesh(postGeometry, postMaterial, 28);
    const stoneBases = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.29, 0.35, 0.32, 8),
      new THREE.MeshStandardMaterial({ color: 0x706b5d, roughness: 1, flatShading: true }),
      28,
    );
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < 28; i += 1) {
      const angle = (i / 28) * Math.PI * 2;
      matrix.makeRotationY(-angle);
      matrix.setPosition(Math.cos(angle) * 17.2, 1.28, Math.sin(angle) * 17.2);
      posts.setMatrixAt(i, matrix);
      const baseMatrix = new THREE.Matrix4().makeRotationY(-angle);
      baseMatrix.setPosition(Math.cos(angle) * 17.2, 0.11, Math.sin(angle) * 17.2);
      stoneBases.setMatrixAt(i, baseMatrix);
      const railMatrix = new THREE.Matrix4().makeRotationY(-angle - Math.PI / 2);
      railMatrix.setPosition(Math.cos(angle + Math.PI / 28) * 17.05, 0.72, Math.sin(angle + Math.PI / 28) * 17.05);
      rails.setMatrixAt(i * 2, railMatrix);
      const topRailMatrix = railMatrix.clone();
      topRailMatrix.setPosition(Math.cos(angle + Math.PI / 28) * 17.05, 1.63, Math.sin(angle + Math.PI / 28) * 17.05);
      rails.setMatrixAt(i * 2 + 1, topRailMatrix);
    }
    posts.castShadow = rails.castShadow = stoneBases.castShadow = true;
    posts.receiveShadow = rails.receiveShadow = true;
    this.scene.add(posts, rails, stoneBases);

    const metalCanvas = document.createElement('canvas');
    metalCanvas.width = 256; metalCanvas.height = 512;
    const metalContext = metalCanvas.getContext('2d')!;
    const metalGradient = metalContext.createLinearGradient(0, 0, 256, 0);
    metalGradient.addColorStop(0, '#3b4543'); metalGradient.addColorStop(0.5, '#78817b'); metalGradient.addColorStop(1, '#303a38');
    metalContext.fillStyle = metalGradient; metalContext.fillRect(0, 0, 256, 512);
    for (let x = 0; x < 256; x += 16) {
      metalContext.fillStyle = 'rgba(225,235,220,.17)'; metalContext.fillRect(x, 0, 3, 512);
      metalContext.fillStyle = 'rgba(14,19,18,.3)'; metalContext.fillRect(x + 8, 0, 4, 512);
    }
    for (let y = 38; y < 512; y += 79) {
      metalContext.fillStyle = 'rgba(112,54,30,.34)';
      metalContext.fillRect((y * 17) % 210, y, 38, 7);
    }
    const metalTexture = new THREE.CanvasTexture(metalCanvas);
    metalTexture.colorSpace = THREE.SRGBColorSpace;
    metalTexture.wrapS = metalTexture.wrapT = THREE.RepeatWrapping;
    metalTexture.repeat.set(2.5, 1.8);
    const siloMaterial = new THREE.MeshStandardMaterial({ color: 0x98a096, map: metalTexture, roughness: 0.58, metalness: 0.62 });
    const silo = new THREE.Mesh(new THREE.CylinderGeometry(3.3, 3.6, 12, 48), siloMaterial);
    silo.position.set(-29, 5.9, -24);
    silo.castShadow = true;
    silo.receiveShadow = true;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(4.15, 2.6, 48), new THREE.MeshStandardMaterial({ color: 0x9c4b2d, roughness: 0.78, metalness: 0.22 }));
    roof.position.set(-29, 13.1, -24);
    const siloBands = new THREE.Group();
    for (let band = 0; band < 5; band += 1) {
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(3.48 - band * 0.025, 0.075, 5, 48), new THREE.MeshStandardMaterial({ color: 0x303735, roughness: 0.45, metalness: 0.75 }));
      hoop.rotation.x = Math.PI / 2; hoop.position.set(-29, 1.8 + band * 2.25, -24); siloBands.add(hoop);
    }
    const hatch = new THREE.Mesh(new THREE.CircleGeometry(0.72, 24), new THREE.MeshStandardMaterial({ color: 0x543b2d, roughness: 0.72, metalness: 0.25 }));
    hatch.position.set(-25.49, 5.4, -24); hatch.rotation.y = Math.PI / 2;
    this.scene.add(silo, roof, siloBands, hatch);

    const barn = new THREE.Group();
    const barnWood = woodTexture.clone(); barnWood.repeat.set(3, 2); barnWood.needsUpdate = true;
    const barnMaterial = new THREE.MeshStandardMaterial({ color: 0xa73b2c, map: barnWood, roughness: 0.94 });
    const barnBody = new THREE.Mesh(new THREE.BoxGeometry(10, 6, 7), barnMaterial);
    barnBody.position.y = 3; barnBody.castShadow = barnBody.receiveShadow = true; barn.add(barnBody);
    const roofMaterial = new THREE.MeshStandardMaterial({ color: 0x49372d, map: woodTexture, roughness: 0.92 });
    for (const side of [-1, 1]) {
      const roofSide = new THREE.Mesh(new THREE.BoxGeometry(5.9, 0.34, 7.8), roofMaterial);
      roofSide.position.set(side * 2.45, 6.95, 0); roofSide.rotation.z = side * 0.62; roofSide.castShadow = true; barn.add(roofSide);
    }
    const trimMaterial = new THREE.MeshStandardMaterial({ color: 0xf1e0ba, roughness: 0.8 });
    const barnDoor = new THREE.Mesh(new THREE.BoxGeometry(4, 4.65, 0.18), roofMaterial);
    barnDoor.position.set(0, 2.35, 3.57); barn.add(barnDoor);
    for (const x of [-2.05, 0, 2.05]) {
      const trim = new THREE.Mesh(new THREE.BoxGeometry(0.16, 4.9, 0.22), trimMaterial);
      trim.position.set(x, 2.4, 3.7); barn.add(trim);
    }
    const crossA = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.15, 0.22), trimMaterial);
    crossA.position.set(0, 2.4, 3.7); crossA.rotation.z = 0.69;
    const crossB = crossA.clone(); crossB.rotation.z = -0.69; barn.add(crossA, crossB);
    barn.position.set(30, fieldHeight(30, -19), -19); barn.rotation.y = -0.45; this.scene.add(barn);

    const windmill = new THREE.Group();
    const towerMaterial = new THREE.MeshStandardMaterial({ color: 0x4a514d, roughness: 0.5, metalness: 0.62 });
    const addBeam = (from: THREE.Vector3, to: THREE.Vector3, radiusValue: number): THREE.Mesh => {
      const center = from.clone().add(to).multiplyScalar(0.5);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(radiusValue, radiusValue, from.distanceTo(to), 7), towerMaterial);
      beam.position.copy(center); beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize()); beam.castShadow = true;
      windmill.add(beam); return beam;
    };
    for (const sideX of [-1, 1]) for (const sideZ of [-1, 1]) addBeam(new THREE.Vector3(sideX * 1.55, 0, sideZ * 1.55), new THREE.Vector3(sideX * 0.35, 8.2, sideZ * 0.35), 0.09);
    for (let level = 1; level <= 4; level += 1) {
      const y = level * 1.65; const radiusAtLevel = 1.55 - level * 0.24;
      addBeam(new THREE.Vector3(-radiusAtLevel, y, -radiusAtLevel), new THREE.Vector3(radiusAtLevel, y, -radiusAtLevel), 0.055);
      addBeam(new THREE.Vector3(-radiusAtLevel, y, radiusAtLevel), new THREE.Vector3(radiusAtLevel, y, radiusAtLevel), 0.055);
    }
    const rotor = new THREE.Group();
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.42, 0.7, 16), new THREE.MeshStandardMaterial({ color: 0xa94b2e, roughness: 0.55, metalness: 0.45 }));
    hub.rotation.x = Math.PI / 2; rotor.add(hub);
    for (let bladeIndex = 0; bladeIndex < 6; bladeIndex += 1) {
      const bladePivot = new THREE.Group();
      bladePivot.rotation.z = bladeIndex * Math.PI / 3;
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.34, 3.9, 0.12), postMaterial);
      blade.position.y = 2.05; blade.rotation.z = 0.12; bladePivot.add(blade); rotor.add(bladePivot);
    }
    rotor.position.y = 8.1; windmill.add(rotor); this.windmillRotor = rotor;
    windmill.position.set(27, fieldHeight(27, 24), 24); windmill.rotation.y = 0.75; this.scene.add(windmill);

    const baleMaterial = new THREE.MeshStandardMaterial({ color: 0xd5a13f, roughness: 1, bumpMap: woodTexture, bumpScale: 0.025 });
    for (let index = 0; index < 11; index += 1) {
      const angle = 0.35 + index * 0.55;
      const radius = 29 + (index % 3) * 4;
      const x = Math.cos(angle) * radius; const z = Math.sin(angle) * radius;
      const bale = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 1.65, 20), baleMaterial);
      bale.rotation.z = Math.PI / 2; bale.rotation.y = angle; bale.position.set(x, fieldHeight(x, z) + 1.05, z); bale.castShadow = true; this.scene.add(bale);
    }

    const mountains = new THREE.Group();
    const createMountainGeometry = (seed: number, radius: number, height: number): THREE.BufferGeometry => {
      const randomMountain = mulberry32(seed);
      const segments = 10;
      const levels = 6;
      const positions: number[] = [];
      const colors: number[] = [];
      const indices: number[] = [];
      const rockLow = new THREE.Color(0x465044);
      const rockHigh = new THREE.Color(0x8b8a78);
      const snow = new THREE.Color(0xe9e3cf);
      for (let level = 0; level < levels; level += 1) {
        const t = level / (levels - 1);
        const ringRadius = radius * Math.pow(1 - t, 0.78) + (level === levels - 1 ? radius * 0.025 : 0);
        for (let segment = 0; segment < segments; segment += 1) {
          const angle = segment / segments * Math.PI * 2;
          const crag = 0.78 + randomMountain() * 0.34 + Math.sin(segment * 3.1 + seed) * 0.08;
          positions.push(Math.cos(angle) * ringRadius * crag, t * height + (randomMountain() - 0.5) * (1 - t) * 0.7, Math.sin(angle) * ringRadius * crag);
          const shade = THREE.MathUtils.clamp(t + (randomMountain() - 0.5) * 0.13, 0, 1);
          const color = rockLow.clone().lerp(rockHigh, Math.min(1, shade * 1.35));
          if (shade > 0.72) color.lerp(snow, THREE.MathUtils.smoothstep(shade, 0.72, 0.96));
          color.toArray(colors, colors.length);
        }
      }
      for (let level = 0; level < levels - 1; level += 1) for (let segment = 0; segment < segments; segment += 1) {
        const next = (segment + 1) % segments;
        const a = level * segments + segment; const b = level * segments + next;
        const c = (level + 1) * segments + segment; const d = (level + 1) * segments + next;
        indices.push(a, b, c, b, d, c);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.setIndex(indices); geometry.computeVertexNormals(); return geometry;
    };
    const mountainMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true });
    for (let layer = 0; layer < 2; layer += 1) {
      const count = layer === 0 ? 15 : 12;
      for (let i = 0; i < count; i += 1) {
        const angle = (i / count) * Math.PI * 2 + layer * 0.16;
        const mountainRadius = 8 + (i % 4) * 2.7 + layer * 3;
        const mountainHeight = 12 + (i % 5) * 3.1 + layer * 5;
        const mountain = new THREE.Mesh(createMountainGeometry(731 + layer * 100 + i, mountainRadius, mountainHeight), mountainMaterial);
        const distance = layer === 0 ? 55 + (i % 3) * 4 : 73 + (i % 4) * 3;
        mountain.position.set(Math.cos(angle) * distance, fieldHeight(Math.cos(angle) * distance, Math.sin(angle) * distance) - 2.1, Math.sin(angle) * distance);
        mountain.rotation.y = angle + i * 0.37; mountains.add(mountain);
      }
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
      // Most bodies fill the complete volume; the remainder form a crisp shell.
      // This keeps excavated tunnels dense instead of exposing a hollow facade.
      const nearSurface = random() < 0.38;
      const y = nearSurface ? height - random() * 0.5 : 0.045 + random() * Math.max(0.08, height - 0.045);
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
    // The dense pile receives the arena shadow, but self-shadowing 64k crossed
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
    const feather = new THREE.MeshStandardMaterial({ color: 0xf4f0df, roughness: 0.88 });
    const featherShade = new THREE.MeshStandardMaterial({ color: 0xd7d3c3, roughness: 0.94 });
    const orange = new THREE.MeshStandardMaterial({ color: 0xf18a22, roughness: 0.7 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x11110f, roughness: 0.92 });
    const red = new THREE.MeshStandardMaterial({ color: 0xb92f27, roughness: 0.72 });

    const body = new THREE.Mesh(new THREE.SphereGeometry(0.62, 24, 16), feather);
    body.scale.set(1.48, 0.9, 0.94); body.position.set(-0.1, 0.04, 0); body.castShadow = true;
    const chest = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 14), feather);
    chest.scale.set(0.8, 1.2, 0.9); chest.position.set(0.55, 0.28, 0);
    const neckPieces: THREE.Mesh[] = [];
    for (let index = 0; index < 4; index += 1) {
      const neck = new THREE.Mesh(new THREE.SphereGeometry(0.24 - index * 0.014, 18, 12), feather);
      neck.scale.set(0.82, 1.26, 0.86);
      neck.position.set(0.55 + index * 0.105, 0.54 + index * 0.24, 0);
      neckPieces.push(neck);
    }

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 22, 16), feather);
    head.scale.set(1.08, 0.94, 0.96); this.gooseHead.add(head);
    const cheekLeft = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), featherShade);
    cheekLeft.position.set(0.03, -0.045, 0.23); cheekLeft.scale.set(1.2, 0.8, 0.6);
    const cheekRight = cheekLeft.clone(); cheekRight.position.z = -0.23;
    const upperBeak = new THREE.Mesh(new THREE.ConeGeometry(0.135, 0.48, 10), orange);
    upperBeak.position.set(0.47, -0.025, 0); upperBeak.rotation.z = -Math.PI / 2; upperBeak.scale.set(0.72, 1, 1.15);
    const lowerBeak = new THREE.Mesh(new THREE.ConeGeometry(0.105, 0.42, 10), new THREE.MeshStandardMaterial({ color: 0xd86618, roughness: 0.76 }));
    lowerBeak.position.set(0.43, -0.105, 0); lowerBeak.rotation.z = -Math.PI / 2; lowerBeak.scale.set(0.58, 1, 1.05);
    const eyeLeft = new THREE.Mesh(new THREE.SphereGeometry(0.047, 12, 8), dark);
    eyeLeft.position.set(0.17, 0.09, 0.265);
    const eyeRight = eyeLeft.clone(); eyeRight.position.z = -0.265;
    const browLeft = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.034, 0.045), dark);
    browLeft.position.set(0.17, 0.18, 0.27); browLeft.rotation.z = -0.28;
    const browRight = browLeft.clone(); browRight.position.z = -0.27; browRight.rotation.z = 0.28;
    this.gooseHead.add(cheekLeft, cheekRight, upperBeak, lowerBeak, eyeLeft, eyeRight, browLeft, browRight);
    this.gooseHead.position.set(0.9, 1.33, 0);

    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.235, 0.055, 8, 22), red);
    collar.rotation.x = Math.PI / 2; collar.position.set(0.84, 0.99, 0);
    const tag = new THREE.Mesh(new THREE.OctahedronGeometry(0.095, 0), new THREE.MeshStandardMaterial({ color: 0xd9c65d, roughness: 0.32, metalness: 0.72 }));
    tag.position.set(0.92, 0.92, 0.18);

    const makeWing = (side: number, target: THREE.Group): void => {
      const base = new THREE.Mesh(new THREE.SphereGeometry(0.38, 18, 12), featherShade);
      base.scale.set(1.55, 0.55, 0.24); base.rotation.z = -0.12; target.add(base);
      for (let index = 0; index < 4; index += 1) {
        const quill = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.44 + index * 0.06, 4, 8), feather);
        quill.rotation.z = Math.PI / 2 + 0.12 * index; quill.position.set(-0.08 - index * 0.1, -0.08 - index * 0.035, side * 0.025); target.add(quill);
      }
      target.position.set(-0.18, 0.23, side * 0.53);
    };
    makeWing(1, this.gooseWingLeft); makeWing(-1, this.gooseWingRight);

    const makeLeg = (side: number, target: THREE.Group): void => {
      const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.05, 0.55, 8), orange);
      shin.position.y = -0.23; target.add(shin);
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 7), orange);
      foot.scale.set(1.8, 0.3, 1.18); foot.position.set(0.13, -0.52, 0); target.add(foot);
      for (let toeIndex = -1; toeIndex <= 1; toeIndex += 1) {
        const toe = new THREE.Mesh(new THREE.CapsuleGeometry(0.022, 0.19, 3, 6), orange);
        toe.rotation.z = Math.PI / 2; toe.position.set(0.27, -0.52, toeIndex * 0.075); target.add(toe);
      }
      target.position.set(-0.19, -0.42, side * 0.25);
    };
    makeLeg(1, this.gooseLegLeft); makeLeg(-1, this.gooseLegRight);

    for (let index = 0; index < 4; index += 1) {
      const tail = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.38 + index * 0.05, 4, 7), index % 2 ? featherShade : feather);
      tail.position.set(-0.83 - index * 0.05, 0.12 - index * 0.06, (index - 1.5) * 0.16); tail.rotation.z = Math.PI / 2.35; this.goose.add(tail);
    }
    this.goose.add(body, chest, ...neckPieces, collar, tag, this.gooseHead, this.gooseWingLeft, this.gooseWingRight, this.gooseLegLeft, this.gooseLegRight);
    this.goose.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; });
    this.goose.scale.setScalar(1.08);
    this.goose.position.set(9, 1, 0);
    this.scene.add(this.goose);
  }

  private bindEvents(): void {
    window.addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());
    new ResizeObserver(() => this.resize()).observe(this.host);
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Space' && this.playing) {
        event.preventDefault();
        if (!event.repeat) this.jumpRequested = true;
      }
      this.keys.add(event.code);
    });
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
    window.addEventListener('blur', () => { this.pulling = false; this.keys.clear(); });
  }

  private resize(): void {
    const bounds = this.host.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width || window.innerWidth));
    const height = Math.max(1, Math.round(bounds.height || window.innerHeight));
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, width < 700 ? 1.25 : 1.65));
  }

  enterRoom(room: RoomSnapshot, playerId: string): void {
    this.playing = true;
    this.pulling = false;
    this.localPlayerId = playerId;
    this.roundSeed = room.seed;
    this.playerVerticalVelocity = 0;
    this.playerGrounded = false;
    this.jumpRequested = false;
    const local = room.players.find((player) => player.id === playerId);
    if (local) {
      this.localPosition.set(local.position.x, 0, local.position.z);
      this.yaw = local.yaw;
    }
    this.resetHay();
    this.setNeedle(room.seed);
    room.pulledStraws.forEach((instanceId) => this.pullStraw(instanceId, undefined, false));
    this.placeCameraAtPlayer();
    this.clearRemotes();
    room.players.forEach((player) => this.upsertPlayer(player));
  }

  leaveRoom(): void {
    this.playing = false;
    this.pulling = false;
    this.localPlayerId = '';
    this.playerVerticalVelocity = 0;
    this.playerGrounded = false;
    this.jumpRequested = false;
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
    this.playerVerticalVelocity = 0;
    this.playerGrounded = false;
    this.jumpRequested = false;
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
    const ground = this.strawSupportHeightAt(this.localPosition.x, this.localPosition.z);
    this.localPosition.y = ground;
    this.playerVerticalVelocity = 0;
    this.playerGrounded = true;
    this.camera.position.set(this.localPosition.x, ground + PLAYER_HEIGHT, this.localPosition.z);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    this.camera.updateMatrixWorld(true);
  }

  upsertPlayer(player: PlayerState): void {
    if (player.id === this.localPlayerId) return;
    const current = this.remotes.get(player.id);
    const position = new THREE.Vector3(
      player.position.x,
      Number.isFinite(player.position.y) && player.position.y > 0 ? player.position.y : this.strawSupportHeightAt(player.position.x, player.position.z),
      player.position.z,
    );
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
    remote.target.set(
      player.position.x,
      Number.isFinite(player.position.y) ? player.position.y : this.strawSupportHeightAt(player.position.x, player.position.z),
      player.position.z,
    );
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

  /** Returns the highest real straw capsule below the player's feet. */
  private strawSupportHeightAt(x: number, z: number, maxHeight = Number.POSITIVE_INFINITY): number {
    let highest = 0.035;
    const reach = PLAYER_FOOT_RADIUS + STRAW_HALF_LENGTH + 0.08;
    const minCellX = Math.floor((x - reach) / STRAW_CELL_SIZE);
    const maxCellX = Math.floor((x + reach) / STRAW_CELL_SIZE);
    const minCellZ = Math.floor((z - reach) / STRAW_CELL_SIZE);
    const maxCellZ = Math.floor((z + reach) / STRAW_CELL_SIZE);
    const finiteCeiling = Number.isFinite(maxHeight) ? maxHeight : 7.4;
    const maxCellY = Math.ceil((finiteCeiling + STRAW_HALF_LENGTH + 0.15) / STRAW_CELL_SIZE);

    for (let cellY = -1; cellY <= maxCellY; cellY += 1) {
      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
        for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
          const bucket = this.strawSpatial.get(this.strawCellKeyFromIndices(cellX, cellY, cellZ));
          if (!bucket) continue;
          for (const instanceId of bucket) {
            const offset = instanceId * 3;
            const quaternionOffset = instanceId * 4;
            const qx = this.strawQuaternions[quaternionOffset];
            const qy = this.strawQuaternions[quaternionOffset + 1];
            const qz = this.strawQuaternions[quaternionOffset + 2];
            const qw = this.strawQuaternions[quaternionOffset + 3];
            const axisX = 2 * (qx * qy - qw * qz);
            const axisY = 1 - 2 * (qx * qx + qz * qz);
            const axisZ = 2 * (qy * qz + qw * qx);
            const half = STRAW_HALF_LENGTH * this.strawScales[instanceId];
            const radius = STRAW_COLLIDER_RADIUS * this.strawScales[instanceId];
            const startX = this.strawPositions[offset] - axisX * half;
            const startY = this.strawPositions[offset + 1] - axisY * half;
            const startZ = this.strawPositions[offset + 2] - axisZ * half;
            const segmentX = axisX * half * 2;
            const segmentY = axisY * half * 2;
            const segmentZ = axisZ * half * 2;
            const horizontalLengthSq = segmentX * segmentX + segmentZ * segmentZ;
            const projected = horizontalLengthSq > 0.000001
              ? THREE.MathUtils.clamp(((x - startX) * segmentX + (z - startZ) * segmentZ) / horizontalLengthSq, 0, 1)
              : 0.5;
            const candidates = [projected, 0, 1];
            for (const amount of candidates) {
              const sampleX = startX + segmentX * amount;
              const sampleZ = startZ + segmentZ * amount;
              const dx = sampleX - x;
              const dz = sampleZ - z;
              if (dx * dx + dz * dz > (PLAYER_FOOT_RADIUS + radius) ** 2) continue;
              const support = startY + segmentY * amount + radius;
              if (support <= finiteCeiling + 0.015 && support > highest) highest = support;
            }
          }
        }
      }
    }
    return highest;
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
    const random = mulberry32((this.roundSeed ^ Math.imul(instanceId + 1, 0x9e3779b1)) >>> 0);
    let outwardX = this.strawPositions[offset];
    let outwardZ = this.strawPositions[offset + 2];
    let outwardLength = Math.hypot(outwardX, outwardZ);
    if (outwardLength < 0.2) {
      const launchAngle = random() * Math.PI * 2;
      outwardX = Math.cos(launchAngle); outwardZ = Math.sin(launchAngle); outwardLength = 1;
    }
    outwardX /= outwardLength; outwardZ /= outwardLength;
    const side = (random() - 0.5) * 0.72;
    const horizontalSpeed = 8.8 + random() * 3.7;
    this.strawVelocities[offset] = (outwardX - outwardZ * side) * horizontalSpeed;
    this.strawVelocities[offset + 1] = 8.7 + random() * 3.1;
    this.strawVelocities[offset + 2] = (outwardZ + outwardX * side) * horizontalSpeed;
    this.strawSpins[offset] = (random() - 0.5) * 25;
    this.strawSpins[offset + 1] = (random() - 0.5) * 25;
    this.strawSpins[offset + 2] = (random() - 0.5) * 25;
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
      if (this.goose.position.distanceTo(this.localPosition) < 10) {
        this.gooseState = 'panic';
        this.gooseStateTime = 3.8;
        this.goosePanicTime = this.clock.elapsedTime + 3.8;
      }
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
      if (this.goose.position.distanceTo(position) < 10) {
        this.gooseState = 'panic';
        this.gooseStateTime = 3.4;
        this.goosePanicTime = this.clock.elapsedTime + 3.4;
        this.gooseTarget.copy(this.goose.position).add(this.goose.position.clone().sub(position).setY(0).normalize().multiplyScalar(12));
      }
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
    mesh.position.set(origin.x, Math.max(0.11, origin.y + 0.11), origin.z);
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
    // A freshly pulled body is still the original pile instance, but gets a
    // brief clean launch corridor so it cannot be swallowed by dense neighbours.
    if (this.pulledStrawIds.has(instanceId) && this.strawActiveAges[instanceId] < 0.38) return false;
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
    if (radius > ARENA_RADIUS) {
      const arenaScale = ARENA_RADIUS / radius;
      this.localPosition.x *= arenaScale;
      this.localPosition.z *= arenaScale;
    }

    const stepHeight = this.playerGrounded ? 0.46 : 0.08;
    const support = this.strawSupportHeightAt(this.localPosition.x, this.localPosition.z, this.localPosition.y + stepHeight);
    if (this.jumpRequested) {
      if (this.playerGrounded) {
        this.playerVerticalVelocity = PLAYER_JUMP_SPEED;
        this.playerGrounded = false;
      }
      this.jumpRequested = false;
    }
    if (this.playerGrounded && this.localPosition.y > support + 0.065) this.playerGrounded = false;
    if (!this.playerGrounded) {
      this.playerVerticalVelocity -= PLAYER_GRAVITY * delta;
      this.localPosition.y += this.playerVerticalVelocity * delta;
      if (this.playerVerticalVelocity <= 0 && this.localPosition.y <= support + 0.025) {
        this.localPosition.y = support;
        this.playerVerticalVelocity = 0;
        this.playerGrounded = true;
      }
    } else {
      this.localPosition.y = support;
      this.playerVerticalVelocity = 0;
    }
    if (this.localPosition.y < 0.035) {
      this.localPosition.y = 0.035;
      this.playerVerticalVelocity = 0;
      this.playerGrounded = true;
    }
    this.footstep += moving ? delta * (sprinting ? 14 : 9) : delta * 2;
    const bob = this.playerGrounded
      ? (moving ? Math.sin(this.footstep) * 0.045 : Math.sin(elapsed * 1.8) * 0.014)
      : 0;
    this.camera.position.set(this.localPosition.x, this.localPosition.y + PLAYER_HEIGHT + bob, this.localPosition.z);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(this.pitch, this.yaw, moving ? Math.sin(this.footstep * 0.5) * 0.006 : 0);
    const targetFov = sprinting && moving ? 75 : 68;
    this.currentFov = THREE.MathUtils.lerp(this.currentFov, targetFov, 1 - Math.exp(-delta * 7));
    this.camera.fov = this.currentFov;
    this.camera.updateProjectionMatrix();

    if (elapsed * 1000 - this.lastMoveSent > 70) {
      this.callbacks.onMove({ x: this.localPosition.x, y: this.localPosition.y, z: this.localPosition.z }, this.yaw);
      this.lastMoveSent = elapsed * 1000;
    }
  }

  private updateGoose(delta: number, elapsed: number): void {
    this.gooseStateTime -= delta;
    this.gooseAbilityCooldown = Math.max(0, this.gooseAbilityCooldown - delta);
    const distanceToPlayer = this.goose.position.distanceTo(this.localPosition);

    if (elapsed < this.goosePanicTime) {
      this.gooseState = 'panic';
      const away = this.goose.position.clone().sub(this.localPosition).setY(0);
      if (away.lengthSq() < 0.01) away.set(1, 0, 0);
      this.gooseTarget.copy(this.goose.position).add(away.normalize().multiplyScalar(13));
    } else if (this.gooseStateTime <= 0) {
      this.gooseDecision += 1;
      const phase = this.gooseDecision % 6;
      if (this.playing && distanceToPlayer < 7.5 && (phase === 0 || phase === 3)) {
        this.gooseState = 'charge';
        this.gooseStateTime = 3.4;
      } else if (phase === 2) {
        this.gooseState = 'nap';
        this.gooseStateTime = 2.3;
        this.gooseTarget.copy(this.goose.position);
      } else if (phase === 1 || phase === 4) {
        this.gooseState = 'inspect';
        this.gooseStateTime = 4.6;
        const angle = elapsed * 0.51 + phase * 1.8;
        const radius = 3.8 + (phase % 2) * 2.4;
        this.gooseTarget.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      } else {
        this.gooseState = 'patrol';
        this.gooseStateTime = 5.5;
        const angle = elapsed * 0.27 + phase * 1.3;
        const radius = 10.5 + Math.sin(elapsed * 0.33) * 2.2;
        this.gooseTarget.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      }
    }

    if (this.gooseState === 'charge') this.gooseTarget.copy(this.localPosition);
    const desired = this.gooseTarget.clone().sub(this.goose.position).setY(0);
    const distanceToTarget = desired.length();
    if (distanceToTarget < 0.45 && this.gooseState !== 'charge' && this.gooseState !== 'nap') this.gooseStateTime = 0;
    const speedByState: Record<GooseState, number> = { patrol: 2.15, inspect: 1.4, charge: 6.7, nap: 0, panic: 7.6 };
    const desiredVelocity = distanceToTarget > 0.001
      ? desired.normalize().multiplyScalar(speedByState[this.gooseState])
      : new THREE.Vector3();
    this.gooseVelocity.lerp(desiredVelocity, 1 - Math.exp(-delta * (this.gooseState === 'panic' ? 8 : 4.8)));
    this.goose.position.addScaledVector(this.gooseVelocity, delta);
    const gooseRadius = Math.hypot(this.goose.position.x, this.goose.position.z);
    if (gooseRadius > 15.3) {
      this.goose.position.x *= 15.3 / gooseRadius;
      this.goose.position.z *= 15.3 / gooseRadius;
      this.gooseStateTime = 0;
    }
    const support = this.strawSupportHeightAt(this.goose.position.x, this.goose.position.z);
    const stride = Math.min(1, this.gooseVelocity.length() / 4);
    this.goose.position.y = support + 1.02 + Math.abs(Math.sin(elapsed * 8.8)) * 0.08 * stride;
    if (this.gooseVelocity.lengthSq() > 0.025) this.goose.rotation.y = Math.atan2(-this.gooseVelocity.z, this.gooseVelocity.x);

    const frantic = this.gooseState === 'panic' || this.gooseState === 'charge';
    const flap = Math.sin(elapsed * (frantic ? 18 : 7.5)) * (frantic ? 0.95 : 0.24);
    this.gooseWingLeft.rotation.x = flap;
    this.gooseWingRight.rotation.x = -flap;
    this.gooseWingLeft.rotation.z = frantic ? 0.32 : 0.02;
    this.gooseWingRight.rotation.z = frantic ? -0.32 : -0.02;
    const step = Math.sin(elapsed * (frantic ? 17 : 9)) * 0.52 * stride;
    this.gooseLegLeft.rotation.z = step;
    this.gooseLegRight.rotation.z = -step;
    this.gooseHead.rotation.z = this.gooseState === 'inspect'
      ? -0.42 + Math.sin(elapsed * 6) * 0.22
      : this.gooseState === 'nap' ? -0.78 : Math.sin(elapsed * 2.2) * 0.055;

    if (this.playing && distanceToPlayer < 3.2 && this.gooseAbilityCooldown <= 0) {
      this.gooseAbilityCooldown = frantic ? 2.4 : 4.8;
      this.createPulse(this.goose.position, frantic ? 0xff6b35 : 0xf5d657, frantic ? 3.1 : 2.1);
      this.createBurst(this.goose.position.clone().add(new THREE.Vector3(0.8, 1.1, 0)), frantic ? 58 : 28, 0xf4f0da);
      this.blastStraws(this.goose.position.clone().add(new THREE.Vector3(0, 0.3, 0)), 1.9, frantic ? 5.2 : 3.2);
    }
    if (this.playing && distanceToPlayer < (frantic ? 1.75 : 1.35) && elapsed - this.lastGooseHit > 3.6) {
      this.lastGooseHit = elapsed;
      const push = this.localPosition.clone().sub(this.goose.position).setY(0);
      if (push.lengthSq() < 0.01) push.set(1, 0, 0);
      this.localPosition.add(push.normalize().multiplyScalar(frantic ? 3.2 : 2.15));
      this.playerVerticalVelocity = Math.max(this.playerVerticalVelocity, frantic ? 2.3 : 1.2);
      this.playerGrounded = false;
      this.callbacks.onGooseHit();
      document.body.animate([{ filter: 'none' }, { filter: 'sepia(1) saturate(3)', transform: 'rotate(1.2deg)' }, { filter: 'none' }], { duration: 480 });
    }
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
    if (this.windmillRotor) this.windmillRotor.rotation.z -= delta * 0.72;
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
