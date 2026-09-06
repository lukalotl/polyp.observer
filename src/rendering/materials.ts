import * as THREE from "three";
import { MAX_STATE_COUNT } from "../research/genome";
import type { PackedVolume } from "./volumeData";

export type VolumePalette = "mineral" | "ember" | "ink";

/** Explicit state colors, not a height rainbow. */
export const PALETTES: Record<VolumePalette, readonly string[]> = {
  mineral: ["#9fbea6", "#c6d3b5", "#eee8cb", "#5d8f7b"],
  ember: ["#c98361", "#dda77b", "#efcf9d", "#8e5646"],
  ink: ["#7d9fae", "#b2c5c7", "#e0e5db", "#526e87"],
};

export function paletteColors(palette: VolumePalette): THREE.Color[] {
  return Array.from({ length: MAX_STATE_COUNT - 1 }, (_, index) => {
    const hex = PALETTES[palette][index];
    if (hex) return new THREE.Color(hex);
    // Keep established state colors; extend with evenly distributed hues.
    const hueOffset =
      palette === "mineral" ? 0.28 : palette === "ember" ? 0.04 : 0.56;
    return new THREE.Color().setHSL(
      (hueOffset + (index - 3) * 0.61803398875) % 1,
      0.4,
      0.62,
    );
  });
}

export function instanceColors(
  data: PackedVolume,
  palette: VolumePalette,
  layerCount: number,
): Float32Array {
  const colors = new Float32Array(data.count * 3);
  const swatches = paletteColors(palette);
  const color = new THREE.Color();
  for (let index = 0; index < data.count; index++) {
    const x = data.positions[index * 3];
    const z = data.positions[index * 3 + 2];
    const t = data.layers[index];
    // A deterministic, restrained material variation. No flicker when the timeline moves.
    const hash = Math.sin(x * 127.1 + z * 311.7 + t * 74.7) * 43758.5453;
    const variation = 0.9 + (hash - Math.floor(hash)) * 0.13;
    const depth = 0.83 + (0.17 * t) / Math.max(1, layerCount - 1);
    color
      .copy(swatches[data.states[index] - 1])
      .multiplyScalar(variation * depth);
    color.toArray(colors, index * 3);
  }
  return colors;
}

/**
 * Applied to actual lit fragments, rather than a CSS noise layer over the canvas.
 * Four-by-four ordered quantization plus fine monochromatic film grain makes the
 * light feel printed and granular. The uniform switches it off without recompiling.
 */
export function makeVoxelMaterial() {
  const grain = { value: 1 };
  const material = new THREE.MeshStandardMaterial({
    color: "#ffffff",
    roughness: 1,
    metalness: 0,
    flatShading: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPolypGrain = grain;
    shader.fragmentShader =
      `
      uniform float uPolypGrain;
      float polypBayer2(vec2 p) {
        p = mod(floor(p), 2.0);
        return 2.0 * p.x + 3.0 * p.y - 4.0 * p.x * p.y;
      }
      float polypBayer4(vec2 p) {
        return (4.0 * polypBayer2(p) + polypBayer2(floor(p / 2.0)) + 0.5) / 16.0;
      }
      float polypNoise(vec2 p) {
        return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
      }
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <dithering_fragment>",
      `#include <dithering_fragment>
       float ordered = polypBayer4(gl_FragCoord.xy) - 0.5;
       float speckle = polypNoise(floor(gl_FragCoord.xy)) - 0.5;
       vec3 printed = floor(gl_FragColor.rgb * 24.0 + ordered + 0.5) / 24.0;
       printed += speckle * 0.048;
       gl_FragColor.rgb = mix(gl_FragColor.rgb, printed, uPolypGrain * 0.82);`,
    );
  };
  material.customProgramCacheKey = () => "polyp-ordered-dither-v1";
  return { material, grain };
}

export function makePointMaterial() {
  const grain = { value: 1 };
  const material = new THREE.PointsMaterial({
    size: 2.25,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.86,
    depthWrite: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPolypGrain = grain;
    shader.fragmentShader =
      "uniform float uPolypGrain;\n" + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <dithering_fragment>",
      `#include <dithering_fragment>
       float ink = fract(52.9829189 * fract(dot(floor(gl_FragCoord.xy), vec2(0.06711056, 0.00583715))));
       gl_FragColor.rgb *= 1.0 - uPolypGrain * ink * 0.17;`,
    );
  };
  material.customProgramCacheKey = () => "polyp-point-grain-v1";
  return { material, grain };
}
