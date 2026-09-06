import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { LAYER_HEIGHT } from "./volumeData";

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

/** A quiet floor, with an optional scientific reference frame and time axis. */
export default function TechnicalStage({
  size,
  layers,
  annotations = false,
}: {
  size: number;
  layers: number;
  annotations?: boolean;
}) {
  const half = size / 2 + 1.4;
  const floor = -0.53;
  const height = Math.max(1, layers - 1) * LAYER_HEIGHT + 0.5;
  const axisX = -half - 2.5;
  const axisZ = half + 1.7;
  const { grid, corners, axis, frame, ticks } = useMemo(() => {
    const grid: number[] = [];
    const corners: number[] = [];
    const axis: number[] = [];
    const frame: number[] = [];
    const ticks: { layer: number; position: Point3 }[] = [];
    if (!annotations) return { grid, corners, axis, frame, ticks };
    const line = (target: number[], a: Point3, b: Point3) =>
      target.push(...a, ...b);
    for (let i = -Math.floor(half / 5) * 5; i <= half; i += 5) {
      line(grid, [i, floor, -half], [i, floor, half]);
      line(grid, [-half, floor, i], [half, floor, i]);
    }
    const mark = 2.1;
    for (const x of [-half, half]) {
      for (const z of [-half, half]) {
        const sx = Math.sign(x);
        const sz = Math.sign(z);
        for (const y of [floor + 0.015, height]) {
          line(corners, [x, y, z], [x - sx * mark, y, z]);
          line(corners, [x, y, z], [x, y, z - sz * mark]);
          line(corners, [x, y, z], [x, y + (y === height ? -1 : 1) * mark, z]);
        }
        line(frame, [x, floor, z], [x, height, z]);
      }
    }
    line(axis, [axisX, floor, axisZ], [axisX, height + 1, axisZ]);
    const interval = Math.max(1, Math.round(layers / 6));
    const tickLayers = Array.from(
      { length: Math.ceil(layers / interval) },
      (_, i) => i * interval,
    );
    if (tickLayers[tickLayers.length - 1] !== layers - 1)
      tickLayers.push(layers - 1);
    tickLayers
      .filter((layer) => layer >= 0)
      .forEach((layer) => {
        const y = layer * LAYER_HEIGHT;
        line(axis, [axisX - 0.48, y, axisZ], [axisX + 0.48, y, axisZ]);
        ticks.push({ layer, position: [axisX - 1.8, y, axisZ] });
      });
    line(axis, [-half, floor, half + 2], [half, floor, half + 2]);
    line(axis, [half + 2, floor, -half], [half + 2, floor, half]);
    return { grid, corners, axis, frame, ticks };
  }, [annotations, axisX, axisZ, floor, half, height, layers]);

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

  return (
    <group>
      <mesh position={[0, -0.78, 0]}>
        <boxGeometry args={[half * 2 + 2.5, 0.4, half * 2 + 2.5]} />
        <meshStandardMaterial color="#14251e" roughness={1} metalness={0} />
      </mesh>
      <mesh position={[0, floor - 0.025, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[size * 1.24, size * 1.24]} />
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
              text={String(tick.layer).padStart(2, "0")}
              position={tick.position}
            />
          ))}
          <StageLabel
            text="t"
            position={[axisX, height + 2.5, axisZ]}
            scale={1.8}
            opacity={0.85}
          />
          <StageLabel
            text="X"
            position={[half + 2, floor, half + 2.7]}
            scale={1.4}
          />
          <StageLabel
            text="Y"
            position={[half + 3, floor, -half - 1]}
            scale={1.4}
          />
        </>
      )}
    </group>
  );
}
