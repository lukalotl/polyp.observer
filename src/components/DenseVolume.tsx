import { useEffect, useMemo } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { paletteColors, type VolumePalette } from "../rendering/materials";
import {
  pickDenseLayer,
  type DenseVolumeData,
} from "../rendering/denseVolumeData";

const vertexShader = `
out vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;
const fragmentShader = `
precision highp sampler3D;
in vec3 vWorld;
out vec4 fragmentColor;
uniform sampler3D uCells;
uniform ivec3 uTextureSize;
uniform int uSize;
uniform int uLayers;
uniform int uVisible;
uniform float uTimeScale;
uniform vec3 uDirection;
uniform mat4 uViewProjection;
uniform vec3 uColors[15];
uniform float uGrain;
uniform bool uPoints;
uniform float uPointRadius;
int stateAt(ivec3 p) {
  int index = p.y * uSize * uSize + p.z * uSize + p.x;
  ivec3 texel = ivec3(index % uTextureSize.x, (index / uTextureSize.x) % uTextureSize.y,
    index / (uTextureSize.x * uTextureSize.y));
  return int(texelFetch(uCells, texel, 0).r * 255.0 + 0.5);
}
void main() {
  if (uVisible == 0) discard;
  vec3 ray = normalize(uDirection);
  vec3 worldOrigin = vWorld - ray * (float(uSize * 2) + float(uLayers) * uTimeScale + 2.0);
  vec3 origin = vec3(worldOrigin.x + float(uSize) / 2.0, worldOrigin.y / uTimeScale + 0.5, worldOrigin.z + float(uSize) / 2.0);
  vec3 direction = vec3(ray.x, ray.y / uTimeScale, ray.z);
  // Zero components must not create NaNs on a box face in top/front views.
  vec3 safeDirection = vec3(direction.x == 0.0 ? 1e-20 : direction.x,
    direction.y == 0.0 ? 1e-20 : direction.y, direction.z == 0.0 ? 1e-20 : direction.z);
  vec3 inv = 1.0 / safeDirection;
  vec3 a = -origin * inv, b = (vec3(uSize, uVisible, uSize) - origin) * inv;
  vec3 entry = min(a, b), exit = max(a, b);
  float travel = max(max(entry.x, entry.y), max(entry.z, 0.0));
  float finish = min(exit.x, min(exit.y, exit.z));
  if (travel > finish) discard;
  ivec3 cell = ivec3(clamp(floor(origin + direction * (travel + 0.0001)), vec3(0), vec3(uSize - 1, uVisible - 1, uSize - 1)));
  ivec3 stepDirection = ivec3(sign(direction));
  vec3 delta = abs(inv);
  vec3 next = (vec3(cell) + max(vec3(stepDirection), vec3(0)) - origin) * inv;
  if (direction.x == 0.0) next.x = 1e30;
  if (direction.y == 0.0) next.y = 1e30;
  if (direction.z == 0.0) next.z = 1e30;
  vec3 normal = entry.x >= entry.y && entry.x >= entry.z ? vec3(-sign(direction.x), 0, 0) :
    entry.y >= entry.z ? vec3(0, -sign(direction.y), 0) : vec3(0, 0, -sign(direction.z));
  // The DDA visits every crossed lattice cell, including every time step.
  for (int iteration = 0; iteration < uSize * 2 + uVisible + 3; iteration++) {
    if (any(lessThan(cell, ivec3(0))) || any(greaterThanEqual(cell, ivec3(uSize, uVisible, uSize))) || travel > finish) break;
    int state = stateAt(cell);
    bool hit = state > 0;
    float hitDistance = travel;
    if (hit && uPoints) {
      vec3 center = vec3(float(cell.x) - float(uSize - 1) / 2.0, float(cell.y) * uTimeScale, float(cell.z) - float(uSize - 1) / 2.0);
      vec3 offset = worldOrigin - center;
      float projection = dot(offset, ray);
      float discriminant = projection * projection - dot(offset, offset) + uPointRadius * uPointRadius;
      hit = discriminant >= 0.0;
      if (hit) {
        hitDistance = -projection - sqrt(discriminant);
        normal = normalize(worldOrigin + ray * hitDistance - center);
      }
    }
    if (hit) {
      vec3 point = worldOrigin + ray * hitDistance;
      vec4 clip = uViewProjection * vec4(point, 1.0);
      gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
      float shade = 0.48 + 0.48 * max(0.0, dot(normal, normalize(vec3(-26, 65, 35)))) +
        0.10 * max(0.0, dot(normal, normalize(vec3(40, 20, -40))));
      float noise = fract(52.9829189 * fract(dot(floor(gl_FragCoord.xy), vec2(0.06711056, 0.00583715)))) - 0.5;
      vec3 color = uColors[state - 1] * shade;
      color = pow(color, vec3(1.0 / 2.2));
      color += uGrain * noise * 0.035;
      fragmentColor = vec4(color, 1.0);
      return;
    }
    if (next.x <= next.y && next.x <= next.z) {
      travel = next.x; next.x += delta.x; cell.x += stepDirection.x;
      normal = vec3(-stepDirection.x, 0, 0);
    } else if (next.y <= next.z) {
      travel = next.y; next.y += delta.y; cell.y += stepDirection.y;
      normal = vec3(0, -stepDirection.y, 0);
    } else {
      travel = next.z; next.z += delta.z; cell.z += stepDirection.z;
      normal = vec3(0, 0, -stepDirection.z);
    }
  }
  discard;
}`;

/** Exact first-hit voxel rendering without allocating a matrix per occupied cell. */
export default function DenseVolume({
  data,
  visibleLayers,
  palette,
  grain,
  mode,
  onLayerSelect,
}: {
  data: DenseVolumeData;
  visibleLayers: number;
  palette: VolumePalette;
  grain: boolean;
  mode: "voxels" | "points";
  onLayerSelect?: (layer: number) => void;
}) {
  const { invalidate } = useThree();
  const texture = useMemo(() => {
    const texture = new THREE.Data3DTexture(
      data.cells,
      data.width,
      data.height,
      data.depth,
    );
    texture.format = THREE.RedFormat;
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    return texture;
  }, [data]);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader,
        fragmentShader,
        uniforms: {
          uCells: { value: texture },
          uTextureSize: {
            value: new THREE.Vector3(data.width, data.height, data.depth),
          },
          uSize: { value: data.size },
          uLayers: { value: data.layerCount },
          uVisible: { value: data.layerCount },
          uTimeScale: { value: data.timeLayout.scale },
          uDirection: { value: new THREE.Vector3() },
          uViewProjection: { value: new THREE.Matrix4() },
          uColors: { value: paletteColors("mineral") },
          uGrain: { value: 1 },
          uPoints: { value: false },
          uPointRadius: { value: 0.1 },
        },
      }),
    [data, texture],
  );
  useEffect(() => {
    material.uniforms.uVisible.value = Math.max(
      0,
      Math.min(data.layerCount, visibleLayers),
    );
    material.uniforms.uColors.value = paletteColors(palette);
    material.uniforms.uGrain.value = grain ? 1 : 0;
    material.uniforms.uPoints.value = mode === "points";
    invalidate();
  }, [data, visibleLayers, palette, grain, mode, material, invalidate]);
  useFrame(({ camera }) => {
    camera.updateMatrixWorld();
    camera.getWorldDirection(material.uniforms.uDirection.value);
    material.uniforms.uViewProjection.value
      .copy(camera.projectionMatrix)
      .multiply(camera.matrixWorldInverse);
    material.uniforms.uPointRadius.value = Math.min(
      0.5 * Math.min(1, data.timeLayout.scale),
      1.125 / (camera as THREE.OrthographicCamera).zoom,
    );
  });
  useEffect(
    () => () => {
      texture.dispose();
      material.dispose();
    },
    [texture, material],
  );
  const select = (event: ThreeEvent<MouseEvent>) => {
    if (event.delta > 4) return;
    const layer = pickDenseLayer(data, event.ray, visibleLayers);
    if (layer === null) return;
    event.stopPropagation();
    onLayerSelect?.(layer);
  };
  return (
    <mesh
      position={[0, ((data.layerCount - 1) * data.timeLayout.scale) / 2, 0]}
      material={material}
      onClick={select}
    >
      <boxGeometry
        args={[data.size, data.layerCount * data.timeLayout.scale, data.size]}
      />
    </mesh>
  );
}
