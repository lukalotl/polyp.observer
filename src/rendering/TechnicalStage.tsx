import { useEffect, useMemo } from "react";
import * as THREE from "three";
import {
  layerTimeLabel,
  referenceScale,
  type VolumeBounds,
  type TimeLayout,
} from "./volumeData";

type Point3 = [number, number, number];

function Segments({
  points,
  color,
  opacity = 1,
}: {
  points: number[];
  color: string;
  opacity?: number;
}) {
  const geometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(points, 3),
    );
    return geometry;
  }, [points]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial
        color={color}
        transparent
        opacity={opacity}
        depthWrite={false}
        toneMapped={false}
      />
    </lineSegments>
  );
}

function StageLabel({
  text,
  position,
  scale = 1.8,
  opacity = 0.72,
}: {
  text: string;
  position: Point3;
  scale?: number;
  opacity?: number;
}) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (context) {
      context.font = "40px monospace";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = "#a4b9a6";
      context.fillText(text, 80, 33);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }, [text]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <sprite position={position} scale={[scale * 2.5, scale, 1]}>
      <spriteMaterial
        map={texture}
        transparent
        opacity={opacity}
        depthWrite={false}
        toneMapped={false}
      />
    </sprite>
  );
}

/** Optional spatial frame; sampled layer heights never stand in for actual CA time labels. */
export default function TechnicalStage({
  size,
  timeLayout,
  annotations = false,
  layerTimes,
  occupiedBounds,
  specimen = false,
}: {
  size: number;
  timeLayout: TimeLayout;
  annotations?: boolean;
  layerTimes?: number[];
  occupiedBounds?: VolumeBounds | null;
  specimen?: boolean;
}) {
  const extent = size / 2 + 1.4;
  const minX = occupiedBounds ? occupiedBounds.min[0] - 0.4 : -extent;
  const maxX = occupiedBounds ? occupiedBounds.max[0] + 0.4 : extent;
  const minZ = occupiedBounds ? occupiedBounds.min[2] - 0.4 : -extent;
  const maxZ = occupiedBounds ? occupiedBounds.max[2] + 0.4 : extent;
  const floor = occupiedBounds ? occupiedBounds.min[1] - 0.2 : -0.53;
  const height = occupiedBounds
    ? occupiedBounds.max[1] + 0.17
    : (timeLayout.heights.at(-1) ?? 0) + 0.5;
  const scale = referenceScale(
    size,
    timeLayout.heights.at(-1) ?? 0,
    occupiedBounds,
  );
  const axisX = minX - 2.5 * scale;
  const axisZ = maxZ + 1.7 * scale;
  const { grid, corners, axis, frame, ticks } = useMemo(() => {
    const grid: number[] = [],
      corners: number[] = [],
      axis: number[] = [],
      frame: number[] = [];
    const ticks: { layer: number; position: Point3 }[] = [];
    if (!annotations) return { grid, corners, axis, frame, ticks };
    const line = (target: number[], a: Point3, b: Point3) =>
      target.push(...a, ...b);
    for (let x = Math.ceil(minX / 5) * 5; x <= maxX; x += 5)
      line(grid, [x, floor, minZ], [x, floor, maxZ]);
    for (let z = Math.ceil(minZ / 5) * 5; z <= maxZ; z += 5)
      line(grid, [minX, floor, z], [maxX, floor, z]);
    const mark = Math.min(2.1, (maxX - minX) / 4, (maxZ - minZ) / 4);
    for (const x of [minX, maxX])
      for (const z of [minZ, maxZ]) {
        const sx = x === minX ? -1 : 1,
          sz = z === minZ ? -1 : 1;
        for (const y of [floor + 0.015, height]) {
          line(corners, [x, y, z], [x - sx * mark, y, z]);
          line(corners, [x, y, z], [x, y, z - sz * mark]);
          line(corners, [x, y, z], [x, y + (y === height ? -1 : 1) * mark, z]);
        }
        line(frame, [x, floor, z], [x, height, z]);
      }
    line(axis, [axisX, floor, axisZ], [axisX, height + scale, axisZ]);
    const visible = timeLayout.heights.flatMap((y, index) =>
      y >= floor && y <= height ? [index] : [],
    );
    const interval = Math.max(1, Math.ceil((visible.length - 1) / 6));
    const tickLayers = visible.filter((_, index) => index % interval === 0);
    const last = visible.at(-1);
    if (last !== undefined && tickLayers.at(-1) !== last) tickLayers.push(last);
    tickLayers.forEach((layer) => {
      const y = timeLayout.heights[layer];
      line(
        axis,
        [axisX - 0.48 * scale, y, axisZ],
        [axisX + 0.48 * scale, y, axisZ],
      );
      ticks.push({ layer, position: [axisX - 1.8 * scale, y, axisZ] });
    });
    line(
      axis,
      [minX, floor, maxZ + 2 * scale],
      [maxX, floor, maxZ + 2 * scale],
    );
    line(
      axis,
      [maxX + 2 * scale, floor, minZ],
      [maxX + 2 * scale, floor, maxZ],
    );
    return { grid, corners, axis, frame, ticks };
  }, [
    annotations,
    axisX,
    axisZ,
    floor,
    height,
    timeLayout,
    scale,
    minX,
    maxX,
    minZ,
    maxZ,
  ]);
  const shadow = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const context = canvas.getContext("2d");
    if (context) {
      const gradient = context.createRadialGradient(64, 64, 4, 64, 64, 64);
      gradient.addColorStop(0, "rgba(0,0,0,0.48)");
      gradient.addColorStop(0.42, "rgba(0,0,0,0.30)");
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 128, 128);
    }
    return new THREE.CanvasTexture(canvas);
  }, []);
  useEffect(() => () => shadow.dispose(), [shadow]);

  // Annotation-free specimen mode shows only the data, not a large empty world plinth.
  if (specimen && !annotations) return null;
  return (
    <group>
      <mesh position={[(minX + maxX) / 2, floor - 0.25, (minZ + maxZ) / 2]}>
        <boxGeometry
          args={[
            maxX - minX + (specimen ? 0.4 : 2.5),
            0.4,
            maxZ - minZ + (specimen ? 0.4 : 2.5),
          ]}
        />
        <meshStandardMaterial color="#14251e" roughness={1} metalness={0} />
      </mesh>
      <mesh
        position={[(minX + maxX) / 2, floor - 0.025, (minZ + maxZ) / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <planeGeometry args={[maxX - minX, maxZ - minZ]} />
        <meshBasicMaterial
          map={shadow}
          transparent
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      {annotations && (
        <>
          <Segments points={grid} color="#64816d" opacity={0.16} />
          <Segments points={frame} color="#73947d" opacity={0.105} />
          <Segments points={corners} color="#91ae96" opacity={0.44} />
          <Segments points={axis} color="#7d9a84" opacity={0.32} />
          {ticks.map((tick) => (
            <StageLabel
              key={tick.layer}
              text={layerTimeLabel(tick.layer, layerTimes)}
              position={tick.position}
              scale={1.8 * scale}
            />
          ))}
          <StageLabel
            text="Y (t)"
            position={[axisX, height + 2.5 * scale, axisZ]}
            scale={1.8 * scale}
            opacity={0.85}
          />
          <StageLabel
            text="X"
            position={[maxX + 2 * scale, floor, maxZ + 2.7 * scale]}
            scale={1.4 * scale}
          />
          <StageLabel
            text="Z"
            position={[maxX + 3 * scale, floor, minZ - scale]}
            scale={1.4 * scale}
          />
        </>
      )}
    </group>
  );
}
