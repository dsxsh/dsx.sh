const wrapper = document.querySelector('.moonpool');
const canvas = document.querySelector('.goo-orb');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const shader = /* wgsl */ `
struct Uniforms {
  resolution: vec2f,
  pointer: vec2f,
  time: f32,
  influence: f32,
  padding: vec2f,
  nodes: array<vec4f, 8>,
}

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
}

@vertex
fn vertex_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.0, 1.0);
  return output;
}

fn goo_field(point: vec2f) -> f32 {
  var field = 0.0;
  for (var i = 0u; i < 8u; i += 1u) {
    let node = u.nodes[i];
    let distance = max(length(point - node.xy), 0.012);
    field += pow(node.z / distance, 2.62);
  }
  return field;
}

@fragment
fn fragment_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let aspect = u.resolution.x / u.resolution.y;
  var point = position.xy / u.resolution;
  point.x = (point.x - 0.5) * aspect + 0.5;

  let field = goo_field(point);
  let edge = fwidth(field) * 1.4;
  let alpha = smoothstep(0.91 - edge, 0.91 + edge, field);
  if (alpha < 0.002) { discard; }

  let sample_step = 1.7 / u.resolution.y;
  let gradient = vec2f(
    log(1.0 + goo_field(point + vec2f(sample_step, 0.0))) - log(1.0 + goo_field(point - vec2f(sample_step, 0.0))),
    log(1.0 + goo_field(point + vec2f(0.0, sample_step))) - log(1.0 + goo_field(point - vec2f(0.0, sample_step)))
  );
  let surface_band = 1.0 - smoothstep(0.91, 1.65, field);
  let normal = normalize(vec3f(-gradient * 52.0 * surface_band, 1.0));

  var light_point = u.pointer;
  light_point.x = (light_point.x - 0.5) * aspect + 0.5;
  let light_direction = normalize(vec3f(light_point - point, 0.42));
  let diffuse = max(dot(normal, light_direction), 0.0);
  let view_direction = vec3f(0.0, 0.0, 1.0);
  let reflected = reflect(-light_direction, normal);
  let specular = pow(max(dot(reflected, view_direction), 0.0), 24.0);
  let fresnel = pow(1.0 - max(normal.z, 0.0), 2.2);

  let current = sin(point.x * 22.0 - point.y * 16.0 + u.time * 0.75) * 0.5 + 0.5;
  let deep = vec3f(0.015, 0.19, 0.32);
  let water = vec3f(0.09, 0.56, 0.72);
  let ice = vec3f(0.76, 0.97, 1.0);
  var color = mix(deep, water, 0.3 + diffuse * 0.62);
  color += ice * specular * (0.58 + u.influence * 0.24);
  color += vec3f(0.12, 0.48, 0.68) * fresnel * 0.8;
  color += vec3f(0.02, 0.12, 0.17) * current * 0.12;

  return vec4f(color, alpha * 0.96);
}
`;

const homes = [
  [0.50, 0.48, 0.185],
  [0.37, 0.39, 0.135],
  [0.62, 0.38, 0.145],
  [0.66, 0.55, 0.13],
  [0.54, 0.65, 0.14],
  [0.36, 0.61, 0.13],
  [0.28, 0.49, 0.105],
  [0.73, 0.45, 0.095],
];

const nodes = homes.map(([x, y, radius], index) => ({
  x,
  y,
  radius,
  vx: 0,
  vy: 0,
  phase: index * 1.73,
}));

const pointer = {
  x: 0.42,
  y: 0.35,
  tx: 0.42,
  ty: 0.35,
  active: 0,
  targetActive: 0,
  clientX: 0,
  clientY: 0,
  seen: false,
};

const motion = { x: null, y: null, vx: -0.12, vy: 0.08 };

function trackPointer(event) {
  pointer.clientX = event.clientX;
  pointer.clientY = event.clientY;
  pointer.seen = true;
}

window.addEventListener('pointermove', trackPointer, { passive: true });
window.addEventListener('pointerout', (event) => {
  if (!event.relatedTarget) {
    pointer.targetActive = 0;
    pointer.seen = false;
  }
});

async function startGoo() {
  if (!navigator.gpu) return;

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return;

  const device = await adapter.requestDevice();
  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'premultiplied' });

  const module = device.createShaderModule({ code: shader });
  const uniformBuffer = device.createBuffer({
    size: 160,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const pipeline = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module, entryPoint: 'vertex_main' },
    fragment: {
      module,
      entryPoint: 'fragment_main',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        },
      }],
    },
    primitive: { topology: 'triangle-list' },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });
  const uniforms = new Float32Array(40);
  let previousTime = performance.now();
  device.lost.then(() => wrapper.classList.remove('is-live'));

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function nudgeNodes(axis, amount) {
    nodes.forEach((node) => {
      node[axis] += amount * (0.75 + Math.random() * 0.5);
    });
  }

  function moveBody(delta) {
    const step = delta / 16.67;
    const size = wrapper.offsetWidth;
    const maxX = Math.max(8, window.innerWidth - size - 8);
    const maxY = Math.max(8, window.innerHeight - size - 8);

    if (motion.x === null) {
      motion.x = maxX - 18;
      motion.y = Math.min(26, maxY);
    }

    if (pointer.seen) {
      const centerX = motion.x + size * 0.5;
      const centerY = motion.y + size * 0.5;
      const dx = centerX - pointer.clientX;
      const dy = centerY - pointer.clientY;
      const distance = Math.max(Math.hypot(dx, dy), 1);
      const reach = size * 0.68;
      const push = Math.max(0, 1 - distance / reach) ** 2;
      motion.vx += (dx / distance) * push * 1.35 * step;
      motion.vy += (dy / distance) * push * 1.35 * step;
    }

    if (!reduceMotion.matches) {
      motion.vx *= Math.pow(0.996, step);
      motion.vy *= Math.pow(0.996, step);
      const speed = Math.hypot(motion.vx, motion.vy);
      if (speed > 11) {
        motion.vx = motion.vx / speed * 11;
        motion.vy = motion.vy / speed * 11;
      }
      motion.x += motion.vx * step;
      motion.y += motion.vy * step;
    }

    if (motion.x <= 8) {
      motion.x = 8;
      motion.vx = Math.abs(motion.vx) * 0.82;
      nudgeNodes('vx', 0.012);
    } else if (motion.x >= maxX) {
      motion.x = maxX;
      motion.vx = -Math.abs(motion.vx) * 0.82;
      nudgeNodes('vx', -0.012);
    }
    if (motion.y <= 8) {
      motion.y = 8;
      motion.vy = Math.abs(motion.vy) * 0.82;
      nudgeNodes('vy', 0.012);
    } else if (motion.y >= maxY) {
      motion.y = maxY;
      motion.vy = -Math.abs(motion.vy) * 0.82;
      nudgeNodes('vy', -0.012);
    }

    wrapper.style.setProperty('--goo-x', `${motion.x}px`);
    wrapper.style.setProperty('--goo-y', `${motion.y}px`);
  }

  function simulate(time, delta) {
    const step = delta / 16.67;
    if (pointer.seen) {
      const bounds = canvas.getBoundingClientRect();
      pointer.tx = (pointer.clientX - bounds.left) / bounds.width;
      pointer.ty = (pointer.clientY - bounds.top) / bounds.height;
      const near = pointer.tx > -0.25 && pointer.tx < 1.25 && pointer.ty > -0.25 && pointer.ty < 1.25;
      pointer.targetActive = near ? 1 : 0;
    }
    pointer.x += (pointer.tx - pointer.x) * 0.09;
    pointer.y += (pointer.ty - pointer.y) * 0.09;
    pointer.active += (pointer.targetActive - pointer.active) * 0.08;

    nodes.forEach((node, index) => {
      const [homeX, homeY] = homes[index];
      const dx = node.x - pointer.x;
      const dy = node.y - pointer.y;
      const distance = Math.max(Math.hypot(dx, dy), 0.025);
      const reach = 0.31;
      const push = Math.max(0, 1 - distance / reach) ** 2 * pointer.active;
      const wobble = reduceMotion.matches ? 0 : 0.00032;

      node.vx += (homeX - node.x) * 0.024 * step;
      node.vy += (homeY - node.y) * 0.024 * step;
      node.vx += (dx / distance) * push * 0.018 * step;
      node.vy += (dy / distance) * push * 0.018 * step;
      node.vx += Math.cos(time * 0.00055 + node.phase) * wobble * step;
      node.vy += Math.sin(time * 0.00047 + node.phase) * wobble * step;
      node.vx *= Math.pow(0.88, step);
      node.vy *= Math.pow(0.88, step);
      node.x += node.vx * step;
      node.y += node.vy * step;
    });
  }

  function render(time) {
    resize();
    const delta = Math.min(time - previousTime, 32);
    previousTime = time;
    moveBody(delta);
    simulate(time, delta);

    uniforms[0] = canvas.width;
    uniforms[1] = canvas.height;
    uniforms[2] = pointer.x;
    uniforms[3] = pointer.y;
    uniforms[4] = time / 1000;
    uniforms[5] = pointer.active;
    nodes.forEach((node, index) => {
      const offset = 8 + index * 4;
      uniforms[offset] = node.x;
      uniforms[offset + 1] = node.y;
      uniforms[offset + 2] = node.radius;
      uniforms[offset + 3] = 0;
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniforms);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);

    if (!reduceMotion.matches) requestAnimationFrame(render);
  }

  wrapper.classList.add('is-live');
  requestAnimationFrame(render);
  reduceMotion.addEventListener('change', () => requestAnimationFrame(render));
}

startGoo().catch((error) => console.warn('WebGPU goo unavailable:', error));
