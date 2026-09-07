import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  type ReactNode,
  type RefObject,
} from "react";
import {
  createPortal,
  useFrame,
  useThree,
  type RootState,
} from "@react-three/fiber";
import * as THREE from "three";
import { galleryViewport, foregroundFrustum } from "./galleryViewport";

interface Projection {
  scene: THREE.Scene;
  camera: THREE.Camera;
  selected: boolean;
  dirty: boolean;
  rect: ReturnType<typeof galleryViewport> | null;
  target: THREE.WebGLRenderTarget | null;
  image: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
}
interface Composition {
  projections: Set<Projection>;
  scene: THREE.Scene;
}
const GalleryContext = createContext<Composition | null>(null);

/** One onscreen composition: flat neighbor projections, then an unclipped 3D foreground. */
export function GalleryComposition({ children }: { children: ReactNode }) {
  const composition = useMemo<Composition>(
    () => ({
      projections: new Set(),
      scene: new THREE.Scene(),
    }),
    [],
  );
  const camera = useMemo(() => {
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    camera.position.z = 10;
    return camera;
  }, []);
  useFrame(({ gl, size }) => {
    const autoClear = gl.autoClear;
    const clearColor = gl.getClearColor(new THREE.Color());
    const clearAlpha = gl.getClearAlpha();
    gl.autoClear = false;
    gl.setScissorTest(false);
    let foreground: Projection | undefined;
    for (const entry of composition.projections) {
      const rect = entry.rect;
      entry.image.visible = !entry.selected && Boolean(rect?.visible);
      if (!rect?.visible) continue;
      if (entry.selected) {
        foreground = entry;
        continue;
      }
      const width = Math.max(1, Math.ceil(rect.width * gl.getPixelRatio()));
      const height = Math.max(1, Math.ceil(rect.height * gl.getPixelRatio()));
      if (!entry.target) {
        entry.target = new THREE.WebGLRenderTarget(width, height, {
          depthBuffer: true,
        });
        entry.image.material.map = entry.target.texture;
        entry.image.material.needsUpdate = true;
        entry.dirty = true;
      } else if (
        entry.target.width !== width ||
        entry.target.height !== height
      ) {
        entry.target.setSize(width, height);
        entry.dirty = true;
      }
      if (entry.dirty) {
        const background = entry.scene.background;
        entry.scene.background = null;
        gl.setRenderTarget(entry.target);
        gl.setClearColor("#090f16", 0);
        gl.clear(true, true, true);
        gl.render(entry.scene, entry.camera);
        entry.scene.background = background;
        entry.dirty = false;
      }
      entry.image.position.set(
        rect.left + rect.width / 2 - size.width / 2,
        rect.bottom + rect.height / 2 - size.height / 2,
        0,
      );
      entry.image.scale.set(rect.width, rect.height, 1);
    }
    gl.setRenderTarget(null);
    gl.setViewport(0, 0, size.width, size.height);
    gl.setClearColor("#090f16", 1);
    gl.clear(true, true, true);
    camera.left = -size.width / 2;
    camera.right = size.width / 2;
    camera.top = size.height / 2;
    camera.bottom = -size.height / 2;
    camera.updateProjectionMatrix();
    gl.render(composition.scene, camera);
    if (foreground) {
      // Only background projections are flat. Keep the selected specimen's full
      // depth buffer and camera interaction, with no per-slot scissor boundary.
      const background = foreground.scene.background;
      foreground.scene.background = null;
      gl.clearDepth();
      gl.render(foreground.scene, foreground.camera);
      foreground.scene.background = background;
    }
    gl.setClearColor(clearColor, clearAlpha);
    gl.autoClear = autoClear;
  }, 1);
  return (
    <GalleryContext.Provider value={composition}>
      {children}
    </GalleryContext.Provider>
  );
}

function ProjectionView({
  track,
  canvas,
  selected,
}: {
  track: RefObject<HTMLDivElement>;
  canvas: RootState["size"];
  selected: boolean;
}) {
  const composition = useContext(GalleryContext)!;
  const { scene, camera, invalidate } = useThree();
  const entry = useMemo<Projection>(
    () => ({
      scene,
      camera,
      selected,
      dirty: true,
      rect: null,
      target: null,
      image: new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          transparent: true,
          depthWrite: false,
          toneMapped: false,
        }),
      ),
    }),
    [scene, camera],
  );
  useLayoutEffect(() => {
    composition.projections.add(entry);
    composition.scene.add(entry.image);
    invalidate();
    return () => {
      composition.projections.delete(entry);
      composition.scene.remove(entry.image);
      entry.target?.dispose();
      entry.image.geometry.dispose();
      entry.image.material.dispose();
    };
  }, [composition, entry, invalidate]);
  useLayoutEffect(() => {
    entry.selected = selected;
    entry.dirty = true;
    invalidate();
  });
  // After OrbitControls, before dense volume uniforms read the projection matrix.
  useFrame(() => {
    if (!track.current) return;
    const rect = galleryViewport(canvas, track.current.getBoundingClientRect());
    if (entry.rect?.width !== rect.width || entry.rect?.height !== rect.height)
      entry.dirty = true;
    entry.rect = rect;
    if (!(camera instanceof THREE.OrthographicCamera)) return;
    if (selected) {
      Object.assign(camera, foregroundFrustum(canvas, rect, camera.zoom));
    } else {
      camera.left = -rect.width / 2;
      camera.right = rect.width / 2;
      camera.top = rect.height / 2;
      camera.bottom = -rect.height / 2;
    }
    camera.updateProjectionMatrix();
  }, -0.5);
  return null;
}

/** Source cameras render neighbors into reusable flat projections on the shared canvas. */
export default function GalleryViewport({
  track,
  index,
  selected,
  children,
}: {
  track: RefObject<HTMLDivElement>;
  index: number;
  selected: boolean;
  children: ReactNode;
}) {
  const size = useThree((state) => state.size);
  const scene = useMemo(() => new THREE.Scene(), []);
  const rect = track.current?.getBoundingClientRect();
  const compute = useCallback(
    (
      event: { target: EventTarget | null; clientX: number; clientY: number },
      state: RootState,
    ) => {
      const element = track.current;
      state.raycaster.layers.mask = event.target === element ? 1 : 0;
      if (!element || event.target !== element) return;
      const bounds = selected ? size : element.getBoundingClientRect();
      state.pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        (-(event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      state.raycaster.setFromCamera(state.pointer, state.camera);
    },
    [track, selected, size],
  );
  return createPortal(
    <>
      {children}
      <ProjectionView track={track} canvas={size} selected={selected} />
    </>,
    scene,
    {
      events: { compute, priority: selected ? 1000 : index + 1 },
      size: {
        width: rect?.width ?? 1,
        height: rect?.height ?? 1,
        top: rect?.top ?? 0,
        left: rect?.left ?? 0,
      },
    },
  );
}
