import React, {
  Component,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useId,
  createRef,
  useCallback,
} from "react";
import { Canvas, ThreeEvent, useThree } from "@react-three/fiber";
import { OrbitControls, OrthographicCamera } from "@react-three/drei";
import GalleryViewport, { GalleryClear } from "../rendering/GalleryViewport";
import { galleryLayout, galleryWindow } from "../research/gallery";
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
  gallery?: {
    items: {
      id: string;
      label: string;
      simulation?: VolumeSimulation;
      error?: string;
    }[];
    index: number;
    onSelect: (index: number) => void;
    onVisibleChange?: (indices: number[]) => void;
  };
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
  interactive = true,
  viewportSize,
  domElement,
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
  interactive?: boolean;
  viewportSize?: { width: number; height: number };
  domElement?: HTMLElement;
}) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, size: canvasSize, invalidate } = useThree();
  const size = viewportSize ?? canvasSize;
  const previousFit = useRef<{
    camera: THREE.Camera;
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
      previous.camera !== camera ||
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
      camera,
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
      enabled={interactive}
      domElement={domElement}
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
  boxed = false,
  interactive = true,
  viewportSize,
  domElement,
}: VolumeProps & {
  boxed?: boolean;
  interactive?: boolean;
  viewportSize?: { width: number; height: number };
  domElement?: HTMLElement;
}) {
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
      {!boxed && (
        <TechnicalStage
          size={simulation.size}
          timeLayout={layout.timeLayout}
          annotations={annotations}
          layerTimes={simulation.layerTimes}
          occupiedBounds={fitMode === "specimen" ? layout.bounds : null}
          specimen={fitMode === "specimen"}
        />
      )}
      {boxed && <ContentBounds bounds={layout.bounds} size={simulation.size} />}
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
        interactive={interactive}
        viewportSize={viewportSize}
        domElement={domElement}
      />
    </>
  );
}

function ContentBounds({
  bounds,
  size,
}: {
  bounds: VolumeBounds | null;
  size: number;
}) {
  const box = useMemo(() => {
    const padding = Math.max(0.4, size * 0.018);
    const box = bounds
      ? new THREE.Box3(
          new THREE.Vector3(...bounds.min),
          new THREE.Vector3(...bounds.max),
        ).expandByScalar(padding)
      : new THREE.Box3(
          new THREE.Vector3(-1, -1, -1),
          new THREE.Vector3(1, 1, 1),
        );
    return new THREE.Box3Helper(box, new THREE.Color("#a596bf"));
  }, [bounds, size]);
  useEffect(
    () => () => {
      box.geometry.dispose();
      (box.material as THREE.Material).dispose();
    },
    [box],
  );
  return <primitive object={box} />;
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
  const host = useRef<HTMLDivElement>(null!);
  const track = useRef<HTMLDivElement>(null);
  const invalidate = useRef<() => void>(() => {});
  const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 });
  const id = useId();
  const gallery = props.gallery;
  const [visibleIndices, setVisibleIndices] = useState<number[]>([]);
  const { itemWidth, inset } = galleryLayout(
    gallery?.items.length ?? 0,
    viewportSize.width,
  );
  const updateVisible = useCallback(() => {
    const element = track.current;
    if (!element) return;
    const next = galleryWindow(
      gallery?.items.length ?? 0,
      element.clientWidth,
      element.scrollLeft,
    );
    setVisibleIndices((previous) =>
      previous.length === next.length &&
      previous.every((index, offset) => index === next[offset])
        ? previous
        : next,
    );
  }, [gallery?.items.length]);
  useEffect(() => {
    gallery?.onVisibleChange?.(visibleIndices);
  }, [gallery?.onVisibleChange, visibleIndices]);
  const lastSelection = useRef<string>();
  const pointerStart = useRef<[number, number]>([0, 0]);
  const scrollTarget = useRef(0);
  const manualScroll = useRef(false);
  const scrollTimer = useRef<ReturnType<typeof setTimeout>>();
  const viewTracks = useRef(new Map<string, React.RefObject<HTMLDivElement>>());
  function viewTrack(key: string) {
    if (!viewTracks.current.has(key))
      viewTracks.current.set(key, createRef<HTMLDivElement>());
    return viewTracks.current.get(key)!;
  }
  useEffect(() => {
    const ids = new Set(gallery?.items.map((item) => item.id));
    for (const key of viewTracks.current.keys())
      if (!ids.has(key)) viewTracks.current.delete(key);
  }, [gallery?.items]);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setViewportSize({
        width: element.clientWidth,
        height: element.clientHeight,
      });
      invalidate.current();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!gallery || !track.current) return;
    clearTimeout(scrollTimer.current);
    manualScroll.current = false;
    const element = track.current.children[gallery.index] as
      | HTMLElement
      | undefined;
    if (!element) return;
    const identity = gallery.items[gallery.index]?.id;
    scrollTarget.current = Math.max(
      0,
      Math.min(
        track.current.scrollWidth - track.current.clientWidth,
        element.offsetLeft +
          element.offsetWidth / 2 -
          track.current.clientWidth / 2,
      ),
    );
    track.current.scrollTo({
      left: scrollTarget.current,
      behavior:
        !reducedMotion &&
        lastSelection.current &&
        lastSelection.current !== identity
          ? "smooth"
          : "instant",
    });
    lastSelection.current = identity;
    updateVisible();
    invalidate.current();
  }, [
    gallery?.index,
    gallery?.items.length,
    gallery?.items[gallery.index]?.id,
    viewportSize.width,
    reducedMotion,
    updateVisible,
  ]);
  useEffect(() => {
    setContextLost(false);
  }, [props.resetKey]);
  useEffect(() => () => contextCleanup.current?.(), []);
  useEffect(() => () => clearTimeout(scrollTimer.current), []);
  return (
    <RendererBoundary resetKey={props.resetKey}>
      <div
        ref={host}
        className="model-gallery"
        role={gallery ? "listbox" : undefined}
        aria-label={gallery ? "3D model gallery" : undefined}
        aria-orientation={gallery ? "horizontal" : undefined}
        aria-activedescendant={gallery ? `${id}-${gallery.index}` : undefined}
        tabIndex={gallery ? 0 : undefined}
      >
        {gallery && (
          <div
            ref={track}
            className="model-gallery-track"
            style={
              {
                "--gallery-item-width": `${itemWidth}px`,
                paddingInline: inset,
              } as React.CSSProperties
            }
            onWheelCapture={(event) => {
              if (Math.abs(event.deltaX) > Math.abs(event.deltaY))
                manualScroll.current = true;
            }}
            onTouchMove={() => {
              manualScroll.current = true;
            }}
            onScroll={() => {
              invalidate.current();
              updateVisible();
              clearTimeout(scrollTimer.current);
              // Camera/keyboard navigation may pause between animation frames
              // while new specimens mount. Only user scrolling picks a new item.
              if (!manualScroll.current) return;
              scrollTimer.current = setTimeout(() => {
                const element = track.current;
                if (
                  !element ||
                  Math.abs(element.scrollLeft - scrollTarget.current) < 2
                )
                  return;
                manualScroll.current = false;
                gallery.onSelect(
                  Math.max(
                    0,
                    Math.min(
                      gallery.items.length - 1,
                      Math.round(
                        (element.scrollLeft + element.clientWidth / 2 - inset) /
                          itemWidth -
                          0.5,
                      ),
                    ),
                  ),
                );
              }, 160);
            }}
          >
            {gallery.items.map((item, index) => {
              const selected = gallery.index === index;
              const visible = visibleIndices.includes(index);
              return (
                <div
                  key={item.id}
                  id={`${id}-${index}`}
                  className={`model-gallery-item ${selected ? "selected" : ""}`}
                  role="option"
                  aria-selected={selected}
                  data-rendered={visible && Boolean(item.simulation)}
                  aria-label={`Model ${index + 1}: ${item.id}, ${item.label}`}
                  onPointerDown={(event) => {
                    pointerStart.current = [event.clientX, event.clientY];
                    host.current?.focus({ preventScroll: true });
                  }}
                  onClick={(event) => {
                    if (
                      Math.hypot(
                        event.clientX - pointerStart.current[0],
                        event.clientY - pointerStart.current[1],
                      ) < 5 &&
                      (!selected || item.error)
                    )
                      gallery.onSelect(index);
                  }}
                >
                  <div className="model-view" ref={viewTrack(item.id)} />
                  {(!visible || !item.simulation) && (
                    <div className="model-placeholder">
                      <span>
                        {item.error
                          ? "Preview unavailable · select to retry"
                          : visible
                            ? "Loading model…"
                            : "Select to preview"}
                      </span>
                    </div>
                  )}
                  <div className="model-caption">
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <span title={item.id}>{item.id}</span>
                    <span>{item.label}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {contextLost ? (
          <RendererFallback message="WebGL context lost. Reload to retry." />
        ) : (
          <Canvas
            style={
              gallery
                ? { position: "absolute", inset: 0, pointerEvents: "none" }
                : undefined
            }
            eventSource={gallery ? host : undefined}
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
            onCreated={({ gl, raycaster, invalidate: requestFrame }) => {
              invalidate.current = requestFrame;
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
            {gallery ? (
              <>
                <GalleryClear />
                {gallery.items.map((item, index) => {
                  if (!visibleIndices.includes(index) || !item.simulation)
                    return null;
                  const selected = gallery.index === index;
                  const element = viewTrack(item.id);
                  return (
                    <GalleryViewport
                      key={item.id}
                      track={element}
                      index={index}
                    >
                      <OrthographicCamera
                        makeDefault
                        position={[60, 60, 75]}
                        zoom={8}
                        near={0.1}
                        far={1000}
                      />
                      <Scene
                        {...props}
                        simulation={item.simulation}
                        visibleLayers={
                          selected
                            ? props.visibleLayers
                            : item.simulation.layers.length
                        }
                        boxed={!selected}
                        interactive={selected}
                        annotations={selected && props.annotations}
                        autoRotate={
                          selected && props.autoRotate && !reducedMotion
                        }
                        domElement={element.current ?? undefined}
                        viewportSize={{
                          width: itemWidth * (selected ? 1 : 0.86),
                          height:
                            Math.max(1, viewportSize.height - 42) *
                            (selected ? 1 : 0.86),
                        }}
                        onLayerSelect={
                          selected
                            ? props.onLayerSelect
                            : () => gallery.onSelect(index)
                        }
                      />
                    </GalleryViewport>
                  );
                })}
              </>
            ) : (
              <Scene
                {...props}
                autoRotate={props.autoRotate && !reducedMotion}
              />
            )}
          </Canvas>
        )}
      </div>
    </RendererBoundary>
  );
}
