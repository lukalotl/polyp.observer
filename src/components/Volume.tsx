import React, {
  Component,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Canvas, ThreeEvent, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import * as THREE from "three";
import TechnicalStage from "../rendering/TechnicalStage";
import {
  instanceColors,
  makePointMaterial,
  makeVoxelMaterial,
  VolumePalette,
} from "../rendering/materials";
import {
  LAYER_HEIGHT,
  packVolume,
  PackedVolume,
  visibleCount,
  VolumeSimulation,
} from "../rendering/volumeData";

export interface VolumeProps {
  simulation: VolumeSimulation;
  visibleLayers: number;
  palette: VolumePalette;
  mode: "voxels" | "points";
  grain: boolean;
  autoRotate: boolean;
  resetKey: number;
  onLayerSelect?: (layer: number) => void;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function CameraRig({
  latticeSize,
  layers,
  autoRotate,
  resetKey,
}: {
  latticeSize: number;
  layers: number;
  autoRotate: boolean;
  resetKey: number;
}) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, size, invalidate } = useThree();
  const previousFit = useRef<{
    zoom: number;
    resetKey: number;
    latticeSize: number;
    layers: number;
  }>();
  useLayoutEffect(() => {
    const orbit = controls.current;
    if (
      !orbit ||
      !(camera instanceof THREE.OrthographicCamera) ||
      size.width < 1 ||
      size.height < 1
    )
      return;
    const height = Math.max(1, layers - 1) * LAYER_HEIGHT;
    const target = new THREE.Vector3(0, height * 0.45, 0);
    // A low, composed axonometric view: time is vertical, both spatial axes remain legible.
    const reference = camera.clone();
    reference.position.set(
      latticeSize * 1.5,
      latticeSize * 0.7 + target.y,
      latticeSize * 1.8,
    );
    reference.lookAt(target);
    reference.updateMatrixWorld();
    const half = latticeSize / 2 + 1;
    const bounds = new THREE.Box3();
    for (const x of [-half, half])
      for (const y of [-1.5, height + 3.5])
        for (const z of [-half, half]) {
          bounds.expandByPoint(
            new THREE.Vector3(x, y, z).applyMatrix4(
              reference.matrixWorldInverse,
            ),
          );
        }
    const span = bounds.getSize(new THREE.Vector3());
    // Tight vertical framing lets the specimen, not empty lattice corners, be the hero.
    // Keep the wider horizontal safety margin for the time axis on narrow screens.
    const safeWidth = (span.x * (latticeSize + 12)) / (latticeSize + 2);
    const fit = Math.min(
      (size.width * 0.88) / safeWidth,
      (size.height * 0.92) / span.y,
    );
    const previous = previousFit.current;
    if (
      !previous ||
      previous.resetKey !== resetKey ||
      previous.latticeSize !== latticeSize ||
      previous.layers !== layers
    ) {
      const center = bounds.getCenter(new THREE.Vector3());
      const shift = new THREE.Vector3(
        center.x,
        center.y + (size.height * 0.02) / fit,
        0,
      ).applyQuaternion(reference.quaternion);
      camera.position.copy(reference.position).add(shift);
      camera.quaternion.copy(reference.quaternion);
      camera.zoom = fit;
      orbit.target.copy(target).add(shift);
      orbit.update();
      orbit.saveState();
    } else {
      // Keep the user's orbit/pan and relative zoom through container resizes.
      camera.zoom *= fit / previous.zoom;
    }
    previousFit.current = { zoom: fit, resetKey, latticeSize, layers };
    orbit.minZoom = fit * 0.48;
    orbit.maxZoom = fit * 5;
    camera.updateProjectionMatrix();
    invalidate();
  }, [
    camera,
    invalidate,
    latticeSize,
    layers,
    resetKey,
    size.height,
    size.width,
  ]);
  useEffect(() => {
    invalidate();
  }, [autoRotate, invalidate]);
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enablePan
      enableZoom
      enableDamping
      dampingFactor={0.08}
      rotateSpeed={0.55}
      zoomSpeed={0.8}
      panSpeed={0.75}
      minPolarAngle={0.12}
      maxPolarAngle={Math.PI * 0.49}
      autoRotate={autoRotate}
      autoRotateSpeed={0.5}
    />
  );
}

interface ObjectProps {
  data: PackedVolume;
  colors: Float32Array;
  count: number;
  grain: boolean;
  onLayerSelect?: (layer: number) => void;
}

function VoxelObject({
  data,
  colors,
  count,
  grain,
  onLayerSelect,
}: ObjectProps) {
  const { invalidate } = useThree();
  const geometry = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const surface = useMemo(makeVoxelMaterial, []);
  const mesh = useMemo(() => {
    const mesh = new THREE.InstancedMesh(
      geometry,
      surface.material,
      Math.max(1, data.count),
    );
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(
      data.matrices,
      16,
    ).setUsage(THREE.StaticDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(data.count * 3),
      3,
    ).setUsage(THREE.DynamicDrawUsage);
    mesh.count = data.count;
    mesh.computeBoundingSphere();
    return mesh;
  }, [data, geometry, surface]);
  useLayoutEffect(() => {
    if (mesh.instanceColor) {
      (mesh.instanceColor.array as Float32Array).set(colors);
      mesh.instanceColor.needsUpdate = true;
    }
    invalidate();
  }, [colors, invalidate, mesh]);
  useLayoutEffect(() => {
    mesh.count = count;
    invalidate();
  }, [count, invalidate, mesh]);
  useEffect(() => {
    surface.grain.value = grain ? 1 : 0;
    invalidate();
  }, [grain, invalidate, surface]);
  useEffect(
    () => () => {
      mesh.dispose();
    },
    [mesh],
  );
  useEffect(
    () => () => {
      geometry.dispose();
      surface.material.dispose();
    },
    [geometry, surface],
  );
  const selectLayer = (event: ThreeEvent<MouseEvent>) => {
    if (event.delta > 4 || event.instanceId === undefined) return;
    event.stopPropagation();
    onLayerSelect?.(data.layers[event.instanceId]);
  };
  return <primitive object={mesh} onClick={selectLayer} />;
}

function PointObject({
  data,
  colors,
  count,
  grain,
  onLayerSelect,
}: ObjectProps) {
  const { invalidate } = useThree();
  const surface = useMemo(makePointMaterial, []);
  const geometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(data.positions, 3),
    );
    geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(data.count * 3), 3).setUsage(
        THREE.DynamicDrawUsage,
      ),
    );
    geometry.computeBoundingSphere();
    return geometry;
  }, [data]);
  useLayoutEffect(() => {
    const attribute = geometry.getAttribute("color") as THREE.BufferAttribute;
    (attribute.array as Float32Array).set(colors);
    attribute.needsUpdate = true;
    invalidate();
  }, [colors, geometry, invalidate]);
  useLayoutEffect(() => {
    geometry.setDrawRange(0, count);
    invalidate();
  }, [count, geometry, invalidate]);
  useEffect(() => {
    surface.grain.value = grain ? 1 : 0;
    invalidate();
  }, [grain, invalidate, surface]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => surface.material.dispose(), [surface]);
  const selectLayer = (event: ThreeEvent<MouseEvent>) => {
    if (event.delta > 4 || event.index === undefined) return;
    event.stopPropagation();
    onLayerSelect?.(data.layers[event.index]);
  };
  return (
    <points
      geometry={geometry}
      material={surface.material}
      onClick={selectLayer}
    />
  );
}

function Scene({
  simulation,
  visibleLayers,
  palette,
  mode,
  grain,
  autoRotate,
  resetKey,
  onLayerSelect,
}: VolumeProps) {
  const data = useMemo(() => packVolume(simulation), [simulation]);
  const colors = useMemo(
    () => instanceColors(data, palette, simulation.layers.length),
    [data, palette, simulation.layers.length],
  );
  const count = visibleCount(data, visibleLayers);
  const props = { data, colors, count, grain, onLayerSelect };
  return (
    <>
      <color attach="background" args={["#101a17"]} />
      <ambientLight intensity={0.48} color="#b8c7b0" />
      <hemisphereLight args={["#d8e6ce", "#263d30", 1.25]} />
      <directionalLight
        position={[-26, 65, 35]}
        intensity={2.4}
        color="#f5efd8"
      />
      <directionalLight
        position={[40, 20, -40]}
        intensity={0.48}
        color="#85b49c"
      />
      <TechnicalStage
        size={simulation.size}
        layers={simulation.layers.length}
      />
      {mode === "voxels" ? (
        <VoxelObject {...props} />
      ) : (
        <PointObject {...props} />
      )}
      <CameraRig
        latticeSize={simulation.size}
        layers={simulation.layers.length}
        autoRotate={autoRotate}
        resetKey={resetKey}
      />
    </>
  );
}

function RendererFallback({
  message = "This browser could not start the 3D view.",
}: {
  message?: string;
}) {
  return (
    <div
      role="status"
      style={{
        position: "absolute",
        inset: 0,
        display: "grid",
        placeContent: "center",
        padding: 32,
        textAlign: "center",
        color: "#bfccba",
        background: "#101a17",
        lineHeight: 1.7,
      }}
    >
      <strong>THE VIEWPORT IS UNAVAILABLE</strong>
      <span>{message}</span>
      <span style={{ opacity: 0.65 }}>
        Your experiment is safe. Enable WebGL or reload to try again.
      </span>
    </div>
  );
}

class RendererBoundary extends Component<
  { children: React.ReactNode; resetKey: number },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    console.error("[polyp:renderer]", error);
  }
  componentDidUpdate(previous: { resetKey: number }) {
    if (previous.resetKey !== this.props.resetKey && this.state.failed)
      this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? <RendererFallback /> : this.props.children;
  }
}

/** A self-contained WebGL spacetime specimen; the host owns surrounding UI. */
export default function Volume(props: VolumeProps) {
  const reducedMotion = useReducedMotion();
  const [contextLost, setContextLost] = useState(false);
  const contextCleanup = useRef<(() => void) | null>(null);
  useEffect(() => {
    setContextLost(false);
  }, [props.resetKey]);
  useEffect(() => () => contextCleanup.current?.(), []);
  return (
    <RendererBoundary resetKey={props.resetKey}>
      {contextLost ? (
        <RendererFallback message="The graphics context was interrupted." />
      ) : (
        <Canvas
          orthographic
          camera={{ position: [60, 60, 75], zoom: 8, near: 0.1, far: 1000 }}
          dpr={[1, 1.5]}
          frameloop="demand"
          gl={{
            antialias: true,
            alpha: false,
            powerPreference: "high-performance",
          }}
          fallback={<RendererFallback />}
          onCreated={({ gl, raycaster }) => {
            gl.toneMapping = THREE.ACESFilmicToneMapping;
            gl.toneMappingExposure = 0.98;
            raycaster.params.Points = { threshold: 0.55 };
            const canvas = gl.domElement;
            const lost = (event: Event) => {
              event.preventDefault();
              setContextLost(true);
            };
            contextCleanup.current?.();
            canvas.addEventListener("webglcontextlost", lost);
            contextCleanup.current = () =>
              canvas.removeEventListener("webglcontextlost", lost);
          }}
        >
          <Scene {...props} autoRotate={props.autoRotate && !reducedMotion} />
        </Canvas>
      )}
    </RendererBoundary>
  );
}
