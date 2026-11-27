// Maps a flat w×h element onto an arbitrary quadrilateral on screen (a perspective
// transform), returned as a CSS `matrix3d(...)`. That is how a DOM iframe/video is
// pinned exactly onto the projector screen as seen by the 3D camera.

/** quad = [TL, TR, BR, BL] in CSS pixels. */
export function quadToMatrix3d(w: number, h: number, quad: { x: number; y: number }[]): string {
  const src = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  // Solve for the 8 unknowns a..h of the homography (h22 = 1) with Gaussian elimination.
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [sx, sy] = src[i];
    const { x: dx, y: dy } = quad[i];
    A.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx, dx]);
    A.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy, dy]);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c] || 1e-12;
    for (let k = c; k <= n; k++) A[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  const [a, b, c, d, e, f, g, hh] = A.map((row) => row[n]);
  return `matrix3d(${a},${d},0,${g},${b},${e},0,${hh},0,0,1,0,${c},${f},0,1)`;
}
