import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { VolumeBounds } from "./volumeData";

export default function SimulationBounds({
  bounds,
  size,
  ceiling,
}: {
  bounds: VolumeBounds;
  size: number;
  ceiling?: number;
}) {
  const box = useMemo(
    () =>
      new THREE.Box3Helper(
        new THREE.Box3(
          new THREE.Vector3(...bounds.min),
          new THREE.Vector3(...bounds.max),
        ),
        new THREE.Color("#a596bf"),
      ),
    [bounds],
  );
  const rim = useMemo(
    () =>
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-size / 2, 0, -size / 2),
        new THREE.Vector3(size / 2, 0, -size / 2),
        new THREE.Vector3(size / 2, 0, size / 2),
        new THREE.Vector3(-size / 2, 0, size / 2),
      ]),
    [size],
  );
  useEffect(
    () => () => {
      box.geometry.dispose();
      (box.material as THREE.Material).dispose();
    },
    [box],
  );
  useEffect(() => () => rim.dispose(), [rim]);
  return (
    <group>
      <primitive object={box} />
      {ceiling !== undefined && (
        <group position={[0, ceiling, 0]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[size, size]} />
            <meshBasicMaterial
              color="#ef4658"
              transparent
              opacity={0.12}
              side={THREE.DoubleSide}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
          <lineLoop geometry={rim}>
            <lineBasicMaterial
              color="#ef4658"
              transparent
              opacity={0.85}
              depthWrite={false}
              toneMapped={false}
            />
          </lineLoop>
        </group>
      )}
    </group>
  );
}
