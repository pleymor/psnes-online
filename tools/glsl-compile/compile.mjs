/**
 * Le seul test qui puisse dire si le shader compile : un vrai WebGL2.
 *
 * Aucune des 1234 assertions sous Bun n_en approche - elles vérifient
 * l_arithmétique autour du rendu, jamais le rendu. Un shader qui ne compile
 * pas donne un écran noir dans le casque et rien du tout dans la console
 * d_ici, ce qui est la pire forme d_échec : silencieuse et à distance.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const src = readFileSync(process.argv[2], 'utf8');
const grab = (name) => {
  const at = src.indexOf(`export const ${name} = /* glsl */ \``);
  const from = src.indexOf('`', at) + 1;
  return src.slice(from, src.indexOf('\n`;', from));
};

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.goto('about:blank');
const out = await page.evaluate(
  ([vs, fs]) => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return { error: 'pas de webgl2' };
    // Le préfixe que three met devant TOUT ShaderMaterial en GLSL3.
    const prefix = `#version 300 es
#define varying in
out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
#define texture2D texture
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
`;
    const vsPrefix = prefix.replace('#define varying in', '#define varying out') +
      'in vec3 position;\nin vec2 uv;\n';
    const fsPrefix = prefix + `
#define linearToOutputTexel(c) vec4(mix(pow(c.rgb,vec3(0.41666))*1.055-vec3(0.055), c.rgb*12.92, vstep(c.rgb,vec3(0.0031308))), c.a)
vec3 vstep(vec3 a, vec3 b){ return step(a,b); }
`;
    const compile = (type, source) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, source);
      gl.compileShader(sh);
      return gl.getShaderParameter(sh, gl.COMPILE_STATUS)
        ? { shader: sh }
        : { log: gl.getShaderInfoLog(sh) };
    };
    // `colorspace_fragment` remplacé par son expansion, sans quoi l_include
    // resterait littéral - three le résout avant de compiler.
    const body = fs.replaceAll('#include <colorspace_fragment>', 'gl_FragColor = linearToOutputTexel( gl_FragColor );');
    const v = compile(gl.VERTEX_SHADER, vsPrefix + vs);
    const f = compile(gl.FRAGMENT_SHADER, fsPrefix + body);
    if (v.log || f.log) return { vertex: v.log, fragment: f.log };
    const prog = gl.createProgram();
    gl.attachShader(prog, v.shader);
    gl.attachShader(prog, f.shader);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { link: gl.getProgramInfoLog(prog) };
    const uniforms = {};
    for (let i = 0; i < gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i++) {
      const u = gl.getActiveUniform(prog, i);
      uniforms[u.name] = u.type;
    }
    return { ok: true, uniforms: Object.keys(uniforms).sort() };
  },
  [grab('PICTURE_VERTEX_SHADER'), grab('PICTURE_FRAGMENT_SHADER')]
);
console.log(JSON.stringify(out, null, 2));
await browser.close();
