const fs = require('fs');
const polygonClipping = require('polygon-clipping');

const data = JSON.parse(fs.readFileSync('hjd.geojson', 'utf8'));
const gm = data.features.filter(f => f.properties.sggnm === '광명시');

// 행정동(administrative dong) -> 법정동(legal dong) group, per Korean Wikipedia history pages
// (광명동/철산동/하안동/소하동/일직동/옥길동/학온동=가학동+노온사동, confirmed 2026-10-29)
const GROUP = {
  '광명1동': '광명동', '광명2동': '광명동', '광명3동': '광명동', '광명4동': '광명동',
  '광명5동': '광명동', '광명7동': '광명동',
  '광명6동': '옥길동', // jurisdiction redrawn to cover 옥길지구
  '철산1동': '철산동', '철산2동': '철산동', '철산3동': '철산동', '철산4동': '철산동',
  '하안1동': '하안동', '하안2동': '하안동', '하안3동': '하안동', '하안4동': '하안동',
  '소하1동': '소하동', '소하2동': '소하동',
  '일직동': '일직동',
  '학온동': '학온동(가학동·노온사동)',
};

const groups = {};
gm.forEach(f => {
  const admNm = f.properties.adm_nm.replace('경기도 광명시 ', '');
  const legal = GROUP[admNm];
  if (!legal) { console.error('UNMAPPED', admNm); return; }
  groups[legal] = groups[legal] || [];
  // geometry.coordinates is already MultiPolygon-shaped (Polygon[])
  groups[legal].push(f.geometry.coordinates);
});

const merged = {};
let allPts = [];
for (const [legal, multiPolys] of Object.entries(groups)) {
  const result = multiPolys.length === 1 ? multiPolys[0] : polygonClipping.union(...multiPolys);
  merged[legal] = result; // MultiPolygon: Polygon[][ring][pt]
  result.forEach(poly => poly.forEach(ring => ring.forEach(pt => allPts.push(pt))));
}

const lons = allPts.map(p => p[0]), lats = allPts.map(p => p[1]);
const lon0 = (Math.min(...lons) + Math.max(...lons)) / 2;
const lat0 = (Math.min(...lats) + Math.max(...lats)) / 2;
const cosLat0 = Math.cos(lat0 * Math.PI / 180);

// equirectangular projection around the city centroid, y flipped (north = up)
function project(lon, lat) {
  return [(lon - lon0) * cosLat0, -(lat - lat0)];
}

let projPts = [];
const projMerged = {};
for (const [legal, multiPoly] of Object.entries(merged)) {
  projMerged[legal] = multiPoly.map(poly => poly.map(ring => ring.map(([lon, lat]) => {
    const p = project(lon, lat);
    projPts.push(p);
    return p;
  })));
}

const xs = projPts.map(p => p[0]), ys = projPts.map(p => p[1]);
const minX = Math.min(...xs), maxX = Math.max(...xs);
const minY = Math.min(...ys), maxY = Math.max(...ys);
const spanX = maxX - minX, spanY = maxY - minY;
const PAD = 0.06;
const W = 1000;
const scale = (W * (1 - 2 * PAD)) / spanX;
const H = spanY * scale / (1 - 2 * PAD) + 2 * PAD * (spanY * scale / (1 - 2 * PAD));
// simpler: compute H directly from spanY with same scale + padding
const Hfinal = spanY * scale + 2 * PAD * W;

function toSvg(x, y) {
  return [
    PAD * W + (x - minX) * scale,
    PAD * W + (y - minY) * scale,
  ];
}

const out = {};
for (const [legal, multiPoly] of Object.entries(projMerged)) {
  let d = '';
  let areaWeighted = [0, 0, 0]; // sumX, sumY, totalLen (proxy weight by ring point count of largest ring)
  let biggestRing = null, biggestLen = -1;
  multiPoly.forEach(poly => {
    poly.forEach((ring, ringIdx) => {
      const svgPts = ring.map(([x, y]) => toSvg(x, y));
      d += 'M' + svgPts.map(p => p[0].toFixed(2) + ',' + p[1].toFixed(2)).join('L') + 'Z';
      if (ringIdx === 0) {
        // approximate polygon length as proxy for size, to find the main landmass ring
        let len = 0;
        for (let i = 1; i < svgPts.length; i++) {
          len += Math.hypot(svgPts[i][0]-svgPts[i-1][0], svgPts[i][1]-svgPts[i-1][1]);
        }
        if (len > biggestLen) { biggestLen = len; biggestRing = svgPts; }
      }
    });
  });
  // centroid of the largest outer ring (simple polygon centroid formula)
  let cx = 0, cy = 0, area = 0;
  const r = biggestRing;
  for (let i = 0; i < r.length - 1; i++) {
    const [x0,y0] = r[i], [x1,y1] = r[i+1];
    const cross = x0*y1 - x1*y0;
    area += cross;
    cx += (x0+x1)*cross;
    cy += (y0+y1)*cross;
  }
  area *= 0.5;
  cx = cx / (6*area);
  cy = cy / (6*area);
  out[legal] = { d, cx: +cx.toFixed(2), cy: +cy.toFixed(2) };
}

const viewBox = `0 0 ${W.toFixed(1)} ${Hfinal.toFixed(1)}`;
fs.writeFileSync('dong-geo.json', JSON.stringify({ viewBox, dong: out }, null, 1), 'utf8');
console.log('viewBox', viewBox);
Object.entries(out).forEach(([k,v]) => console.log(k, 'centroid', v.cx, v.cy, 'd.length', v.d.length));
