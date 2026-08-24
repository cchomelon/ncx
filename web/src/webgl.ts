import {
  colorForValue,
  paletteBytes,
  type ColormapChoice,
  type ColorRange,
} from "./color";
import type { ColorScale } from "./model";
import type { Bounds, MeshGeometry } from "./mesh";

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 source_position;
layout(location = 1) in float source_value;

uniform vec4 view_bounds;
uniform vec2 color_range;
uniform int scale_mode;

out float color_position;
out float valid_value;

float symlog(float value, float threshold) {
  return sign(value) * log(1.0 + abs(value) / threshold);
}

void main() {
  float width = max(view_bounds.y - view_bounds.x, 1e-30);
  float height = max(view_bounds.w - view_bounds.z, 1e-30);
  gl_Position = vec4(
    2.0 * (source_position.x - view_bounds.x) / width - 1.0,
    2.0 * (source_position.y - view_bounds.z) / height - 1.0,
    0.0,
    1.0
  );

  valid_value = (isnan(source_value) || isinf(source_value)) ? 0.0 : 1.0;
  float value = source_value;
  float minimum = color_range.x;
  float maximum = color_range.y;
  if (scale_mode == 1) {
    if (value <= 0.0 || maximum <= 0.0) valid_value = 0.0;
    value = log(max(value, 1e-30));
    minimum = log(max(minimum, 1e-30));
    maximum = log(maximum);
  } else if (scale_mode == 2) {
    float threshold = max(max(abs(minimum), abs(maximum)) * 0.01, 1e-30);
    value = symlog(value, threshold);
    minimum = symlog(minimum, threshold);
    maximum = symlog(maximum, threshold);
  }
  color_position = clamp((value - minimum) / max(maximum - minimum, 1e-30), 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D palette;
in float color_position;
in float valid_value;
out vec4 output_color;

void main() {
  output_color = valid_value < 0.999
    ? vec4(0.933, 0.933, 0.933, 1.0)
    : texture(palette, vec2(color_position, 0.5));
}`;

export interface MeshDrawSettings {
  colormap: ColormapChoice;
  scale: ColorScale;
  range: ColorRange;
  view: Bounds;
  width: number;
  height: number;
}

/** The small WebGL2 surface used by curvilinear and UGRID fields. */
export interface MeshSurface {
  draw(geometry: MeshGeometry, sourceValues: Float32Array, settings: MeshDrawSettings): void;
  destroy(): void;
}

export function createMeshRenderer(canvas: HTMLCanvasElement): MeshSurface {
  try {
    return new MeshRenderer(canvas);
  } catch {
    // ponytail: a flat Canvas fallback keeps remote desktops usable; retain
    // WebGL2 as the fast path unless fallback performance becomes measurable.
    return new CanvasMeshRenderer(canvas);
  }
}

class MeshRenderer implements MeshSurface {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly positionBuffer: WebGLBuffer;
  private readonly valueBuffer: WebGLBuffer;
  private readonly palette: WebGLTexture;
  private uploadedGeometry: MeshGeometry | undefined;
  private uploadedColormap: ColormapChoice | undefined;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: true });
    if (!gl) throw new Error("This browser does not provide WebGL2");
    this.gl = gl;
    this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
    this.positionBuffer = required(gl.createBuffer(), "position buffer");
    this.valueBuffer = required(gl.createBuffer(), "value buffer");
    this.palette = required(gl.createTexture(), "palette texture");

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.valueBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, this.palette);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(required(gl.getUniformLocation(this.program, "palette"), "palette uniform"), 0);
  }

  draw(geometry: MeshGeometry, sourceValues: Float32Array, settings: MeshDrawSettings): void {
    const gl = this.gl;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(settings.width * ratio));
    const height = Math.max(1, Math.round(settings.height * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);

    if (this.uploadedGeometry !== geometry) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, geometry.positions, gl.STATIC_DRAW);
      this.uploadedGeometry = geometry;
    }
    const expandedValues = new Float32Array(geometry.scalarIndices.length);
    for (let index = 0; index < expandedValues.length; index += 1) {
      expandedValues[index] = sourceValues[geometry.scalarIndices[index]] ?? Number.NaN;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.valueBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, expandedValues, gl.DYNAMIC_DRAW);

    if (this.uploadedColormap !== settings.colormap) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.palette);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        256,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        paletteBytes(settings.colormap),
      );
      this.uploadedColormap = settings.colormap;
    }

    gl.uniform4f(
      required(gl.getUniformLocation(this.program, "view_bounds"), "view bounds uniform"),
      settings.view.minimumX,
      settings.view.maximumX,
      settings.view.minimumY,
      settings.view.maximumY,
    );
    gl.uniform2f(
      required(gl.getUniformLocation(this.program, "color_range"), "color range uniform"),
      settings.range.minimum,
      settings.range.maximum,
    );
    gl.uniform1i(
      required(gl.getUniformLocation(this.program, "scale_mode"), "scale uniform"),
      settings.scale === "linear" ? 0 : settings.scale === "log" ? 1 : 2,
    );
    gl.clearColor(0.933, 0.933, 0.933, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, geometry.scalarIndices.length);
  }

  destroy(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.positionBuffer);
    gl.deleteBuffer(this.valueBuffer);
    gl.deleteTexture(this.palette);
    gl.deleteProgram(this.program);
  }
}

class CanvasMeshRenderer implements MeshSurface {
  private readonly context: CanvasRenderingContext2D;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("This browser cannot create a field canvas");
    this.context = context;
  }

  draw(geometry: MeshGeometry, sourceValues: Float32Array, settings: MeshDrawSettings): void {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(settings.width * ratio));
    const height = Math.max(1, Math.round(settings.height * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const context = this.context;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = "#eeeeee";
    context.fillRect(0, 0, settings.width, settings.height);
    const dataWidth = settings.view.maximumX - settings.view.minimumX;
    const dataHeight = settings.view.maximumY - settings.view.minimumY;
    const screenX = (value: number) =>
      ((value - settings.view.minimumX) / dataWidth) * settings.width;
    const screenY = (value: number) =>
      (1 - (value - settings.view.minimumY) / dataHeight) * settings.height;

    for (let vertex = 0; vertex < geometry.scalarIndices.length; vertex += 3) {
      const values = [
        Number(sourceValues[geometry.scalarIndices[vertex]]),
        Number(sourceValues[geometry.scalarIndices[vertex + 1]]),
        Number(sourceValues[geometry.scalarIndices[vertex + 2]]),
      ];
      const value = values.every(Number.isFinite)
        ? (values[0] + values[1] + values[2]) / 3
        : Number.NaN;
      const color = colorForValue(value, settings.range, settings.scale, settings.colormap);
      context.fillStyle = color ? `rgb(${color.join(" ")})` : "#eeeeee";
      context.beginPath();
      context.moveTo(
        screenX(geometry.positions[vertex * 2]),
        screenY(geometry.positions[vertex * 2 + 1]),
      );
      context.lineTo(
        screenX(geometry.positions[(vertex + 1) * 2]),
        screenY(geometry.positions[(vertex + 1) * 2 + 1]),
      );
      context.lineTo(
        screenX(geometry.positions[(vertex + 2) * 2]),
        screenY(geometry.positions[(vertex + 2) * 2 + 1]),
      );
      context.closePath();
      context.fill();
    }
  }

  destroy(): void {}
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const program = required(gl.createProgram(), "shader program");
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "unknown link error";
    gl.deleteProgram(program);
    throw new Error(`Cannot link ncx field shader: ${message}`);
  }
  return program;
}

function compileShader(gl: WebGL2RenderingContext, kind: number, source: string): WebGLShader {
  const shader = required(gl.createShader(kind), "shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "unknown compile error";
    gl.deleteShader(shader);
    throw new Error(`Cannot compile ncx field shader: ${message}`);
  }
  return shader;
}

function required<T>(value: T | null, name: string): T {
  if (value === null) throw new Error(`WebGL could not create ${name}`);
  return value;
}
