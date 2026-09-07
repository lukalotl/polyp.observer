import {
  useCallback,
  useMemo,
  useRef,
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
import { galleryViewport } from "./galleryViewport";

/** Clear once before scissored views, including gaps and views that just unmounted. */
export function GalleryClear() {
  useFrame(({ gl, size }) => {
    gl.setScissorTest(false);
    gl.setViewport(0, 0, size.width, size.height);
    gl.setClearColor("#090f16", 1);
    gl.clear(true, true, true);
  }, 0.5);
  return null;
}

function RenderView({
  track,
  canvas,
  index,
}: {
  track: RefObject<HTMLDivElement>;
  canvas: RootState["size"];
  index: number;
}) {
  const rect = useRef<ReturnType<typeof galleryViewport>>();
  useFrame(({ gl, scene, camera }) => {
    if (!track.current) return;
    rect.current = galleryViewport(
      canvas,
      track.current.getBoundingClientRect(),
    );
    const { left, bottom, width, height, visible } = rect.current;
    if (!visible || width <= 0 || height <= 0) return;
    if (camera instanceof THREE.OrthographicCamera) {
      camera.left = -width / 2;
      camera.right = width / 2;
      camera.top = height / 2;
      camera.bottom = -height / 2;
      camera.updateProjectionMatrix();
    }
    const autoClear = gl.autoClear;
    gl.autoClear = false;
    gl.setViewport(left, bottom, width, height);
    gl.setScissor(left, bottom, width, height);
    gl.setScissorTest(true);
    gl.render(scene, camera);
    gl.setScissorTest(false);
    gl.autoClear = autoClear;
  }, index + 1);
  return null;
}

/** Isolated cameras and event coordinates, sharing one GPU context. */
export default function GalleryViewport({
  track,
  index,
  children,
}: {
  track: RefObject<HTMLDivElement>;
  index: number;
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
      // Suppress stale rays from other views, including clicks on UI overlays.
      state.raycaster.layers.mask = event.target === element ? 1 : 0;
      if (!element || event.target !== element) return;
      const bounds = element.getBoundingClientRect();
      state.pointer.set(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        (-(event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      state.raycaster.setFromCamera(state.pointer, state.camera);
    },
    [track],
  );
  return createPortal(
    <>
      {children}
      <RenderView track={track} canvas={size} index={index} />
    </>,
    scene,
    {
      events: { compute, priority: index + 1 },
      size: {
        width: rect?.width ?? 1,
        height: rect?.height ?? 1,
        top: rect?.top ?? 0,
        left: rect?.left ?? 0,
      },
    },
  );
}
