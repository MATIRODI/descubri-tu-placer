/* =====================================================================
   Power Pump Men 2.0 — Visor 3D
   Modelo procedural (three.js) de la bomba y de los accesorios de cada kit.
   Es un script clásico (no módulo) para que la web funcione también
   abriendo index.html con doble clic. three.js se carga desde el CDN
   mediante el importmap declarado en index.html.
   ===================================================================== */
(function () {
  'use strict';

  window.Pump3D = {
    ready: Promise.all([
      import('three'),
      import('three/addons/controls/OrbitControls.js'),
      import('three/addons/environments/RoomEnvironment.js'),
      document.fonts ? document.fonts.ready : Promise.resolve()
    ]).then(([THREE, oc, re]) => build(THREE, oc.OrbitControls, re.RoomEnvironment))
  };

  function build(THREE, OrbitControls, RoomEnvironment) {
    const V3 = THREE.Vector3;
    const PX = 1.25; // eje vertical de la bomba manual
    const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const now = () => performance.now() / 1000;
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const lerp = (a, b, t) => a + (b - a) * t;
    const ease = t => t * t * (3 - 2 * t);
    const wrapPi = a => Math.atan2(Math.sin(a), Math.cos(a));

    /* ------------------------------------------------------------------
       Geometría: helpers
       ------------------------------------------------------------------ */
    const lathe = (pts, seg = 64) =>
      new THREE.LatheGeometry(pts.map(p => new THREE.Vector2(p[0], p[1])), seg);

    function mesh(geo, mat, x = 0, y = 0, z = 0) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      return m;
    }

    function cyl(r1, r2, h, seg = 32) {
      return new THREE.CylinderGeometry(r1, r2, h, seg);
    }

    // Polígono con esquinas redondeadas (para Shape o Path)
    function roundedPath(path, pts, r) {
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
        const d1 = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]);
        const d2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
        const rr = Math.min(r, d1 / 2, d2 / 2);
        const a = [p1[0] + (p0[0] - p1[0]) / d1 * rr, p1[1] + (p0[1] - p1[1]) / d1 * rr];
        const b = [p1[0] + (p2[0] - p1[0]) / d2 * rr, p1[1] + (p2[1] - p1[1]) / d2 * rr];
        if (i === 0) path.moveTo(a[0], a[1]); else path.lineTo(a[0], a[1]);
        path.quadraticCurveTo(p1[0], p1[1], b[0], b[1]);
      }
      path.closePath();
      return path;
    }

    function extrude(shape, depth, bevel) {
      const g = new THREE.ExtrudeGeometry(shape, {
        depth, curveSegments: 8,
        bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.85, bevelSegments: 3
      });
      g.translate(0, 0, -depth / 2);
      return g;
    }

    // Anillo moleteado (perilla / rosca)
    function knurl(teeth, rOut, rIn, depth) {
      const s = new THREE.Shape();
      const N = teeth * 4;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        const r = (i % 4 < 2) ? rOut : rIn;
        if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      s.closePath();
      const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 1 });
      g.computeVertexNormals();
      return g;
    }

    /* ------------------------------------------------------------------
       Materiales y texturas (compartidos entre visores)
       ------------------------------------------------------------------ */
    const GLASS_VS = `
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`;
    const GLASS_FS = `
      uniform vec3 uTint;
      uniform vec3 uEdge;
      uniform float uOpacity;
      uniform float uBands;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec3 n = normalize(vN);
        if (!gl_FrontFacing) n = -n;
        float ndv = clamp(abs(dot(n, normalize(vV))), 0.0, 1.0);
        float fres = pow(1.0 - ndv, 2.6);
        float b1 = smoothstep(0.50, 0.57, n.x) * (1.0 - smoothstep(0.64, 0.72, n.x));
        float b2 = smoothstep(-0.47, -0.42, n.x) * (1.0 - smoothstep(-0.36, -0.31, n.x));
        float hi = clamp((b1 + b2 * 0.7) * uBands, 0.0, 1.0);
        vec3 col = mix(uTint, uEdge, fres);
        col = mix(col, vec3(1.0), hi);
        float a = uOpacity + fres * 0.62;
        a = max(a, hi * 0.75);
        gl_FragColor = vec4(col, clamp(a, 0.0, 0.9));
      }`;

    function glassMat(side, opacity, bands, tint, edge) {
      return new THREE.ShaderMaterial({
        uniforms: {
          uTint: { value: new V3(...(tint || [0.93, 0.95, 0.97])) },
          uEdge: { value: new V3(...(edge || [0.32, 0.36, 0.42])) },
          uOpacity: { value: opacity },
          uBands: { value: bands }
        },
        vertexShader: GLASS_VS,
        fragmentShader: GLASS_FS,
        transparent: true,
        depthWrite: false,
        side
      });
    }

    function canvasTex(w, h, draw) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      draw(c.getContext('2d'), w, h);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      return t;
    }

    // Escala de medición impresa en el tubo (0–20)
    const MARK = { w: 192, h: 2048, pad: 40 };
    function markingTexture() {
      return canvasTex(MARK.w, MARK.h, (g, w, h) => {
        const step = (h - MARK.pad * 2) / 20;
        g.fillStyle = '#1b1f26';
        g.fillRect(24, MARK.pad - 2, 4, h - MARK.pad * 2 + 4);
        g.font = '600 46px Inter, Arial, sans-serif';
        g.textBaseline = 'middle';
        for (let i = 0; i <= 40; i++) {
          const y = h - MARK.pad - (i / 2) * step;
          const major = i % 2 === 0;
          g.fillRect(24, y - 2, major ? (i % 10 === 0 ? 64 : 52) : 30, 4);
          if (major && i > 0) g.fillText(String(i / 2), 92, y + 2);
        }
      });
    }

    function labelTexture(ml) {
      return canvasTex(640, 404, (g, w, h) => {
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#8fd4ea'; g.fillRect(0, 248, w, h - 248);
        g.fillStyle = '#10141a'; g.textAlign = 'center';
        g.font = '800 56px Manrope, Arial, sans-serif'; g.fillText('GEL', w / 2, 80);
        g.font = '800 42px Manrope, Arial, sans-serif';
        g.fillText('LUBRICANTE', w / 2, 140);
        g.fillText('ÍNTIMO', w / 2, 190);
        g.font = '800 50px Manrope, Arial, sans-serif'; g.fillText('NEUTRO', w / 2, 318);
        g.font = '600 24px Inter, Arial, sans-serif'; g.fillText('BASE ACUOSA · ' + ml + ' ml', w / 2, 364);
      });
    }

    function shadowTexture() {
      return canvasTex(256, 256, (g, w) => {
        const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
        r.addColorStop(0, 'rgba(0,0,0,0.62)');
        r.addColorStop(0.45, 'rgba(0,0,0,0.30)');
        r.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = r; g.fillRect(0, 0, w, w);
      });
    }

    let M = null;
    function materials() {
      if (M) return M;
      M = {
        plastic: new THREE.MeshPhysicalMaterial({ color: 0x0b0c0f, roughness: 0.32, metalness: 0, clearcoat: 0.75, clearcoatRoughness: 0.22 }),
        silicone: new THREE.MeshStandardMaterial({ color: 0x141619, roughness: 0.62, metalness: 0 }),
        rubber: new THREE.MeshStandardMaterial({ color: 0x0f1013, roughness: 0.4, metalness: 0 }),
        capWhite: new THREE.MeshPhysicalMaterial({ color: 0xf2f4f6, roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.2 }),
        glassBack: glassMat(THREE.BackSide, 0.035, 0.5),
        glassFront: glassMat(THREE.FrontSide, 0.07, 1.0),
        marks: new THREE.MeshBasicMaterial({ map: markingTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
        dim: new THREE.MeshBasicMaterial({ color: 0x0a84c6, toneMapped: false }),
        labels: {},
        shadow: shadowTexture()
      };
      return M;
    }

    function labelMat(ml) {
      const m = materials();
      if (!m.labels[ml]) m.labels[ml] = new THREE.MeshStandardMaterial({ map: labelTexture(ml), roughness: 0.42 });
      return m.labels[ml];
    }

    function glassPair(geo) {
      const g = new THREE.Group();
      const back = new THREE.Mesh(geo, M.glassBack); back.renderOrder = 1;
      const front = new THREE.Mesh(geo, M.glassFront); front.renderOrder = 3;
      g.add(back, front);
      return g;
    }

    function addShadow(parent, x, z, rx, rz, opacity) {
      const mat = new THREE.MeshBasicMaterial({ map: M.shadow, transparent: true, depthWrite: false, opacity, color: 0x0a0f18, toneMapped: false });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      m.rotation.x = -Math.PI / 2;
      m.scale.set(rx * 2, rz * 2, 1);
      m.position.set(x, 0.002, z);
      m.renderOrder = 0;
      m.userData.isShadow = true;
      parent.add(m);
      return m;
    }

    /* ------------------------------------------------------------------
       Perfiles (radio, altura) — 1 unidad = 10 cm
       ------------------------------------------------------------------ */
    const BASE_PTS = [[0.215, 0], [0.335, 0], [0.35, 0.012], [0.353, 0.036], [0.343, 0.07], [0.327, 0.11],
      [0.319, 0.15], [0.318, 0.27], [0.313, 0.31], [0.3, 0.33], [0.287, 0.33], [0.287, 0.07],
      [0.262, 0.05], [0.232, 0.03], [0.215, 0]];
    const DOME_PTS = [[0.285, 2.1], [0.283, 2.135], [0.271, 2.165], [0.243, 2.19], [0.185, 2.205], [0.09, 2.212], [0, 2.212]];
    const CONE_PTS = [[0, 2.2], [0.096, 2.2], [0.102, 2.214], [0.1, 2.24], [0.078, 2.31], [0.058, 2.37],
      [0.05, 2.38], [0.05, 2.4], [0.044, 2.41], [0.044, 2.475], [0, 2.475]];
    const BARREL_PTS = [[0, 1.13], [0.108, 1.13], [0.112, 1.15], [0.112, 1.55], [0.106, 1.585], [0.088, 1.605], [0.04, 1.613], [0, 1.613]];
    const FUNDA_PTS = [[0.075, 0], [0.27, 0], [0.3, 0.02], [0.306, 0.06], [0.292, 0.11], [0.245, 0.158],
      [0.172, 0.184], [0.112, 0.18], [0.086, 0.152], [0.076, 0.09], [0.075, 0]];
    const SLEEVE_PTS = [[0.31, 0], [0.43, 0], [0.45, 0.02], [0.453, 0.06], [0.44, 0.1], [0.428, 0.145],
      [0.44, 0.19], [0.453, 0.236], [0.446, 0.268], [0.425, 0.29], [0.31, 0.29], [0.3, 0.27], [0.3, 0.02], [0.31, 0]];

    /* ------------------------------------------------------------------
       Bomba Power Pump Men 2.0
       ------------------------------------------------------------------ */
    function buildPump() {
      const root = new THREE.Group();

      // Base de silicona
      const base = new THREE.Group();
      base.add(mesh(lathe(BASE_PTS, 96), M.silicone));

      // Tubo de acrílico + escala + conector
      const tube = new THREE.Group();
      const tubeGeo = new THREE.CylinderGeometry(0.285, 0.285, 2.02, 72, 1, true);
      tubeGeo.translate(0, 1.09, 0);
      tube.add(glassPair(tubeGeo), glassPair(lathe(DOME_PTS, 72)));
      const markH = 1.7;
      const markGeo = new THREE.CylinderGeometry(0.2885, 0.2885, markH, 24, 1, true, -0.275, 0.55);
      markGeo.translate(0, 0.327 + markH / 2, 0);
      const marks = new THREE.Mesh(markGeo, M.marks);
      marks.renderOrder = 2;
      tube.add(marks);
      tube.add(mesh(lathe(CONE_PTS, 48), M.plastic));

      // Manguera corrugada
      const hose = new THREE.Group();
      const curve = new THREE.CatmullRomCurve3([
        new V3(0, 2.44, 0), new V3(0, 2.7, 0), new V3(0.12, 2.98, 0.01), new V3(0.42, 3.14, 0.02),
        new V3(0.78, 3.12, 0.02), new V3(1.07, 2.92, 0.01), new V3(1.22, 2.6, 0), new V3(1.25, 2.3, 0), new V3(PX, 2.12, 0)
      ], false, 'centripetal');
      const SEG = 440, RAD = 14;
      const hoseGeo = new THREE.TubeGeometry(curve, SEG, 0.04, RAD, false);
      const pos = hoseGeo.attributes.position, P = new V3(), Q = new V3();
      const ridges = Math.round(curve.getLength() / 0.034);
      for (let i = 0; i <= SEG; i++) {
        curve.getPointAt(i / SEG, P);
        const ph = (i / SEG) * ridges * Math.PI * 2;
        const s = 0.9 + 0.2 * Math.pow(0.5 + 0.5 * Math.cos(ph), 0.7);
        for (let j = 0; j <= RAD; j++) {
          const k = i * (RAD + 1) + j;
          Q.fromBufferAttribute(pos, k).sub(P).multiplyScalar(s).add(P);
          pos.setXYZ(k, Q.x, Q.y, Q.z);
        }
      }
      hoseGeo.computeVertexNormals();
      hose.add(mesh(hoseGeo, M.rubber));

      // Bomba de succión, válvula y asa
      const pump = new THREE.Group();
      pump.add(
        mesh(cyl(0.055, 0.055, 0.19), M.plastic, PX, 2.035, 0),
        mesh(cyl(0.06, 0.054, 0.05), M.plastic, PX, 2.13, 0),
        mesh(cyl(0.05, 0.05, 0.05, 6), M.plastic, PX, 1.86, 0),
        mesh(cyl(0.034, 0.034, 0.36), M.plastic, PX, 1.77, 0),
        mesh(lathe(BARREL_PTS, 48), M.plastic, PX, 0, 0),
        mesh(cyl(0.115, 0.12, 0.04, 48), M.plastic, PX, 1.01, 0)
      );
      const stem = mesh(cyl(0.028, 0.028, 0.08), M.plastic, PX + 0.09, 2.04, 0);
      stem.rotation.z = Math.PI / 2;
      const port = mesh(cyl(0.026, 0.026, 0.06), M.plastic, PX - 0.075, 2.06, 0);
      port.rotation.z = Math.PI / 2;
      const knobGeo = knurl(18, 0.066, 0.058, 0.07);
      knobGeo.translate(0, 0, -0.035);
      const knob = mesh(knobGeo, M.plastic, PX + 0.165, 2.04, 0);
      knob.rotation.y = Math.PI / 2;
      const ringGeo = knurl(40, 0.131, 0.123, 0.1);
      const ring = mesh(ringGeo, M.plastic, PX, 1.03, 0);
      ring.rotation.x = -Math.PI / 2;
      pump.add(stem, port, knob, ring);

      const frameShape = roundedPath(new THREE.Shape(), [[-0.2, 0], [0.2, 0], [0.25, -0.62], [-0.25, -0.62]], 0.055);
      frameShape.holes.push(roundedPath(new THREE.Path(), [[-0.142, -0.062], [0.142, -0.062], [0.19, -0.56], [-0.19, -0.56]], 0.035));
      pump.add(mesh(extrude(frameShape, 0.064, 0.012), M.plastic, PX, 0.99, 0));

      const tShape = roundedPath(new THREE.Shape(), [[-0.024, 0.02], [0.024, 0.02], [0.024, -0.135], [0.125, -0.135], [0.142, -0.165],
        [0.128, -0.198], [0.1, -0.188], [0.06, -0.183], [-0.06, -0.183], [-0.1, -0.188], [-0.128, -0.198], [-0.142, -0.165], [-0.125, -0.135], [-0.024, -0.135]], 0.012);
      const trigger = mesh(extrude(tShape, 0.036, 0.008), M.plastic, PX, 0.99, 0);
      pump.add(trigger);

      // Explosión (despiece) — desplazamientos de cada pieza
      base.userData.explode = new V3(0, 0, 0);
      tube.userData.explode = new V3(0, 0.5, 0);
      hose.userData.explode = new V3(0.12, 0.92, 0);
      pump.userData.explode = new V3(0.62, 0.42, 0);
      root.add(base, tube, hose, pump);

      const hosePt = curve.getPointAt(0.27);
      const hotspots = [
        { id: 'tubo', n: 1, part: tube, pos: new V3(-0.2, 1.45, 0.205), nrm: new V3(-0.7, 0, 0.71), title: 'Tubo cilíndrico', text: 'Cámara transparente con escala de medición para controlar la succión.' },
        { id: 'base', n: 2, part: base, pos: new V3(0, 0.19, 0.322), nrm: new V3(0, 0, 1), title: 'Base de silicona', text: 'Sella herméticamente para un vacío seguro y cómodo.' },
        { id: 'manguera', n: 3, part: hose, pos: hosePt.clone().add(new V3(0, 0, 0.045)), nrm: new V3(0, 0.3, 1), title: 'Manguera flexible', text: 'Te da libertad de movimiento mientras bombeás.' },
        { id: 'valvula', n: 4, part: pump, pos: new V3(PX + 0.205, 2.04, 0), nrm: new V3(1, 0, 0.25), title: 'Válvula de liberación', text: 'Libera el vacío de forma rápida y segura.' },
        { id: 'bomba', n: 5, part: pump, pos: new V3(PX, 1.36, 0.114), nrm: new V3(0, 0, 1), title: 'Bomba de succión', text: 'Genera el vacío de forma gradual y controlada.' },
        { id: 'asa', n: 6, part: pump, pos: new V3(PX + 0.232, 0.64, 0.035), nrm: new V3(1, 0, 0.35), title: 'Asa ergonómica', text: 'Agarre cómodo para un bombeo eficiente.' }
      ];
      hotspots.forEach(h => h.nrm.normalize());

      // Cotas (medidas)
      const dims = new THREE.Group();
      const bar = (a, b) => {
        const d = new V3().subVectors(b, a), len = d.length();
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, len, 8), M.dim);
        m.position.copy(a).addScaledVector(d, 0.5);
        m.quaternion.setFromUnitVectors(new V3(0, 1, 0), d.normalize());
        dims.add(m);
      };
      const hx = -0.5, top = 2.212;
      bar(new V3(hx, 0.004, 0), new V3(hx, top, 0));
      bar(new V3(hx - 0.045, 0.004, 0), new V3(hx + 0.045, 0.004, 0));
      bar(new V3(hx - 0.045, top, 0), new V3(hx + 0.045, top, 0));
      const wz = 0.5;
      bar(new V3(-0.353, 0.006, wz), new V3(0.353, 0.006, wz));
      bar(new V3(-0.353, 0.006, wz - 0.045), new V3(-0.353, 0.006, wz + 0.045));
      bar(new V3(0.353, 0.006, wz - 0.045), new V3(0.353, 0.006, wz + 0.045));
      dims.visible = false;
      root.add(dims);
      const dimLabels = [
        { pos: new V3(hx, top / 2, 0), text: '22 cm' },
        { pos: new V3(0, 0.006, wz + 0.02), text: '6,9 cm' }
      ];

      return { root, parts: [base, tube, hose, pump], trigger, triggerY: 0.99, hotspots, dims, dimLabels };
    }

    /* ------------------------------------------------------------------
       Accesorios de los kits
       ------------------------------------------------------------------ */
    const ACC = {
      funda() {
        const g = new THREE.Group();
        g.add(mesh(lathe(FUNDA_PTS, 72), M.silicone));
        g.userData.r = 0.31;
        return g;
      },
      sleeve(o) {
        const g = new THREE.Group();
        g.add(mesh(lathe(SLEEVE_PTS, 96), M.silicone));
        g.userData.r = 0.455;
        return g;
      },
      sleeveStack() {
        const g = new THREE.Group();
        let y = 0;
        [1, 0.82, 0.66].forEach(s => {
          const m = mesh(lathe(SLEEVE_PTS, 96), M.silicone, 0, y, 0);
          m.scale.setScalar(s);
          g.add(m);
          y += 0.29 * s - 0.035 * s;
        });
        g.userData.r = 0.455;
        return g;
      },
      aro() {
        const g = new THREE.Group();
        const geo = new THREE.TorusGeometry(0.118, 0.046, 28, 72);
        geo.rotateX(Math.PI / 2);
        g.add(mesh(geo, M.silicone, 0, 0.046, 0));
        g.userData.r = 0.17;
        return g;
      },
      gel(o) {
        const g = new THREE.Group();
        const body = lathe([[0, 0.004], [0.104, 0.004], [0.119, 0.018], [0.122, 0.045], [0.122, 0.4], [0.115, 0.425], [0.092, 0.44], [0.07, 0.446], [0, 0.446]], 56);
        g.add(glassPair(body));
        g.add(mesh(lathe([[0, 0.03], [0.108, 0.03], [0.111, 0.05], [0.111, 0.33], [0, 0.33]], 48),
          new THREE.MeshPhysicalMaterial({ color: 0xe9f3f7, roughness: 0.15, transparent: true, opacity: 0.35, depthWrite: false })));
        const lab = new THREE.CylinderGeometry(0.1235, 0.1235, 0.27, 56, 1, true, -Math.PI * 0.55, Math.PI * 1.1);
        g.add(mesh(lab, labelMat(o.ml || 30), 0, 0.215, 0));
        const capGeo = knurl(36, 0.112, 0.106, 0.13);
        const cap = mesh(capGeo, M.capWhite, 0, 0.444, 0);
        cap.rotation.x = -Math.PI / 2;
        g.add(cap, mesh(cyl(0.106, 0.106, 0.012, 40), M.capWhite, 0, 0.58, 0));
        g.userData.r = 0.13;
        return g;
      }
    };

    const KITS = {
      pump: [],
      starter: [{ type: 'funda', x: -0.82, z: 0.5 }, { type: 'aro', x: 0.55, z: 0.82 }],
      power: [{ type: 'sleeve', x: -0.9, z: 0.55 }, { type: 'gel', x: 0.62, z: 0.82, ml: 30 }],
      elite: [{ type: 'sleeveStack', x: -0.92, z: 0.55 }, { type: 'aro', x: 0.36, z: 0.95 }, { type: 'gel', x: 0.86, z: 0.78, ml: 50 }]
    };

    function buildModel(kit) {
      materials();
      const model = new THREE.Group();
      const pump = buildPump();
      model.add(pump.root);
      addShadow(model, 0, 0, 0.6, 0.6, 0.62);
      addShadow(model, PX + 0.02, 0.02, 0.48, 0.26, 0.18);
      (KITS[kit] || []).forEach(it => {
        const o = ACC[it.type](it);
        o.position.set(it.x, 0, it.z);
        model.add(o);
        addShadow(model, it.x, it.z, o.userData.r * 1.45, o.userData.r * 1.45, 0.5);
      });
      return { model, pump };
    }

    function disposeTree(obj) {
      obj.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.userData.isShadow && o.material) o.material.dispose();
      });
    }

    /* ------------------------------------------------------------------
       Visor
       ------------------------------------------------------------------ */
    const viewers = new Set();
    let lastFrame = performance.now();
    function loop(t) {
      const dt = Math.min(0.05, (t - lastFrame) / 1000);
      lastFrame = t;
      if (!document.hidden) viewers.forEach(v => { if (v.visible) v.tick(dt, t / 1000); });
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    class Viewer {
      constructor(el, opts) {
        this.el = el;
        this.o = Object.assign({
          kit: 'pump', mode: 'turntable', auto: 'always', animate: false, hotspots: false,
          yaw: -0.45, elevation: 0.13, margin: 1.06, speed: 0.38
        }, opts);
        if (REDUCED) { if (this.o.auto === 'always') this.o.auto = false; this.o.animate = false; }

        const canvas = document.createElement('canvas');
        canvas.className = 'v3d-canvas';
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        renderer.setClearColor(0x000000, 0);
        this.renderer = renderer;
        this.canvas = canvas;
        el.appendChild(canvas);

        const scene = new THREE.Scene();
        const pm = new THREE.PMREMGenerator(renderer);
        scene.environment = pm.fromScene(new RoomEnvironment(renderer), 0.04).texture;
        pm.dispose();
        scene.add(new THREE.HemisphereLight(0xffffff, 0xd9dee6, 0.55));
        const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(3, 5, 4);
        const rim = new THREE.DirectionalLight(0xcfe6ff, 1.1); rim.position.set(-4, 3, -3);
        scene.add(key, rim);
        this.scene = scene;

        this.camera = new THREE.PerspectiveCamera(26, 1, 0.05, 100);
        this.pivot = new THREE.Group();
        scene.add(this.pivot);

        this.yaw = this.o.yaw; this.vel = 0; this.target = null;
        this.elev = this.o.elevation; this.elevT = this.o.elevation;
        this.explode = 0; this.explodeT = 0;
        this.spin = true; this.dimsOn = false;
        this.lastInteract = -10; this.hover = false; this.dragging = false;
        this.visible = true; this.dirty = true; this.activeId = null;
        this.onFocus = null;

        if (this.o.hotspots) {
          this.hsLayer = document.createElement('div');
          this.hsLayer.className = 'v3d-hs';
          el.appendChild(this.hsLayer);
        }

        this.setKit(this.o.kit, this.o.yaw);
        if (this.o.mode === 'orbit') this.initOrbit(); else this.initTurntable();

        this.ro = new ResizeObserver(() => this.resize());
        this.ro.observe(el);
        this.io = new IntersectionObserver(es => { this.visible = es[0].isIntersecting; if (this.visible) this.dirty = true; }, { rootMargin: '120px' });
        this.io.observe(el);
        this.resize();
        viewers.add(this);
      }

      /* ---- modelo ---- */
      setKit(kit, yaw) {
        if (this.model) { this.pivot.remove(this.model); disposeTree(this.model); }
        const { model, pump } = buildModel(kit);
        this.kit = kit;
        this.pump = pump;
        this.model = model;
        model.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model);
        const c = box.getCenter(new V3());
        model.position.set(-c.x, 0, -c.z);
        this.pivot.add(model);
        this.boxA = box.clone().translate(new V3(-c.x, 0, -c.z));
        // caja con la bomba despiezada
        pump.parts.forEach(p => p.position.copy(p.userData.explode));
        model.updateMatrixWorld(true);
        this.boxB = new THREE.Box3().setFromObject(model).translate(new V3(-c.x, 0, -c.z));
        this.boxB.min.y = Math.min(this.boxB.min.y, 0);
        pump.parts.forEach(p => p.position.set(0, 0, 0));
        this.applyExplode();

        if (typeof yaw === 'number') { this.o.yaw = yaw; this.yaw = yaw; this.target = null; this.vel = 0; }
        this.buildHotspots();
        this.fit();
        if (this.controls) this.placeOrbitCamera();
        this.dirty = true;
      }

      applyExplode() {
        const e = ease(clamp(this.explode, 0, 1));
        this.pump.parts.forEach(p => p.position.copy(p.userData.explode).multiplyScalar(e));
        this.pump.dims.visible = this.dimsOn && this.explode < 0.02;
      }

      fit() {
        const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
        this.camera.aspect = w / h;
        const vf = THREE.MathUtils.degToRad(this.camera.fov) / 2;
        const hf = Math.atan(Math.tan(vf) * this.camera.aspect);
        const calc = box => {
          const s = box.getSize(new V3());
          const r = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z), Math.hypot(s.x / 2, s.z / 2) * 0.82);
          const dV = (s.y / 2 * this.o.margin) / Math.tan(vf) + r * 0.55;
          const dH = (r * this.o.margin) / Math.tan(hf) + r * 0.55;
          return { dist: Math.max(dV, dH), cy: box.min.y + s.y / 2 };
        };
        this.fitA = calc(this.boxA);
        this.fitB = calc(this.boxB);
        this.camera.updateProjectionMatrix();
      }

      updateCamera() {
        if (this.controls) return;
        const e = ease(clamp(this.explode, 0, 1));
        const dist = lerp(this.fitA.dist, this.fitB.dist, e);
        const cy = lerp(this.fitA.cy, this.fitB.cy, e);
        this.camera.position.set(0, cy + Math.sin(this.elev) * dist, Math.cos(this.elev) * dist);
        this.camera.lookAt(0, cy, 0);
      }

      resize() {
        const w = this.el.clientWidth, h = this.el.clientHeight;
        if (!w || !h) return;
        this.renderer.setSize(w, h, false);
        this.fit();
        if (this.controls && !this.orbitPlaced) this.placeOrbitCamera();
        this.dirty = true;
      }

      /* ---- interacción: giro tipo plato ---- */
      initTurntable() {
        const c = this.canvas;
        c.style.touchAction = 'pan-y';
        c.addEventListener('pointerdown', e => {
          if (e.pointerType === 'mouse' && e.button !== 0) return;
          this.dragging = true; this.vel = 0; this.target = null;
          this.px = e.clientX; this.py = e.clientY; this.lastMove = now();
          c.setPointerCapture(e.pointerId);
          this.el.classList.add('is-dragging');
          this.touched();
        });
        c.addEventListener('pointermove', e => {
          if (!this.dragging) return;
          const dx = e.clientX - this.px, dy = e.clientY - this.py;
          this.px = e.clientX; this.py = e.clientY;
          const k = 0.0095;
          this.yaw += dx * k; this.vel = dx * k; this.lastMove = now();
          if (e.pointerType !== 'touch') this.elevT = clamp(this.elevT + dy * 0.004, -0.04, 0.55);
          this.lastInteract = now(); this.dirty = true;
        });
        const up = () => {
          if (!this.dragging) return;
          this.dragging = false;
          if (now() - this.lastMove > 0.09) this.vel = 0;
          this.el.classList.remove('is-dragging');
          this.lastInteract = now();
        };
        c.addEventListener('pointerup', up);
        c.addEventListener('pointercancel', up);
        c.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') { this.hover = true; this.touched(); } });
        c.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { this.hover = false; this.lastInteract = now() - 0.6; } });
      }

      /* ---- interacción: órbita libre con zoom (modal) ---- */
      initOrbit() {
        const ctl = new OrbitControls(this.camera, this.canvas);
        ctl.enableDamping = true; ctl.dampingFactor = 0.08;
        ctl.enablePan = false; ctl.rotateSpeed = 0.8; ctl.zoomSpeed = 0.8;
        ctl.minPolarAngle = 0.2; ctl.maxPolarAngle = Math.PI / 2 + 0.04;
        ctl.autoRotate = !REDUCED; ctl.autoRotateSpeed = 1.4;
        ctl.addEventListener('start', () => { ctl.autoRotate = false; this.touched(); });
        this.controls = ctl;
        this.placeOrbitCamera();
      }

      placeOrbitCamera() {
        const f = this.fitA;
        this.pivot.rotation.y = this.o.yaw;
        this.camera.position.set(0, f.cy + Math.sin(this.o.elevation) * f.dist, Math.cos(this.o.elevation) * f.dist);
        this.controls.target.set(0, f.cy, 0);
        this.controls.minDistance = f.dist * 0.4;
        this.controls.maxDistance = f.dist * 1.7;
        this.controls.autoRotate = !REDUCED;
        this.controls.update();
        this.orbitPlaced = (this.el.clientWidth > 0);
        this.dirty = true;
      }

      touched() {
        if (!this.used) { this.used = true; this.el.dispatchEvent(new CustomEvent('v3d:interact', { bubbles: true })); }
      }

      atRest() { return Math.abs(wrapPi(this.yaw - this.o.yaw)) < 0.002; }

      autoActive(idle) {
        if (this.o.auto === 'always') return this.spin && idle > 2.4;
        if (this.o.auto === 'hover') return this.hover;
        return false;
      }

      /* ---- API pública ---- */
      setExploded(on) { this.explodeT = on ? 1 : 0; this.dirty = true; }
      setDims(on) { this.dimsOn = on; this.applyExplode(); this.dirty = true; }
      setSpin(on) { this.spin = on; this.lastInteract = on ? -10 : now(); this.dirty = true; }

      reset() {
        this.explodeT = 0; this.dimsOn = false; this.spin = true; this.elevT = this.o.elevation;
        this.target = this.yaw + wrapPi(this.o.yaw - this.yaw);
        this.setActive(null);
        this.lastInteract = now();
        this.applyExplode();
        if (this.controls) this.placeOrbitCamera();
        this.dirty = true;
      }

      focus(id) {
        const h = this.hs && this.hs.find(x => x.id === id);
        if (!h) return;
        const p = h.part.position.clone().add(h.pos).add(this.model.position);
        const n = h.nrm;
        // girar para que el componente quede de frente a la cámara
        const ang = Math.atan2(n.x * 0.75 + p.x * 0.25, n.z * 0.75 + p.z * 0.25);
        this.target = this.yaw + wrapPi(-ang - this.yaw);
        this.vel = 0;
        this.lastInteract = now() + 5;
        this.setActive(id);
        this.touched();
        this.dirty = true;
      }

      setActive(id) {
        this.activeId = id;
        if (this.hs) this.hs.forEach(h => h.el.classList.toggle('is-active', h.id === id));
        if (this.onFocus) this.onFocus(id);
      }

      /* ---- hotspots y cotas ---- */
      buildHotspots() {
        if (!this.hsLayer) return;
        this.hsLayer.innerHTML = '';
        this.hs = this.pump.hotspots.map(h => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'hs';
          b.setAttribute('aria-label', h.title);
          b.innerHTML = '<span class="hs-dot">' + h.n + '</span><span class="hs-label"><b>' + h.title + '</b><span>' + h.text + '</span></span>';
          b.addEventListener('click', () => this.focus(h.id));
          this.hsLayer.appendChild(b);
          return Object.assign({ el: b }, h);
        });
        this.dimEls = this.pump.dimLabels.map(d => {
          const s = document.createElement('div');
          s.className = 'dim';
          s.innerHTML = '<span>' + d.text + '</span>';
          this.hsLayer.appendChild(s);
          return Object.assign({ el: s }, d);
        });
      }

      updateHotspots() {
        if (!this.hs) return;
        const w = this.el.clientWidth, h = this.el.clientHeight;
        const P = new V3(), N = new V3(), C = new V3();
        const q = this.pivot.quaternion;
        this.hs.forEach(s => {
          s.part.localToWorld(P.copy(s.pos));
          N.copy(s.nrm).applyQuaternion(q);
          C.copy(this.camera.position).sub(P).normalize();
          const back = N.dot(C) < 0.08;
          P.project(this.camera);
          const x = (P.x * 0.5 + 0.5) * w, y = (-P.y * 0.5 + 0.5) * h;
          s.el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
          s.el.classList.toggle('is-back', back);
          s.el.classList.toggle('flip', x > w - 250);
        });
        const showDims = this.pump.dims.visible;
        this.dimEls.forEach(d => {
          this.model.localToWorld(P.copy(d.pos));
          P.project(this.camera);
          const x = (P.x * 0.5 + 0.5) * w, y = (-P.y * 0.5 + 0.5) * h;
          d.el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
          d.el.classList.toggle('is-on', showDims);
        });
      }

      /* ---- cuadro a cuadro ---- */
      tick(dt, t) {
        let moving = this.dirty;

        if (this.controls) {
          if (this.controls.update(dt)) moving = true;
          if (this.controls.autoRotate) moving = true;
        } else {
          const idle = t - this.lastInteract;
          if (!this.dragging) {
            if (this.target !== null) {
              const d = this.target - this.yaw;
              this.yaw += d * (1 - Math.exp(-dt * 5.5));
              if (Math.abs(d) < 0.0015) { this.yaw = this.target; this.target = null; }
              moving = true;
            } else if (Math.abs(this.vel) > 0.00005) {
              this.yaw += this.vel;
              this.vel *= Math.pow(0.92, dt * 60);
              moving = true;
            } else if (this.autoActive(idle)) {
              this.yaw += dt * this.o.speed;
              moving = true;
            } else if (this.o.auto === 'hover' && !this.hover && idle > 1.4 && !this.atRest()) {
              this.target = this.yaw + wrapPi(this.o.yaw - this.yaw);
            }
          }
          if (Math.abs(this.elevT - this.elev) > 0.0005) {
            this.elev += (this.elevT - this.elev) * (1 - Math.exp(-dt * 8));
            moving = true;
          }
          this.pivot.rotation.y = this.yaw;
        }

        if (Math.abs(this.explodeT - this.explode) > 0.0005) {
          const d = this.explodeT - this.explode;
          this.explode += Math.sign(d) * Math.min(Math.abs(d), dt * 1.6);
          this.applyExplode();
          moving = true;
        }

        if (this.o.animate && this.explode < 0.01) {
          const ph = (t % 3.2) / 3.2;
          const sq = ph < 0.18 ? Math.sin(ph / 0.18 * Math.PI) : 0;
          this.pump.trigger.position.y = this.pump.triggerY - 0.05 * sq;
          moving = true;
        }

        if (!moving) return;
        this.updateCamera();
        this.renderer.render(this.scene, this.camera);
        this.updateHotspots();
        this.dirty = false;
        if (!this.ready) { this.ready = true; this.el.classList.add('is-ready'); }
      }
    }

    return {
      create(el, opts) { return new Viewer(el, opts); }
    };
  }
})();
