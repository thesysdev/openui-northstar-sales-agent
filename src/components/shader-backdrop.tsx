"use client";

import { useEffect, useRef } from "react";

// The "agent is working" backdrop: a field of small math symbols rippling on a wave. Same
// look as the Asciify effect (packed 5x5 glyphs picked by density), but the field is computed
// on the GPU every frame, so motion is continuous instead of stepping on DOM snapshots.
// Transparent background; symbols are a subtle grey.

// One symbol everywhere, so the field reads as a single flat tone: a packed 5x5 "+".
const GLYPH = 145536;

/** CSS pixels per glyph pixel. A cell is 7 glyph pixels (5 + 1 padding each side). */
const GLYPH_PX = 1.15;

const VERT = `#version 300 es
layout(location = 0) in vec2 aPos;
void main () { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uRes;
uniform float uTime;
uniform float uGlyphPx;
uniform vec3 uInk;
uniform float uMax;
const uint GLYPH = ${GLYPH}u;

float glyphBit (ivec2 p) {
  if (p.x < 0 || p.x > 4 || p.y < 0 || p.y > 4) return 0.0;
  return float((GLYPH >> uint((4 - p.x) + 5 * p.y)) & 1u);
}

void main () {
  float cellPx = 7.0 * uGlyphPx;
  vec2 cell = floor(gl_FragCoord.xy / cellPx);
  vec2 p = (cell + 0.5) * cellPx / uRes.y * 5.0;
  float t = uTime;

  // Two broad, slow waves: a few large blobs drifting, not a churning fluid.
  float wave = sin(p.x * 0.55 + t * 0.18) * cos(p.y * 0.45 - t * 0.14)
             + 0.4 * sin((p.x - p.y) * 0.3 + t * 0.1);
  float v = clamp(0.5 + wave * 0.36, 0.0, 1.0);

  ivec2 local = ivec2(floor((gl_FragCoord.xy - cell * cellPx) / uGlyphPx)) - 1;
  float on = glyphBit(local);

  // One ink at a quiet share of the page's foreground (6% in light, a touch more in dark where
  // low alpha reads weaker). Flat inside each blob, fading only across its edge; the high
  // threshold leaves most of the page empty.
  float level = smoothstep(0.66, 0.76, v);
  float alpha = on * uMax * level;
  outColor = vec4(uInk * alpha, alpha);
}`;

export function ShaderBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) return;

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.warn("Backdrop shader failed:", gl.getShaderInfoLog(shader));
      }
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    gl.useProgram(program);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(program, "uRes");
    const uTime = gl.getUniformLocation(program, "uTime");
    const uGlyphPx = gl.getUniformLocation(program, "uGlyphPx");
    const uInk = gl.getUniformLocation(program, "uInk");
    const uMax = gl.getUniformLocation(program, "uMax");


    let dpr = 1;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    // The ink is the page's foreground colour, resolved to sRGB through a 1px canvas (theme
    // tokens can compute to oklab/lab strings), and re-read whenever the theme changes.
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    let ink: [number, number, number] = [0, 0, 0];
    const readInk = () => {
      if (!probe) return;
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = getComputedStyle(canvas).color;
      probe.fillRect(0, 0, 1, 1);
      const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
      ink = [(r ?? 0) / 255, (g ?? 0) / 255, (b ?? 0) / 255];
    };
    readInk();

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    let frame = 0;
    const draw = (now: number) => {
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, (now - start) / 1000);
      gl.uniform1f(uGlyphPx, Math.max(1, Math.round(GLYPH_PX * dpr)));
      gl.uniform3f(uInk, ink[0], ink[1], ink[2]);
      // Light ink means a dark page: dark mode needs a little more to read at all.
      gl.uniform1f(uMax, ink[0] + ink[1] + ink[2] > 1.5 ? 0.09 : 0.06);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (!still) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => {
      readInk();
      if (still) frame = requestAnimationFrame(draw);
    };
    scheme.addEventListener("change", onScheme);
    const themeObserver = new MutationObserver(onScheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });

    return () => {
      cancelAnimationFrame(frame);
      scheme.removeEventListener("change", onScheme);
      themeObserver.disconnect();
      observer.disconnect();
      gl.deleteBuffer(quad);
      gl.deleteProgram(program);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none h-full w-full text-foreground animate-in fade-in duration-500"
    />
  );
}
