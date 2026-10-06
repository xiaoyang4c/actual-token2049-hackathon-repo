import { useEffect, useRef } from 'react'

// Animated mesh gradient with film grain, in the spirit of ShaderGradient.
// Plain WebGL, so it has no dependency on the React Three Fiber version.

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 c1;
uniform vec3 c2;
uniform vec3 c3;

vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x){ return mod289(((x * 34.0) + 1.0) * x); }
float snoise(vec2 v){
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 q = vec2(uv.x * uRes.x / uRes.y, uv.y);
  float t = uTime * 0.06;

  // Domain-warped flow
  vec2 w = vec2(snoise(q * 0.9 + vec2(t, -t)), snoise(q * 0.9 + vec2(-t * 1.3, t * 0.7) + 7.0));
  float n1 = snoise(q * 1.2 + w * 0.8 + vec2(t * 0.8, 0.0));
  float n2 = snoise(q * 0.7 - w * 0.6 + vec2(0.0, t) + 3.0);

  // Light pools near the top, like a lit balance screen
  float top = smoothstep(-0.25, 1.05, uv.y);
  float a = smoothstep(-0.55, 0.85, n1) * (0.35 + 0.75 * top);
  float b = smoothstep(-0.45, 0.95, n2) * (0.25 + 0.55 * top);

  vec3 col = c3;
  col = mix(col, c2, b);
  col = mix(col, c1, a * 0.9);
  // Soft bands of light along the folds
  col += 0.12 * pow(max(0.0, 1.0 - abs(n1 - n2)), 6.0) * (c1 + c2);

  // Grain
  float g = fract(sin(dot(gl_FragCoord.xy + uTime, vec2(12.9898, 78.233))) * 43758.5453);
  col += (g - 0.5) * 0.045;
  gl_FragColor = vec4(col, 1.0);
}`

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)

export default function MeshGradient({ colors, className = '' }: { colors: [string, string, string]; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const target = useRef(colors.map(hex))
  target.current = colors.map(hex)

  useEffect(() => {
    const canvas = ref.current!
    const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false })
    if (!gl) return
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    gl.useProgram(prog)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'p')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    const uRes = gl.getUniformLocation(prog, 'uRes')
    const uTime = gl.getUniformLocation(prog, 'uTime')
    const uc = ['c1', 'c2', 'c3'].map((n) => gl.getUniformLocation(prog, n))

    // Render at reduced resolution; the gradient is soft and the grain hides it.
    const scale = 0.5
    const resize = () => {
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * scale))
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * scale))
      gl.viewport(0, 0, canvas.width, canvas.height)
    }
    resize()
    addEventListener('resize', resize)

    const current = target.current.map((c) => [...c])
    const start = performance.now()
    let raf = 0
    const frame = (now: number) => {
      // Ease colours toward the target so the halt change fades in.
      current.forEach((c, i) => c.forEach((v, j) => { c[j] = v + (target.current[i][j] - v) * 0.03 }))
      gl.uniform2f(uRes, canvas.width, canvas.height)
      gl.uniform1f(uTime, (now - start) / 1000)
      uc.forEach((u, i) => gl.uniform3f(u, current[i][0], current[i][1], current[i][2]))
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); removeEventListener('resize', resize) }
  }, [])

  return <canvas ref={ref} className={`h-full w-full ${className}`} />
}
