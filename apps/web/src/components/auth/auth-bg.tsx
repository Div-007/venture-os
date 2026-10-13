"use client";

import { useEffect, useRef } from "react";

/**
 * Animated silk-ribbon background (raw WebGL, no deps). Domain-warped fbm
 * produces the flowing magenta/violet/cyan waves over near-black, matching
 * the reference still. If WebGL is unavailable the canvas removes itself and
 * the static /auth-bg.webp underneath stays as the fallback.
 */

const VERT = `attribute vec2 a; void main(){ gl_Position = vec4(a,0.,1.); }`;

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;

mat2 rot(float a){ float c=cos(a),s=sin(a); return mat2(c,-s,s,c); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 p){
  vec2 i=floor(p), f=fract(p);
  f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y);
}
float fbm(vec2 p){
  float v=0., a=.55;
  for(int i=0;i<5;i++){ v+=a*noise(p); p=rot(.62)*p*2.03+vec2(3.1); a*=.5; }
  return v;
}

void main(){
  vec2 uv = gl_FragCoord.xy/uRes;
  vec2 p = uv-.5;
  p.x *= uRes.x/uRes.y;
  float t = uTime*.12;

  // diagonal flow, domain-warped
  vec2 q = p*1.6 + vec2(-t, t*.3);
  vec2 w = vec2(fbm(q+vec2(0.,t*.3)), fbm(q+vec2(4.2,t*.25)));
  float f = fbm(q + 2.0*w);

  // ribbon coordinate follows the flow direction — fine parallel streaks
  float band = sin((q.y*2.6 - q.x*.9 + f*2.4) * 3.14159 + t*.6);
  float rib = pow(band*.5+.5, 1.6);

  vec3 deep    = vec3(.02,.02,.08);
  vec3 violet  = vec3(.28,.08,.58);
  vec3 magenta = vec3(.90,.08,.50);
  vec3 pink    = vec3(1.,.30,.70);
  vec3 cyan    = vec3(.15,.60,1.);

  vec3 col = deep;
  col = mix(col, violet,  smoothstep(.30,.80,f)*.8);
  col = mix(col, magenta, smoothstep(.55,.92,rib)*smoothstep(.25,.70,f));
  col = mix(col, pink,    smoothstep(.85,1.,rib)*.7);

  // cool streaks on their own warp
  float cool = fbm(q*1.2 + w*1.4 - t*.4);
  col = mix(col, cyan, smoothstep(.65,.95,cool)*.5);

  // sheen on ribbon crests
  col += vec3(.4,.3,.5)*pow(rib,14.)*.7;

  col *= 1. - .4*length(p*vec2(.7,1.));
  gl_FragColor = vec4(col,1.);
}`;

export function AuthBg() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const gl = canvas?.getContext("webgl", { antialias: false, alpha: false });
    if (!canvas || !gl) {
      canvas?.remove();
      return;
    }
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      canvas.remove(); // shader failed — static image fallback
      return;
    }
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, "uRes");
    const uTime = gl.getUniformLocation(prog, "uTime");

    const resize = () => {
      const dpr = Math.min(devicePixelRatio, 1.5); // cap — shaders cost per pixel
      canvas.width = Math.round(innerWidth * dpr);
      canvas.height = Math.round(innerHeight * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    resize();
    addEventListener("resize", resize);

    let raf = 0;
    const t0 = performance.now();
    const draw = () => {
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, (performance.now() - t0) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      draw();
    } else {
      const loop = () => {
        draw();
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("resize", resize);
    };
  }, []);

  // own fixed negative-z layer: static image beneath, canvas on top.
  // If WebGL fails the canvas removes itself and the still shows through.
  return (
    <div className="fixed inset-0 -z-10" aria-hidden="true">
      <div className="absolute inset-0 bg-[url('/auth-bg.webp')] bg-cover bg-center" />
      <canvas ref={ref} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
