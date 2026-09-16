import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

type Accessor = { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean; sparse?: unknown };
type Document = { accessors: Accessor[]; bufferViews: { byteOffset?: number; byteStride?: number; byteLength: number }[];
  meshes?: { name?: string; primitives: { attributes: Record<string, number>; indices?: number; material?: number; mode?: number; extensions?: Record<string, unknown> }[] }[];
  materials?: { name?: string }[] };
const inventory = JSON.parse(await readFile('artifacts/research/model-quality/full-model-quality-audit.json', 'utf8')) as { entries: { id: number; path: string }[] };
// Use the same pinned offline decoder as the game; no new provider or dependency.
const sandbox = { module: { exports: {} as any }, exports: {}, require: createRequire(import.meta.url),
  __dirname: resolve('public/draco'), process, Buffer, TextDecoder, TextEncoder, WebAssembly, setTimeout, clearTimeout };
runInNewContext(await readFile('public/draco/draco_wasm_wrapper.js', 'utf8'), sandbox);
const draco = await sandbox.module.exports({ wasmBinary: await readFile('public/draco/draco_decoder.wasm') });
const decoder = new draco.Decoder();
const results = [];
for (const entry of inventory.entries) {
  const bytes = await readFile(entry.path), jsonLength = bytes.readUInt32LE(12), bin = 28 + jsonLength;
  const doc = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength)) as Document;
  const attribute = (id: number) => {
    const accessor = doc.accessors[id];
    if (!accessor || accessor.bufferView === undefined || accessor.sparse) return undefined;
    const view = doc.bufferViews[accessor.bufferView], width = accessor.componentType === 5126 || accessor.componentType === 5125 ? 4 : accessor.componentType === 5123 || accessor.componentType === 5122 ? 2 : 1;
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type];
    if (!components) return undefined;
    const offset = bin + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0), stride = view.byteStride ?? width * components;
    const get = (i: number, c = 0) => {
      const p = offset + i * stride + c * width;
      const value = accessor.componentType === 5126 ? bytes.readFloatLE(p) : accessor.componentType === 5125 ? bytes.readUInt32LE(p)
        : accessor.componentType === 5123 ? bytes.readUInt16LE(p) : accessor.componentType === 5122 ? bytes.readInt16LE(p)
          : accessor.componentType === 5121 ? bytes.readUInt8(p) : bytes.readInt8(p);
      if (!accessor.normalized || accessor.componentType === 5126) return value;
      const max = accessor.componentType === 5120 ? 127 : accessor.componentType === 5121 ? 255 : accessor.componentType === 5122 ? 32767 : accessor.componentType === 5123 ? 65535 : 4294967295;
      return Math.max(-1, value / max);
    };
    return { count: accessor.count, get };
  };
  const meshes = [];
  for (const mesh of doc.meshes ?? []) for (const primitive of mesh.primitives) {
    let position = attribute(primitive.attributes.POSITION), normal = attribute(primitive.attributes.NORMAL);
    let index = primitive.indices === undefined ? undefined : attribute(primitive.indices);
    const compressed = primitive.extensions?.KHR_draco_mesh_compression as { bufferView: number; attributes: Record<string, number> } | undefined;
    if (compressed) {
      const view = doc.bufferViews[compressed.bufferView], offset = bin + (view.byteOffset ?? 0);
      const input = new Int8Array(bytes.buffer, bytes.byteOffset + offset, view.byteLength), decoded = new draco.Mesh();
      const status = decoder.DecodeArrayToMesh(input, input.byteLength, decoded);
      if (!status.ok()) throw new Error(`${entry.id}: Draco decode failed`);
      const readAttribute = (semantic: string) => {
        if (compressed.attributes[semantic] === undefined) return undefined;
        const source = decoder.GetAttributeByUniqueId(decoded, compressed.attributes[semantic]);
        const components = source.num_components(), count = decoded.num_points(), byteLength = count * components * 4, ptr = draco._malloc(byteLength);
        decoder.GetAttributeDataArrayForAllPoints(decoded, source, draco.DT_FLOAT32, byteLength, ptr);
        const values = new Float32Array(draco.HEAPF32.buffer, ptr, count * components).slice(); draco._free(ptr);
        return { count, get: (i: number, c = 0) => values[i * components + c] };
      };
      position = readAttribute('POSITION'); normal = readAttribute('NORMAL');
      const count = decoded.num_faces() * 3, ptr = draco._malloc(count * 4);
      decoder.GetTrianglesUInt32Array(decoded, count * 4, ptr);
      const values = new Uint32Array(draco.HEAPF32.buffer, ptr, count).slice(); draco._free(ptr);
      index = { count, get: (i: number) => values[i] }; draco.destroy(decoded);
    }
    if (!position || !normal || (primitive.mode !== undefined && primitive.mode !== 4)) {
      meshes.push({ name: mesh.name, skipped: true, reason: 'absent/sparse normals or non-triangles' }); continue;
    }
    const count = index?.count ?? position.count;
    let faces = 0, flatFaces = 0, invalidNormals = 0;
    for (let i = 0; i < position.count; i++) {
      const length = Math.hypot(normal.get(i, 0), normal.get(i, 1), normal.get(i, 2));
      if (!Number.isFinite(length) || length < .5 || length > 1.5) invalidNormals++;
    }
    for (let i = 0; i + 2 < count; i += 3) {
      const a = index?.get(i) ?? i, b = index?.get(i + 1) ?? i + 1, c = index?.get(i + 2) ?? i + 2;
      const ux = position.get(b, 0) - position.get(a, 0), uy = position.get(b, 1) - position.get(a, 1), uz = position.get(b, 2) - position.get(a, 2);
      const vx = position.get(c, 0) - position.get(a, 0), vy = position.get(c, 1) - position.get(a, 1), vz = position.get(c, 2) - position.get(a, 2);
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, length = Math.hypot(nx, ny, nz);
      if (length < 1e-12) continue;
      faces++;
      if ([a, b, c].every(v => {
        const x = normal!.get(v, 0), y = normal!.get(v, 1), z = normal!.get(v, 2);
        return (x * nx + y * ny + z * nz) / (length * Math.hypot(x, y, z)) > .999;
      })) flatFaces++;
    }
    meshes.push({ name: mesh.name, material: doc.materials?.[primitive.material ?? -1]?.name,
      vertices: position.count, faces, flatFaces, flatRatio: faces ? flatFaces / faces : 0, invalidNormals });
  }
  results.push({ id: entry.id, sha256: createHash('sha256').update(bytes).digest('hex'), meshes });
}
await mkdir('artifacts/model-appearance', { recursive: true });
await writeFile('artifacts/model-appearance/normal-audit.json', JSON.stringify({ models: results.length, results }, null, 2));
draco.destroy(decoder);
console.log(JSON.stringify(results.flatMap(row => row.meshes.filter(mesh => (mesh.faces ?? 0) > 100 && (mesh.flatRatio ?? 0) > .8).map(mesh => ({ id: row.id, ...mesh }))), null, 2));
