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
import DenseVolume from "./DenseVolume";
import {
  needsDenseRenderer,
  packDenseVolume,
} from "../rendering/denseVolumeData";
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
  /** Local display only. False preserves one timestep per spatial cell unit. */
  compressTime?: boolean;
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
  timeHeight,
  timeScale,
  autoRotate,
  resetKey,
  annotations,
  fitMode,
  view,
  occupiedBounds,
}: {
  latticeSize: number;
  layers: number;
  timeHeight: number;
  timeScale: number;
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
    timeScale: number;
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
      timeHeight,
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
      previous.view !== view ||
      previous.timeScale !== timeScale
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
      timeScale,
      fitMode,
      view,
      target: fit.target.clone(),
    };
    orbit.minZoom = fit.zoom * 0.48;
    orbit.maxZoom = Math.max(fit.zoom * 5, 48);
    // Include the user's current orbit distance when preserving camera position.
    camera.far = Math.max(
      fit.far,
      camera.position.distanceTo(orbit.target) * 4,
    );
    camera.updateProjectionMatrix();
    invalidate();
  }, [
    annotations,
    camera,
    invalidate,
    latticeSize,
    layers,
    timeHeight,
    timeScale,
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
  compressTime = false,
  fitMode = "world",
  view = "iso",
  onLayerSelect,
}: VolumeProps) {
  const { gl } = useThree();
  const dense = useMemo(
    () =>
      needsDenseRenderer(simulation)
        ? packDenseVolume(
            simulation,
            compressTime,
            Math.min(
              1024,
              gl
                .getContext()
                .getParameter(
                  (gl.getContext() as WebGL2RenderingContext)
                    .MAX_3D_TEXTURE_SIZE,
                ),
            ),
          )
        : null,
    [simulation, compressTime, gl],
  );
  const data = useMemo(
    () => (dense ? null : packVolume(simulation, compressTime)),
    [simulation, compressTime, dense],
  );
  const colors = useMemo(
    () =>
      data
        ? instanceColors(data, palette, simulation.layers.length)
        : new Float32Array(0),
    [data, palette, simulation.layers.length],
  );
  const count = data ? visibleCount(data, visibleLayers) : 0;
  const layout = (dense ?? data)!;
  return (
    <>
      <color attach="background" args={["#090f16"]} />
      <ambientLight intensity={0.48} color="#8da5a1" />
      <hemisphereLight args={["#c1c7cc", "#0a121a", 1.25]} />
      <directionalLight
        position={[-26, 65, 35]}
        intensity={2.4}
        color="#f5efd8"
      />
      <directionalLight
        position={[40, 20, -40]}
        intensity={0.48}
        color="#8da5a1"
      />
      <TechnicalStage
        size={simulation.size}
        timeLayout={layout.timeLayout}
        annotations={annotations}
        layerTimes={simulation.layerTimes}
        occupiedBounds={fitMode === "specimen" ? layout.bounds : null}
        specimen={fitMode === "specimen"}
      />
      {dense ? (
        <DenseVolume
          data={dense}
          visibleLayers={visibleLayers}
          palette={palette}
          grain={grain}
          mode={mode}
          onLayerSelect={onLayerSelect}
        />
      ) : (
        data &&
        (mode === "voxels" ? (
          <VoxelObject
            data={data}
            colors={colors}
            count={count}
            grain={grain}
            onLayerSelect={onLayerSelect}
          />
        ) : (
          <PointObject
            data={data}
            colors={colors}
            count={count}
            grain={grain}
            onLayerSelect={onLayerSelect}
          />
        ))
      )}
      <CameraRig
        latticeSize={simulation.size}
        layers={simulation.layers.length}
        timeHeight={layout.timeLayout.heights.at(-1) ?? 0}
        timeScale={layout.timeLayout.scale}
        autoRotate={autoRotate}
        resetKey={resetKey}
        annotations={annotations}
        fitMode={fitMode}
        view={view}
        occupiedBounds={layout.bounds}
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
        color: "#c1c7cc",
        background: "#090f16",
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
