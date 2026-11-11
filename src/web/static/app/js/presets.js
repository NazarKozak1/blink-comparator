// Challenge targets at their 2025-2026 positions (fast movers drift away from their catalogue coordinates)
// and the settings that show each one best: the name search of the Explore page (names.js), rings on the sky
// sphere (ra / dec) and the server warm-up (src/web/presets.py must keep q, det, fov and mode equal).
export const PRESETS = [
  { n: "Barnard’s Star", h: "fastest star", q: "17h57m47.1s +4d46m03s", ra: 269.4463, dec: 4.7675, det: 6, fov: 4, mode: "stacks",
    alt: ["Barnard", "Barnards Star", "Barnard's Star"] },
  { n: "Epsilon Indi B", h: "brown dwarf pair", q: "22h04m23.4s -56d48m03s", ra: 331.0975, dec: -56.8008, det: 6, fov: 4, mode: "stacks",
    alt: ["Eps Indi B", "ε Indi B", "Epsilon Indi Ba", "Epsilon Indi Bb"] },
  { n: "WISE 0855", h: "coldest brown dwarf", q: "08h55m02.4s -7d14m32s", ra: 133.7600, dec: -7.2422, det: 6, fov: 4, mode: "stacks",
    alt: ["WISE J0855-0714", "WISE 0855-0714", "WISE J085510.83-071442.5"] },
  { n: "RW Aurigae", h: "variable star", q: "76.9564 30.4014", ra: 76.9564, dec: 30.4014, det: 6, fov: 6, mode: "frames",
    alt: ["RW Aur"] },
  { n: "R Draconis", h: "pulsating star", q: "248.1675 66.7550", ra: 248.1675, dec: 66.7550, det: 6, fov: 6, mode: "frames",
    alt: ["R Dra"] },
  { n: "Orion Nebula", h: "nebula, many colours", q: "83.8221 -5.3911", ra: 83.8221, dec: -5.3911, det: 4, fov: 6, mode: "frames",
    alt: ["M42", "Orion M42", "Orion", "Messier 42", "Great Orion Nebula"] },
];
