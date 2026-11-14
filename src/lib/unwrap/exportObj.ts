import type { ExportMesh } from './exportMesh';

export type ObjOptions = {
  name?: string;
  version?: string;
  input?: string;
};

function number(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const fixed = value.toFixed(6).replace(/\.?0+$/, '');
  return fixed === '-0' ? '0' : fixed;
}

function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'Object';
}

/** Writes the final mesh as OBJ with one `v`/`vt`/`vn` per triangle corner. */
export function exportObj(mesh: ExportMesh, options: ObjOptions = {}): string {
  const lines: string[] = [];
  const version = options.version ?? 'dev';
  if (options.name) lines.push(`# ${options.name}`);
  lines.push(`# UltiUnwrapper ${version}`);
  if (options.input) lines.push(`# input ${options.input}`);
  lines.push(`o ${safeName(options.name ?? 'UltiUnwrapperMesh')}`);

  for (let corner = 0; corner < mesh.cornerCount; corner += 1) {
    lines.push(`v ${number(mesh.positions[corner * 3])} ${number(mesh.positions[corner * 3 + 1])} ${number(mesh.positions[corner * 3 + 2])}`);
  }
  for (let corner = 0; corner < mesh.cornerCount; corner += 1) {
    lines.push(`vt ${number(mesh.uvs[corner * 2])} ${number(mesh.uvs[corner * 2 + 1])}`);
  }
  for (let corner = 0; corner < mesh.cornerCount; corner += 1) {
    lines.push(`vn ${number(mesh.normals[corner * 3])} ${number(mesh.normals[corner * 3 + 1])} ${number(mesh.normals[corner * 3 + 2])}`);
  }

  for (const group of mesh.groups) {
    if (group.count === 0) continue;
    lines.push(`g ${safeName(group.name)}`);
    for (let corner = group.start; corner < group.start + group.count; corner += 3) {
      const a = corner + 1;
      const b = corner + 2;
      const c = corner + 3;
      lines.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
