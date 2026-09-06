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
  fitVolumeCamera,
  type VolumeFitMode,
  type VolumeView,
} from "../rendering/cameraFit";
import {
  instanceColors,
  makePointMaterial,
  makeVoxelMaterial,
  VolumePalette,
} from "../rendering/materials";
import {
  packVolume,
  PackedVolume,
  visibleCount,
  VolumeSimulation,
  VolumeBounds,
} from "../rendering/volumeData";

export interface VolumeProps {
  simulation: VolumeSimulation;
  visibleLayers: number;
  palette: VolumePalette;
  mode: "voxels" | "points";
  grain: boolean;
  autoRotate: boolean;
  resetKey: number;
  annotations?: boolean;
  fitMode?: VolumeFitMode;
  view?: VolumeView;
  /** Sampled array index, not the actual CA time in simulation.layerTimes. */
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
  annotations,
  fitMode,
  view,
  occupiedBounds,
}: {
  latticeSize: number;
  layers: number;
  autoRotate: boolean;
  resetKey: number;
  annotations: boolean;
  fitMode: VolumeFitMode;
  view: VolumeView;
  occupiedBounds: VolumeBounds | null;
}) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, size, invalidate } = useThree();
  const previousFit = useRef<{
    zoom: number;
    resetKey: number;
    fitMode: VolumeFitMode;
    view: VolumeView;
    target: THREE.Vector3;
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
    const fit = fitVolumeCamera({
      latticeSize,
      layers,
      width: size.width,
      height: size.height,
      annotations,
      fitMode,
      view,
      occupiedBounds,
    });
    const previous = previousFit.current;
    if (
      !previous ||
      previous.resetKey !== resetKey ||
      previous.fitMode !== fitMode ||
      previous.view !== view
    ) {
      camera.up.set(0, view === "top" ? 0 : 1, view === "top" ? -1 : 0);
      camera.position.copy(fit.position);
      camera.quaternion.copy(fit.quaternion);
      camera.zoom = fit.zoom;
      orbit.target.copy(fit.target);
      orbit.update();
      orbit.saveState();
    } else {
      // Preserve orbit, relative pan and relative zoom through resizes and evolving bounds.
      const shift = fit.target.clone().sub(previous.target);
      camera.position.add(shift);
      orbit.target.add(shift);
      camera.zoom *= fit.zoom / previous.zoom;
      orbit.update();
    }
    previousFit.current = {
      zoom: fit.zoom,
      resetKey,
      fitMode,
      view,
      target: fit.target.clone(),
    };
    orbit.minZoom = fit.zoom * 0.48;
    orbit.maxZoom = fit.zoom * 5;
    camera.updateProjectionMatrix();
    invalidate();
  }, [
    annotations,
    camera,
    invalidate,
    latticeSize,
    layers,
    fitMode,
    view,
    occupiedBounds,
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
      minPolarAngle={0}
      maxPolarAngle={Math.PI}
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
  annotations = false,
  fitMode = "world",
  view = "iso",
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
        annotations={annotations}
        layerTimes={simulation.layerTimes}
        occupiedBounds={fitMode === "specimen" ? data.bounds : null}
        specimen={fitMode === "specimen"}
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
        annotations={annotations}
        fitMode={fitMode}
        view={view}
        occupiedBounds={data.bounds}
      />
    </>
  );
}

function RendererFallback({
  message = "WebGL could not start. Enable it or reload.",
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
      <strong>3D view unavailable</strong>
      <span>{message}</span>
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
        <RendererFallback message="WebGL context lost. Reload to retry." />
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
