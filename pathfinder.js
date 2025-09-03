(function(){
  "use strict";

  // Encapsulated path finding and weighting
  const state = {
    beta: { b1: 0.4, b2: 0.3, b3: 0.3 }, // balanced default
    metricsMedian: { liked: 0, easy: 0, useful: 0 },
    metricsMin: { liked: 0, easy: 0, useful: 0 },
  };

  function setPreference(pref){
    switch(String(pref || '').toLowerCase()){
      case 'liked': state.beta = { b1: 0.7, b2: 0.15, b3: 0.15 }; break;
      case 'easy': state.beta = { b1: 0.15, b2: 0.7, b3: 0.15 }; break;
      case 'useful': state.beta = { b1: 0.15, b2: 0.15, b3: 0.7 }; break;
      default: state.beta = { b1: 0.4, b2: 0.3, b3: 0.3 }; break;
    }
  }

  function updateMetrics({ median, min }){
    if(median){
      state.metricsMedian = {
        liked: Number(median.liked) || 0,
        easy: Number(median.easy) || 0,
        useful: Number(median.useful) || 0,
      };
    }
    if(min){
      state.metricsMin = {
        liked: Number(min.liked) || 0,
        easy: Number(min.easy) || 0,
        useful: Number(min.useful) || 0,
      };
    }
  }

  function reliabilityLambda(r){
    if(typeof r !== 'number' || isNaN(r)) return 1.0;
    if(r > 100) return 1.1;
    if(r >= 50) return 1.0;
    return 0.9;
  }

  function isAndNode(node){ return (node?.id || '').startsWith('and-'); }
  function isOrNode(node){ return !!node?.isGroup || (node?.id || '').startsWith('or-'); }
  function isCourseNode(node){ return node && !isAndNode(node) && !isOrNode(node); }
  const keyOf = (n) => (n && (n.uid || n.id));

  function getCourseWeight(courseId, courseMap){
    const c = courseMap.get(courseId) || {};
    const x1 = typeof c.liked === 'number' ? c.liked : null;
    const x2 = typeof c.easy === 'number' ? c.easy : null;
    const x3 = typeof c.useful === 'number' ? c.useful : null;
    const r = typeof c.ratings === 'number' ? c.ratings : null;

    let s = 0;
    if(x1 == null && x2 == null && x3 == null){
      const gamma = 0.7; // mid of [0.3,0.7]
      const v = gamma * Math.min(state.metricsMin.liked || 0, state.metricsMin.easy || 0, state.metricsMin.useful || 0);
      s = state.beta.b1 * v + state.beta.b2 * v + state.beta.b3 * v;
      return Math.min(0.95 * s, 100);
    }
    const v1 = x1 == null ? state.metricsMedian.liked : x1;
    const v2 = x2 == null ? state.metricsMedian.easy : x2;
    const v3 = x3 == null ? state.metricsMedian.useful : x3;
    s = state.beta.b1 * v1 + state.beta.b2 * v2 + state.beta.b3 * v3;
    return Math.min(reliabilityLambda(r) * s, 100);
  }

  // p_v(d): depth-aware new-course penalty, applied only the first time a course_id is selected
  let LAMBDA0 = 0.2; // base λ0; reflected in README as p_v(d) = λ0 / (1 + d)
  function pv(depth){ return LAMBDA0 / (1 + depth); }

  function selectSubtree(node, courseMap, selectedIds, depth){
    if(!node) return { cost: 0, selectedDisplay: new Set(), selectedIds: new Set(selectedIds || []) };
    const children = node.children || [];

    // Course node
    if(isCourseNode(node)){
      const weight = getCourseWeight(node.id, courseMap);
      const idsIn = new Set(selectedIds || []);
      const isNew = !idsIn.has(node.id);
      // Charge base cost only on first inclusion; reuse adds zero base cost and zero penalty
      const baseCost = isNew ? (1 - (weight / 100)) : 0;
      const penalty = isNew ? pv(depth) : 0;
      let totalCost = baseCost + penalty;
      // display set uses uid/id for highlighting
      const display = new Set([keyOf(node)]);
      idsIn.add(node.id);
      let idsOut = idsIn;
      for(const c of children){
        const res = selectSubtree(c, courseMap, idsOut, depth + 1);
        totalCost += res.cost;
        for(const k of res.selectedDisplay) display.add(k);
        idsOut = res.selectedIds; // accumulate
      }
      return { cost: totalCost, selectedDisplay: display, selectedIds: idsOut };
    }

    // AND node
    if(isAndNode(node)){
      let totalCost = 0; const display = new Set();
      let ids = new Set(selectedIds || []);
      for(const c of children){
        const res = selectSubtree(c, courseMap, ids, depth + 1);
        totalCost += res.cost;
        for(const k of res.selectedDisplay) display.add(k);
        ids = res.selectedIds;
      }
      return { cost: totalCost, selectedDisplay: display, selectedIds: ids };
    }

    // OR node
    if(isOrNode(node)){
      let best = null; let bestIdx = -1;
      for(let i=0;i<children.length;i++){
        const res = selectSubtree(children[i], courseMap, new Set(selectedIds || []), depth + 1);
        if(!best || res.cost < best.cost - 1e-6 || (Math.abs(res.cost - best.cost) <= 1e-6 && bestIdx < 0)){
          best = res; bestIdx = i;
        }
      }
      return best || { cost: 0, selectedDisplay: new Set(), selectedIds: new Set(selectedIds || []) };
    }

    // Fallback for junction-like nodes
    let total = 0; const disp = new Set(); let idsF = new Set(selectedIds || []);
    for(const c of children){
      const res = selectSubtree(c, courseMap, idsF, depth + 1);
      total += res.cost; for(const k of res.selectedDisplay) disp.add(k); idsF = res.selectedIds;
    }
    return { cost: total, selectedDisplay: disp, selectedIds: idsF };
  }

  function computeSelection(root, courseMap){
    const res = selectSubtree(root, courseMap, new Set(), 0);
    return res.selectedDisplay || new Set();
  }

  window.PathFinder = {
    setPreference,
    updateMetrics,
    computeSelection,
    isCourseNode,
    getCourseWeight: (id, courseMap) => getCourseWeight(id, courseMap),
    pv: (d) => pv(d),
    setPenaltyBase: (lambda0) => { const v = Number(lambda0); if(!isNaN(v) && v >= 0) LAMBDA0 = v; },
  };
})();

