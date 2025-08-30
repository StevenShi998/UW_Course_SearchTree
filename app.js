(function(){
  "use strict";

  // Data comes from the backend API only

  const statusEl = document.getElementById("status");
  const prereqContainer = document.getElementById("prereq-tree");
  const futureContainer = document.getElementById("future-tree");
  const prereqMinimapContainer = document.getElementById("prereq-minimap");
  const futureMinimapContainer = document.getElementById("future-minimap");
  const courseInput = document.getElementById("course-input");
  const searchBtn = document.getElementById("search-btn");
  const futureDepthSelect = document.getElementById("future-depth");
  const prereqDepthSelect = document.getElementById("prereq-depth");
  const prereqZoomInBtn = document.getElementById("prereq-zoom-in-btn");
  const prereqZoomOutBtn = document.getElementById("prereq-zoom-out-btn");
  const prereqZoomResetBtn = document.getElementById("prereq-zoom-reset-btn");
  const futureZoomInBtn = document.getElementById("future-zoom-in-btn");
  const futureZoomOutBtn = document.getElementById("future-zoom-out-btn");
  const futureZoomResetBtn = document.getElementById("future-zoom-reset-btn");
  const suggestionsEl = document.getElementById("suggestions");
  const searchHistoryEl = document.getElementById("search-history");
  const prefSelect = document.getElementById("pref-select");
  const clearSelectionBtn = document.getElementById("clear-selection-btn");

  /** Data shapes
   * courses: Map<course_id, { course_id, title?, units? }>
   * prereqs: Array<{ course_id, prereq_course_id, prerequisite_group }>
   */
  let courseIdToCourse = new Map();
  let prereqRows = [];
  // Keep last rendered trees for responsive reflow
  let lastPrereqRoot = null;
  let lastFutureRoot = null;
  let suggestionIndex = -1;
  let allCourseCodesCache = [];
  let suggestAbort = null;
  let suggestTimer = null;
  let apiAvailable = false;
  let prereqZoom = 1.0;
  let futureZoom = 1.0;
  let shouldAutoZoomPrereq = false;
  let shouldAutoZoomFuture = false;
  let currentCourseId = null;
  let searchHistory = [];
  let currentSelection = new Set(); // set of course ids in selected subtree
  const hasSelectedMap = new Map(); // node -> boolean for quick edge highlight

  // Preference betas
  // Delegated to PathFinder
  let metricsMedian = { liked: 0, easy: 0, useful: 0 };
  let metricsMin = { liked: 0, easy: 0, useful: 0 };

  function isCourseNode(node){ return PathFinder.isCourseNode(node); }

  function computeSelection(){
    if(!lastPrereqRoot){ currentSelection = new Set(); return; }
    currentSelection = PathFinder.computeSelection(lastPrereqRoot, courseIdToCourse);
  }

  function nodeKey(n){ return (n && (n.uid || n.id)); }

  function markHasSelected(node){
    if(!node) return false;
    const children = node.children || [];
    let any = isCourseNode(node) && currentSelection.has(nodeKey(node));
    for(const c of children){ any = markHasSelected(c) || any; }
    hasSelectedMap.set(node, any);
    return any;
  }

  function loadSearchHistory(){
    try{
      const raw = localStorage.getItem('uw_search_history') || '[]';
      const arr = JSON.parse(raw);
      if(Array.isArray(arr)) searchHistory = arr.slice(0, 10);
    }catch(_){ searchHistory = []; }
    renderSearchHistory();
  }

  function saveSearchHistory(){
    try{ localStorage.setItem('uw_search_history', JSON.stringify(searchHistory.slice(0,10))); }catch(_){ }
  }

  function addToSearchHistory(code){
    code = normalizeCode(code);
    if(!code) return;
    searchHistory = [code, ...searchHistory.filter(c => c !== code)].slice(0,10);
    saveSearchHistory();
    renderSearchHistory();
  }

  function renderSearchHistory(){
    if(!searchHistoryEl) return;
    // Render all first
    searchHistoryEl.innerHTML = searchHistory.map(code => `<button class="history-item" data-code="${code}">${code}</button>`).join("");
    // After render, trim from the right if overflowing the container
    // Keep left-to-right order with newest on the left per addToSearchHistory
    const maxWidth = searchHistoryEl.clientWidth;
    const children = Array.from(searchHistoryEl.children);
    let total = 0;
    for(let i=0;i<children.length;i++){
      const el = children[i];
      const w = el.offsetWidth + 8; // include gap
      if(total + w <= maxWidth){
        total += w;
      } else {
        // remove this and all to its right (rightmost end)
        for(let j=children.length-1;j>=i;j--){
          if(children[j].parentNode === searchHistoryEl) searchHistoryEl.removeChild(children[j]);
        }
        break;
      }
    }
  }

  if(searchHistoryEl){
    searchHistoryEl.addEventListener('click', (e)=>{
      const btn = e.target.closest('.history-item');
      if(btn){ pickSuggestion(btn.getAttribute('data-code')); }
    });
  }

  // Simple CSV loader
  async function tryFetchText(url){
    try{
      const res = await fetch(url);
      if(!res.ok) return "";
      const text = await res.text();
      return text || "";
    }catch(_) {
      return "";
    }
  }

  function parseCSV(text){
    if(!text) return [];
    const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
    if(lines.length === 0) return [];
    const headers = lines[0].split(",").map(h=>h.trim());
    return lines.slice(1).map(line => {
      const cols = splitCSVLine(line);
      const obj = {};
      headers.forEach((h, i)=>{ obj[h] = (cols[i] ?? "").trim(); });
      return obj;
    });
  }

  function updateAllCourseCodesCache(){
    const codes = new Set();
    for(const key of courseIdToCourse.keys()) codes.add(key);
    for(const r of prereqRows){
      if(r.course_id) codes.add(r.course_id);
      if(r.prereq_course_id) codes.add(r.prereq_course_id);
    }
    function collectFromTree(root){
      if(!root) return;
      const stack = [root];
      while(stack.length){
        const n = stack.pop();
        if(!n) continue;
        if(n.id) codes.add(String(n.id).toUpperCase());
        const kids = n.children || [];
        for(const k of kids) stack.push(k);
      }
    }
    collectFromTree(lastPrereqRoot);
    collectFromTree(lastFutureRoot);
    allCourseCodesCache = Array.from(codes);
  }

  // Splits a CSV line respecting quotes
  function splitCSVLine(line){
    const out = [];
    let cur = "";
    let inQuotes = false;
    for(let i=0;i<line.length;i++){
      const ch = line[i];
      if(ch === '"'){
        if(inQuotes && line[i+1] === '"'){ cur += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if(ch === ',' && !inQuotes){
        out.push(cur); cur = "";
      } else { cur += ch; }
    }
    out.push(cur);
    return out;
  }

  // Build indexes for quick traversal
  function buildIndexes(){
    // Index: course -> groups -> list of prereq course ids
    // We will keep structure: { [group]: { type: 'AND'|'OR', courses: [] } } with type computed from group size
    const map = new Map();
    for(const row of prereqRows){
      const courseId = normalizeCode(row.course_id || row.code || "");
      const prereqId = normalizeCode(row.prereq_course_id || "");
      if(!courseId || !prereqId) continue;
      const group = Number(row.prerequisite_group || 1);
      if(!map.has(courseId)) map.set(courseId, new Map());
      const groups = map.get(courseId);
      if(!groups.has(group)) groups.set(group, { type: 'AND', courses: [] });
      groups.get(group).courses.push({id: prereqId, min_grade: row.min_grade});
    }
    return map;
  }

  function normalizeCode(text){
    if(!text) return "";
    return String(text).replace(/\s+/g, "").toUpperCase();
  }

  function tinySample(){
    // Minimal realistic demo data
    const courses = [
      { course_id:"MATH135", title:"Algebra" },
      { course_id:"MATH136", title:"Linear Algebra 1" },
      { course_id:"MATH235", title:"Linear Algebra 2" },
      { course_id:"AMATH250", title:"Intro to Differential Equations" },
      { course_id:"AMATH251", title:"Differential Equations (Advanced)" },
      { course_id:"AMATH351", title:"Systems of DEs" }
    ];
    const prereqs = [
      { course_id:"MATH136", prereq_course_id:"MATH135", prerequisite_group:1 },
      { course_id:"MATH235", prereq_course_id:"MATH136", prerequisite_group:1 },
      { course_id:"AMATH250", prereq_course_id:"MATH136", prerequisite_group:1 },
      { course_id:"AMATH251", prereq_course_id:"AMATH250", prerequisite_group:1 },
      { course_id:"AMATH251", prereq_course_id:"MATH235", prerequisite_group:1 },
      { course_id:"AMATH351", prereq_course_id:"AMATH251", prerequisite_group:1 }
    ];
    return { courses, prereqs };
  }

  async function loadData(){
    // If API is reachable, prefer it and do not load any local/sample data
    const apiBase = window.API_BASE || (new URLSearchParams(location.search).get("api")) || "http://localhost:8000";
    try{
      const controller = new AbortController();
      const tid = setTimeout(()=>controller.abort(), 1500);
      const ping = await fetch(`${apiBase}/api/health`, { signal: controller.signal });
      clearTimeout(tid);
      if(ping.ok){
        apiAvailable = true;
        statusEl.textContent = "";
        return; // use DB-backed API only
      }
    }catch(_){ /* fall back to local */ }
    // Try to load local CSVs; otherwise fall back to a tiny built-in sample
    // Expected CSVs (optional): ./courses.csv and ./course_prereq.csv
    // headers:
    //  - courses.csv: course_id, course_name?, units?
    //  - course_prereq.csv: course_id, prereq_course_id, prerequisite_group, min_grade?
    const coursesText = await tryFetchText("./courses.csv");
    const prereqText = await tryFetchText("./course_prereq.csv");

    if(coursesText || prereqText){
      const coursesRows = parseCSV(coursesText);
      const prereqs = parseCSV(prereqText);
      courseIdToCourse = new Map();
      for(const r of coursesRows){
        const id = normalizeCode(r.course_id || r.code || "");
        if(!id) continue;
        courseIdToCourse.set(id, {
          course_id: id,
          title: r.title || r.course_name || r.name || "",
          units: r.units ? Number(r.units) : undefined
        });
      }
      prereqRows = prereqs.map(r => ({
        course_id: normalizeCode(r.course_id || r.code || ""),
        prereq_course_id: normalizeCode(r.prereq_course_id || r.prereq || ""),
        prerequisite_group: Number(r.prerequisite_group || r.group || 1),
        min_grade: r.min_grade !== undefined && r.min_grade !== "" ? Number(r.min_grade) : undefined
      })).filter(r => r.course_id && r.prereq_course_id);
      updateAllCourseCodesCache();
      statusEl.textContent = "";
      return;
    }

    // Fallback: support a demo file named "sample groups.csv" in the project root
    // Format (first line may be a label like "Table 1"): course_id,prereq_course_id,prerequisite_group,min_grade,...
    const sampleGroupsText = await tryFetchText("./sample groups.csv");
    if(sampleGroupsText){
      const lines = sampleGroupsText.replace(/\r/g, "").split("\n").filter(Boolean);
      let headerIdx = lines.findIndex(l => /course_id/i.test(l) && /prereq_course_id/i.test(l));
      if(headerIdx >= 0){
        const headers = lines[headerIdx].split(",").map(h=>h.trim());
        const rows = [];
        for(let i=headerIdx+1;i<lines.length;i++){
          const cols = splitCSVLine(lines[i]);
          const obj = {};
          headers.forEach((h, j)=>{ obj[h] = (cols[j] ?? "").trim(); });
          rows.push(obj);
        }
        prereqRows = rows.map(r => ({
          course_id: normalizeCode(r.course_id || r.code || ""),
          prereq_course_id: normalizeCode(r.prereq_course_id || r.prereq || ""),
          prerequisite_group: Number(r.prerequisite_group || r.group || 1),
          min_grade: (r.min_grade && r.min_grade !== "NA") ? Number(r.min_grade) : undefined
        })).filter(r => r.course_id && r.prereq_course_id);
        // Build minimal course map from discovered ids so labels render nicely
        courseIdToCourse = new Map();
        const seen = new Set();
        for(const r of prereqRows){
          if(!seen.has(r.course_id)){ seen.add(r.course_id); courseIdToCourse.set(r.course_id, { course_id: r.course_id }); }
          if(!seen.has(r.prereq_course_id)){ seen.add(r.prereq_course_id); courseIdToCourse.set(r.prereq_course_id, { course_id: r.prereq_course_id }); }
        }
        updateAllCourseCodesCache();
        statusEl.textContent = "";
        return;
      }
    }

    // Built-in tiny sample so the UI always shows something when API is down
    const sample = tinySample();
    courseIdToCourse = new Map();
    for(const c of sample.courses){ courseIdToCourse.set(normalizeCode(c.course_id), c); }
    prereqRows = sample.prereqs.slice();
    updateAllCourseCodesCache();
    statusEl.textContent = "";
  }

  // Build reverse index: prereq -> courses that require it (for future tree)
  function buildReverseIndex(){
    const reverse = new Map();
    for(const row of prereqRows){
      const req = normalizeCode(row.prereq_course_id);
      const target = normalizeCode(row.course_id);
      if(!req || !target) continue;
      if(!reverse.has(req)) reverse.set(req, new Set());
      reverse.get(req).add(target);
    }
    return reverse;
  }

  // Layout and render a lightweight tree using plain SVG
  function renderTrees(courseId, prereqIndex, reverseIndex){
    lastPrereqRoot = buildPrereqHierarchy(courseId, prereqIndex);
    renderPrereqTree(prereqContainer, lastPrereqRoot);
    const depth = Math.max(0, Math.min(4, Number(futureDepthSelect.value || 0)));
    lastFutureRoot = buildFutureHierarchy(courseId, reverseIndex, depth);
    renderSideTree(futureContainer, lastFutureRoot, true);
  }

  function buildPrereqHierarchy(courseId, prereqIndex){
    // Recursively expand prerequisites until leaves
    const visited = new Set();
    function dfs(courseInfo){
      const id = (typeof courseInfo === 'string') ? courseInfo : courseInfo.id;
      const min_grade = (typeof courseInfo === 'object') ? courseInfo.min_grade : undefined;

      if(visited.has(id)) return { id, groups: [], min_grade };
      visited.add(id);
      const groupsMap = prereqIndex.get(id) || new Map();
      const groups = Array.from(groupsMap.keys()).sort((a,b)=>a-b).map(k=>{
        const g = groupsMap.get(k);
        const computedType = (g.courses.length > 1) ? 'OR' : 'AND';
        return { group:k, type:computedType, courses:g.courses };
      });
      // New: build children with junction nodes
      const children = [];
      if(groups.length > 1){
        // Multiple AND groups: create an intermediate AND junction
        const andNode = { id: `and-${id}`, children:[] };
      for(const g of groups){
          const orNode = { id: `or-group-${g.group}`, children: g.courses.map(c => dfs(c)), isGroup: true };
          andNode.children.push(orNode);
        }
        children.push(andNode);
      } else if (groups.length === 1) {
        const g = groups[0];
        if (g.courses.length > 1) {
          // Single OR group, needs a junction
          const orNode = { id: `or-group-${g.group}`, children: g.courses.map(c => dfs(c)), isGroup: true };
          children.push(orNode);
        } else {
          // Single course, no group node needed, just the course itself
          children.push(...g.courses.map(c => dfs(c)));
        }
      }
      return { id, groups, children, min_grade };
    }
    return dfs(courseId);
  }

  function navigateToCourse(courseId) {
    prereqDepthSelect.value = '2';
    futureDepthSelect.value = '2';
    prereqZoom = 1;
    futureZoom = 1;
    shouldAutoZoomPrereq = true;
    shouldAutoZoomFuture = true;
    // Reset course path finder to balanced on each new search
    if (prefSelect) {
      prefSelect.value = 'balanced';
      PathFinder.setPreference('balanced');
    }

    const normalizedCourseId = normalizeCode(courseId);
    currentCourseId = normalizedCourseId;
    addToSearchHistory(normalizedCourseId);
    // Clearing previous selection when navigating to a new course
    currentSelection = new Set();

    courseInput.value = '';
    suggestionsEl.classList.remove("visible");
    suggestionsEl.innerHTML = "";

    if (normalizeCode((location.hash || "").replace(/^#/, '')) !== normalizedCourseId) {
        location.hash = normalizedCourseId;
    } else {
        performSearch();
    }
  }

  function transformApiTreeToRenderableTree(apiNode) {
    if (!apiNode) return null;

    const { id, groups, children, min_grade } = apiNode;

    const childrenById = new Map();
    if (children) {
      for (const child of children) {
        childrenById.set(child.id, child);
      }
    }

    const newChildren = [];
    if (groups && groups.length > 1) { // AND logic
      const andNode = { id: `and-${id}`, children: [] };
      for (const g of groups) {
        const groupChildren = g.courses.map(course => {
          const childNode = childrenById.get(course.course_id);
          return transformApiTreeToRenderableTree(childNode);
        }).filter(Boolean);
        const orNode = { id: `or-group-${g.group}-${id}`, children: groupChildren, isGroup: true };
        andNode.children.push(orNode);
      }
      newChildren.push(andNode);
    } else if (groups && groups.length === 1) { // OR logic or single course
      const g = groups[0];
      const groupChildren = g.courses.map(course => {
        const childNode = childrenById.get(course.course_id);
        return transformApiTreeToRenderableTree(childNode);
      }).filter(Boolean);

      if (g.courses.length > 1) {
          const orNode = { id: `or-group-${g.group}-${id}`, children: groupChildren, isGroup: true };
          newChildren.push(orNode);
      } else {
          newChildren.push(...groupChildren);
      }
    }

    // assign a stable unique uid so multiple occurrences of the same course id are distinct
    const uid = (function(){
      if(!window.__NODE_UID__) window.__NODE_UID__ = 1;
      return window.__NODE_UID__++;
    })();
    return { id, uid, children: newChildren, min_grade };
  }

  function buildFutureHierarchy(courseId, reverseIndex, depth){
    const visited = new Set();
    function expand(id, d){
      if(d > depth) return { id };
      if(visited.has(id)) return { id };
      visited.add(id);
      const next = Array.from(reverseIndex.get(id) || []);
      return { id, children: next.map(n=>expand(n, d+1)) };
    }
    return expand(courseId, 1);
  }

  function renderSideTree(container, root, isFuture){
    const existingSvg = container.querySelector('svg');
    if (existingSvg) existingSvg.remove();
    const { svg, g } = makeSVG(container);

    // Left-to-right tidy tree layout (depth → x, siblings stacked along y)
    const NODE_HEIGHT = 26;
    const HORIZONTAL_GAP = 24; // minimal horizontal space between levels
    const siblingGap = 12; // vertical gap between siblings

    // Use node object references as keys to avoid collisions when the same
    // course id appears in multiple branches. Using ids would collapse nodes.
    const positions = new Map();

    // Compute compact widths per course id so boxes only take the space they need
    const widthById = new Map();
    let maxNodeWidth = 0;
    (function collect(n){
      const label = courseIdToCourse.get(n.id)?.course_id || n.id;
      // Estimate text width: base padding + approx 8px per char, clamped
      const est = Math.max(56, Math.min(180, 14 + (label.length * 8)));
      widthById.set(n.id, est);
      if(est > maxNodeWidth) maxNodeWidth = est;
      for(const c of (n.children || [])) collect(c);
    })(root);

    // Determine depth first to compute a level gap that fills available width
    function computeMaxDepth(n){
      const kids = n.children || [];
      if(kids.length === 0) return 0;
      let md = 0;
      for(const c of kids){ md = Math.max(md, 1 + computeMaxDepth(c)); }
      return md;
    }
    const maxDepthForWidth = computeMaxDepth(root);
    const containerWidth = Math.max(300, Math.floor(container.clientWidth || container.getBoundingClientRect().width));
    let levelGap = Math.max(
      HORIZONTAL_GAP,
      Math.floor((containerWidth - maxNodeWidth - 10) / Math.max(1, maxDepthForWidth))
    );
    const estimatedTreeWidth = (maxDepthForWidth * levelGap) + maxNodeWidth;
    if (estimatedTreeWidth < containerWidth * 0.8 && maxDepthForWidth > 0) {
      levelGap = Math.floor((containerWidth * 0.8 - maxNodeWidth - 10) / maxDepthForWidth);
    }

    let maxDepth = 0;
    // Compute layout with DFS stacking along y
    let yCursor = 0;
    function layout(node, depth){
      maxDepth = Math.max(maxDepth, depth);
      const children = node.children || [];
      let top = Infinity, bottom = -Infinity;
      if(children.length){
        for(const c of children){
          const p = layout(c, depth+1);
          top = Math.min(top, p.y);
          bottom = Math.max(bottom, p.y);
        }
      }
      let y;
      if(children.length){
        y = (top + bottom) / 2;
      } else {
        y = yCursor;
        yCursor += NODE_HEIGHT + siblingGap;
      }
      const pos = { x: depth * levelGap, y };
      positions.set(node, pos);
      return pos;
    }

    layout(root, 0);

    // Content width for non-mirrored layout (used as basis for mirroring)
    const nominalContentWidth = (maxDepth + 1) * levelGap + maxNodeWidth + 10;
    const reverse = !isFuture; // reverse only the prerequisites tree
    function getWidth(node){ return widthById.get(node.id) || maxNodeWidth; }
    function nodePos(node){
      const p = positions.get(node);
      if(!reverse) return p;
      const w = getWidth(node);
      return { x: nominalContentWidth - (p.x + w), y: p.y };
    }

    // Compute tight bounds after optional mirroring for proper centering
    let minX = Infinity, maxX = -Infinity;
    const allNodes = new Set();
    const inDegree = new Map();
    (function measure(n){
      allNodes.add(n);
      const p = nodePos(n);
      const w = getWidth(n);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x + w);
      for(const c of (n.children || [])){
        inDegree.set(c, (inDegree.get(c) || 0) + 1);
        measure(c);
      }
    })(root);
    const baseTranslateX = isFinite(minX) ? -minX : 0;
    const contentWidth = isFinite(maxX - minX) ? (maxX - minX) : nominalContentWidth;

    // Draw edges
    const drawnEdges = new Set();
    function drawEdges(node){
      const p = nodePos(node);
      for(const child of (node.children || [])){
        const c = nodePos(child);
        // Avoid drawing duplicate edges for repeated child entries
        const edgeKey = `${node.id}->${child.id}`;
        if(!drawnEdges.has(edgeKey)){
          drawnEdges.add(edgeKey);
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          const startX = reverse ? p.x : (p.x + getWidth(node));
          const startY = p.y + NODE_HEIGHT/2;
          const endX = reverse ? (c.x + getWidth(child)) : c.x;
          const endY = c.y + NODE_HEIGHT/2;
          // Straight connector
          const d = `M ${startX} ${startY} L ${endX} ${endY}`;
          path.setAttribute("d", d);
          path.setAttribute("class", isFuture ? "edge-future" : "edge");
          g.appendChild(path);
        }
        drawEdges(child);
      }
    }

    drawEdges(root);

    // Draw nodes
    function drawNode(node){
      const pos = nodePos(node);
      const w = getWidth(node);

      const nodeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
      nodeGroup.setAttribute("class", "clickable-node");
      nodeGroup.addEventListener('click', (e) => {
        e.preventDefault();
        navigateToCourse(node.id);
      });
      g.appendChild(nodeGroup);

      rect(nodeGroup, pos.x, pos.y, w, NODE_HEIGHT, 8, "node");
      const label = courseIdToCourse.get(node.id)?.course_id || node.id;
      svgText(nodeGroup, pos.x + 8, pos.y + NODE_HEIGHT/2, label, "node-label", "start", "middle");

      for(const child of (node.children || [])) drawNode(child);
    }

    drawNode(root);

    // Resize SVG to content, and center the tree within the container width
    const width = containerWidth;
    const height = Math.max(yCursor, NODE_HEIGHT + 20);
    svg.setAttribute("width", String(width));
    const elementPixelHeightFuture = Math.max(height, (container.clientHeight || Math.floor(window.innerHeight * 0.8)));
    svg.setAttribute("height", String(elementPixelHeightFuture));
    // Base viewBox equals tight content bounds before zoom
    const baseViewBoxWidth = contentWidth;
    const baseViewBoxHeight = height;

    let didAutoZoomFuture = false;
    if (shouldAutoZoomFuture) {
      const clientH = container.clientHeight || Math.floor(window.innerHeight * 0.8);
      // Choose zoom so visible fraction >= 80%; don't zoom in above 1.0
      const target = Math.max(0.2, Math.min(1.0, clientH / (0.8 * baseViewBoxHeight)));
      futureZoom = target;
      shouldAutoZoomFuture = false;
      didAutoZoomFuture = true;
    }

    // If the tree has only one node, avoid magnifying it to container size.
    const isSingleFuture = !root?.children || (root.children.length === 0);
    if (isSingleFuture) {
      const overscaleH = (elementPixelHeightFuture || 1) / Math.max(1, baseViewBoxHeight);
      const overscaleW = (containerWidth || 1) / Math.max(1, baseViewBoxWidth);
      const overscale = Math.max(overscaleH, overscaleW);
      if (overscale > 1) {
        const target = 3.5 / overscale; // scale down so size remains normal
        futureZoom = Math.min(futureZoom, target);
      }
    }

    const viewBoxWidth = baseViewBoxWidth / futureZoom;
    const viewBoxHeight = baseViewBoxHeight / futureZoom;
    const viewBoxX = (baseViewBoxWidth - viewBoxWidth) / 2;
    const viewBoxY = (baseViewBoxHeight - viewBoxHeight) / 2;
    svg.setAttribute("viewBox", `${viewBoxX} ${viewBoxY} ${viewBoxWidth} ${viewBoxHeight}`);
    // Also set inline height so it displays even without a viewBox-aware layout
    svg.style.height = `${elementPixelHeightFuture}px`;

    // Translate to remove left margin and let preserveAspectRatio center the result
    g.setAttribute("transform", `translate(${baseTranslateX},0)`);

    setupMinimap(container, svg, { contentWidth: baseViewBoxWidth, contentHeight: baseViewBoxHeight, zoom: isFuture ? futureZoom : prereqZoom });
    if (didAutoZoomFuture) {
      centerTree(container);
    }
  }

  function renderPrereqTree(container, root){
    const existingSvg = container.querySelector('svg');
    if (existingSvg) existingSvg.remove();
    const { svg, g } = makeSVG(container);
    // Left-to-right tidy tree layout (depth → x, siblings stacked along y)
    const NODE_HEIGHT = 26;
    const HORIZONTAL_GAP = 64; // minimal horizontal space between levels
    const interGroupGap = 64; // vertical gap between sibling groups (more room for AND)
    const intraGroupGap = 16; // vertical gap within a group
    const positions = new Map();
    const widthById = new Map();
    let maxNodeWidth = 0;
    (function collect(n){
      const isRoot = (n === root);
      const isJunction = (n.id || "").startsWith("and-") || (n.id || "").startsWith("or-");
      const label = isJunction ? "" : (courseIdToCourse.get(n.id)?.course_id || n.id);
      const gradeSpace = isRoot ? 0 : 26; // compacted from 30
      const weightSpace = isRoot ? 0 : 22; // tighter to match right-side spacing
      let est = isJunction ? 1 : Math.max(56, Math.min(180, 14 + (label.length * 8) + gradeSpace));
      est += weightSpace;
      widthById.set(n.id, est);
      if(est > maxNodeWidth) maxNodeWidth = est;
      for(const c of (n.children || [])) collect(c);
    })(root);
    function computeMaxDepth(n){
      const kids = n.children || [];
      if(kids.length === 0) return 0;
      let md = 0;
      for(const c of kids){ md = Math.max(md, 1 + computeMaxDepth(c)); }
      return md;
    }
    const maxDepthForWidth = computeMaxDepth(root);
    const containerWidth = Math.max(300, Math.floor(container.clientWidth || container.getBoundingClientRect().width));
    let levelGap = Math.max(
      HORIZONTAL_GAP,
      Math.floor((containerWidth - maxNodeWidth - 10) / Math.max(1, maxDepthForWidth))
    );
    const estimatedTreeWidth = (maxDepthForWidth * levelGap) + maxNodeWidth;
    if (estimatedTreeWidth < containerWidth * 0.8 && maxDepthForWidth > 0) {
      levelGap = Math.floor((containerWidth * 0.8 - maxNodeWidth - 10) / maxDepthForWidth);
    }

    let maxDepth = 0;
    let yCursor = 40;
    function layout(node, depth){
      maxDepth = Math.max(maxDepth, depth);
      const children = node.children || [];
      let top = Infinity, bottom = -Infinity;
      if(children.length){
        for(const c of children){
          const p = layout(c, depth+1);
          top = Math.min(top, p.y);
          bottom = Math.max(bottom, p.y);
        }
      }
      let y;
      if(children.length){
        y = (top + bottom) / 2;
      } else {
        y = yCursor;
        yCursor += NODE_HEIGHT + interGroupGap;
      }
      const pos = { x: depth * levelGap, y };
      positions.set(node, pos);
      return pos;
    }
    layout(root, 0);

    // Post-processing pass to resolve overlaps
    function getSubtreeBounds(node) {
        let minY = Infinity;
        let maxY = -Infinity;
        const subtreeNodes = [];
        (function collect(n) {
            subtreeNodes.push(n);
            (n.children || []).forEach(collect);
        })(node);

        for (const n of subtreeNodes) {
            const p = positions.get(n);
            if (p) {
                minY = Math.min(minY, p.y);
                maxY = Math.max(maxY, p.y + NODE_HEIGHT);
            }
        }
        return { minY, maxY };
    }

    const parentMap = new Map();
    (function buildParentMap(n, p) {
        parentMap.set(n, p);
        (n.children || []).forEach(c => buildParentMap(c, n));
    })(root, null);

    const allNodes = [];
    (function collect(n){ allNodes.push(n); (n.children||[]).forEach(collect); })(root);

    const nodesByDepth = new Map();
    for(const node of allNodes){
        const p = positions.get(node);
        if (!p) continue;
        const depth = Math.round(p.x / levelGap);
        if(!nodesByDepth.has(depth)) nodesByDepth.set(depth, []);
        nodesByDepth.get(depth).push(node);
    }
    
    let iterations = 0;
    while(iterations < 10) { // Max 10 iterations to prevent infinite loops
        let changed = false;
        for(let d = 0; d <= maxDepth; d++) {
            const nodes = nodesByDepth.get(d) || [];
            if (nodes.length < 2) continue;
            nodes.sort((a,b) => (positions.get(a)?.y || 0) - (positions.get(b)?.y || 0));

            for(let i=0; i < nodes.length - 1; i++){
                const n1 = nodes[i];
                const n2 = nodes[i+1];
                
                const p1 = parentMap.get(n1);
                const p2 = parentMap.get(n2);
                const isIntraGroup = p1 && p2 && p1 === p2 && p1.isGroup;
                const gap = isIntraGroup ? intraGroupGap : interGroupGap;

                const bounds1 = getSubtreeBounds(n1);
                const bounds2 = getSubtreeBounds(n2);

                if (!isFinite(bounds1.maxY) || !isFinite(bounds2.minY)) continue;

                const overlap = bounds1.maxY - bounds2.minY;
                if(overlap > -gap){
                    changed = true;
                    const shift = overlap + gap;
                    const subtreeToShift = [];
                    (function collectSubtree(n){ subtreeToShift.push(n); (n.children||[]).forEach(collectSubtree); })(n2);
                    for(const n of subtreeToShift){
                        const p = positions.get(n);
                        if(p) p.y += shift;
                    }
                }
            }
        }
        if (!changed) break;
        iterations++;
    }

    const nominalContentWidth = (maxDepth + 1) * levelGap + maxNodeWidth + 10;
    const reverse = true; // Prereqs are always reversed (right to left)
    function getWidth(node){ return widthById.get(node.id) || maxNodeWidth; }
    function nodePos(node){
      const p = positions.get(node);
      const w = getWidth(node);
      return { x: nominalContentWidth - (p.x + w), y: p.y };
    }
    let minX = Infinity, maxX = -Infinity;
    (function measure(n){
      const p = nodePos(n);
      const w = getWidth(n);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x + w);
      for(const c of (n.children || [])) measure(c);
    })(root);
    const baseTranslateX = isFinite(minX) ? -minX : 0;
    const contentWidth = isFinite(maxX - minX) ? (maxX - minX) : nominalContentWidth;

    const groupNodes = [];
    (function collectGroups(n) {
      if (n.isGroup) groupNodes.push(n);
      for (const c of (n.children || [])) collectGroups(c);
    })(root);

    const groupBounds = new Map();
    let contentMaxY = yCursor;

    for (const node of groupNodes) {
      const children = node.children || [];
      if (children.length > 0) {
        let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
        for (const child of children) {
          const pos = nodePos(child);
          const w = getWidth(child);
          minY = Math.min(minY, pos.y);
          maxY = Math.max(maxY, pos.y + NODE_HEIGHT);
          minX = Math.min(minX, pos.x);
          maxX = Math.max(maxX, pos.x + w);
        }
        if (isFinite(minY)) {
          const padding = 12;
          const rectX = minX - padding;
          const rectY = minY - padding;
          const rectWidth = maxX - minX + padding * 2;
          const rectHeight = maxY - minY + padding * 2;
          rect(g, rectX, rectY, rectWidth, rectHeight, 16, "prereq-group-bg");
          groupBounds.set(node, { minY: rectY, maxY: rectY + rectHeight, midX: rectX + rectWidth/2 });
          contentMaxY = Math.max(contentMaxY, rectY + rectHeight);

          for (let i = 0; i < children.length - 1; i++) {
            const child1 = children[i];
            const child2 = children[i+1];
            const pos1 = nodePos(child1);
            const pos2 = nodePos(child2);
            const labelX = minX + rectWidth/2 - padding;
            const labelY = (pos1.y + NODE_HEIGHT + pos2.y) / 2;
            svgText(g, labelX, labelY, 'or', 'or-label', 'middle');
          }
        }
      }
    }

    const andNodes = [];
    (function collectAnds(n) {
      if ((n.id || "").startsWith("and-")) andNodes.push(n);
      for (const c of (n.children || [])) collectAnds(c);
    })(root);

    for (const node of andNodes) {
        const children = node.children || [];
        for (let i = 0; i < children.length - 1; i++) {
            const group1 = children[i];
            const group2 = children[i+1];
            const bounds1 = groupBounds.get(group1);
            const bounds2 = groupBounds.get(group2);
            if (bounds1 && bounds2) {
                const x = bounds1.midX;
                const y = (bounds1.maxY + bounds2.minY) / 2;
                svgText(g, x, y, 'AND', 'and-label', 'middle');
            }
        }
    }

    const drawnEdges = new Set();
    function drawEdges(node){
      const p = nodePos(node);

      for(const child of (node.children || [])){
        const c = nodePos(child);

        const edgeKey = `${node.id}->${child.id}`;
        if(!drawnEdges.has(edgeKey)){
          drawnEdges.add(edgeKey);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");

          const parentIsJunction = (node.id || "").startsWith("and-") || (node.id || "").startsWith("or-") || node.isGroup;
          const childIsJunction = (child.id || "").startsWith("and-") || (child.id || "").startsWith("or-") || child.isGroup;

          const startX = parentIsJunction ? p.x : (p.x + 6); // don't overlap for junction points
          const startY = p.y + NODE_HEIGHT/2;
          const endX = childIsJunction ? c.x : (c.x + getWidth(child) - 6);
          const endY = c.y + NODE_HEIGHT/2;

      const d = `M ${startX} ${startY} L ${endX} ${endY}`;
      path.setAttribute("d", d);
      const highlight = currentSelection.size && (hasSelectedMap.get(child) || (isCourseNode(child) && currentSelection.has(nodeKey(child))));
      path.setAttribute("class", highlight ? "edge highlight-edge" : "edge");
      g.appendChild(path);
        }
        drawEdges(child);
      }
    }
    hasSelectedMap.clear();
    markHasSelected(root);
    drawEdges(root);
    function drawNode(node){
      const isJunction = (node.id || "").startsWith("and-") || (node.id || "").startsWith("or-");
      const pos = nodePos(node);
      if(isJunction){
        // Do not render junction nodes, they are for layout only
      } else {
        const nodeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
        nodeGroup.setAttribute("class", "clickable-node");
        nodeGroup.addEventListener('click', (e) => {
          e.preventDefault();
          navigateToCourse(node.id);
        });
        g.appendChild(nodeGroup);

        const w = getWidth(node);
        const chip = rect(nodeGroup, pos.x, pos.y, w, NODE_HEIGHT, 8, "node");
        const label = courseIdToCourse.get(node.id)?.course_id || node.id;

        // Weight badge on the left (non-root)
        const isRoot = (node === root);
        let labelStartX = pos.x + 8;
        if(!isRoot){
          try{
            const wValue = PathFinder.getCourseWeight(node.id, courseIdToCourse);
            const colorFor = (v)=>{ if(v < 50) return '#AF3434'; if(v < 80) return '#E1863C'; return '#4D7235'; };
            const BADGE_W = 20; // compact and bring closer to label
            const by = pos.y + (NODE_HEIGHT - 16) / 2;
            const bx = pos.x + 4;
            rect(nodeGroup, bx, by, BADGE_W, 16, 6, 'grade-badge');
            const wt = svgText(nodeGroup, bx + BADGE_W/2, by + 8, String(Math.round(wValue)), 'weight-text', 'middle', 'middle');
            wt.setAttribute('fill', colorFor(wValue));
            labelStartX = pos.x + 8 + BADGE_W + 3; // tighten gap to match grade side
          }catch(_){ /* ignore */ }
        }

        const t = svgText(nodeGroup, labelStartX, pos.y + NODE_HEIGHT/2, label, "node-label", "start", "middle");
 
        if(currentSelection.size){
          const selected = currentSelection.has(nodeKey(node));
          if(selected){ chip.setAttribute('class','node highlight-node'); }
        }

        const hasGrade = node.min_grade !== undefined && node.min_grade !== null;
 
        if (hasGrade || !isRoot) {
          const GRADE_BADGE_W = 22; // compact to match left
          const bx = pos.x + w - GRADE_BADGE_W - 4;
          const by = pos.y + (NODE_HEIGHT - 16) / 2;
          rect(nodeGroup, bx, by, GRADE_BADGE_W, 16, 6, "grade-badge");
          if(hasGrade){
            svgText(nodeGroup, bx + GRADE_BADGE_W/2, by + 8, String(node.min_grade), "grade-text", "middle", "middle");
          }
        }
      }
      for(const child of (node.children || [])) drawNode(child);
    }
    drawNode(root);
    const width = containerWidth;
    const height = contentMaxY + 20;
    const padding = 24;
    svg.setAttribute("width", String(width));
    const elementPixelHeightPrereq = Math.max(height, (container.clientHeight || Math.floor(window.innerHeight * 0.8)));
    svg.setAttribute("height", String(elementPixelHeightPrereq));

    const baseViewBoxWidth = contentWidth + padding * 2;
    const baseViewBoxHeight = height;
    let didAutoZoomPrereq = false;
    if (shouldAutoZoomPrereq) {
      const clientH = container.clientHeight || Math.floor(window.innerHeight * 0.8);
      const target = Math.max(0.2, Math.min(1.0, clientH / (0.8 * baseViewBoxHeight)));
      prereqZoom = target;
      shouldAutoZoomPrereq = false;
      didAutoZoomPrereq = true;
    }

    // If the prereq tree is a single node, avoid magnifying it.
    const isSinglePrereq = !root?.children || (root.children.length === 0);
    if (isSinglePrereq) {
      const overscaleH = (elementPixelHeightPrereq || 1) / Math.max(1, baseViewBoxHeight);
      const overscaleW = (containerWidth || 1) / Math.max(1, baseViewBoxWidth);
      const overscale = Math.max(overscaleH, overscaleW);
      if (overscale > 1) {
        const target = 3.5 / overscale;
        const clamped = Math.max(0.8, target); // keep chip readable
        prereqZoom = Math.min(prereqZoom, clamped);
      }
    }
    const zoom = prereqZoom;
    const viewBoxWidth = baseViewBoxWidth / zoom;
    const viewBoxHeight = baseViewBoxHeight / zoom;
    const viewBoxX = (baseViewBoxWidth - viewBoxWidth) / 2;
    const viewBoxY = (baseViewBoxHeight - viewBoxHeight) / 2;

    svg.setAttribute("viewBox", `${viewBoxX} ${viewBoxY} ${viewBoxWidth} ${viewBoxHeight}`);
    svg.style.height = `${elementPixelHeightPrereq}px`;
    g.setAttribute("transform", `translate(${baseTranslateX + padding},0)`);

    setupMinimap(container, svg, { contentWidth: baseViewBoxWidth, contentHeight: baseViewBoxHeight });
    if (didAutoZoomPrereq) {
      centerTree(container);
    }
  }

  function makeSVG(container){
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svg.appendChild(g);
    container.appendChild(svg);
    // Make sure intrinsic sizing works across browsers
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    return { svg, g };
  }

  function setupMinimap(scrollableContainer, mainSvg, contentDims) {
      let minimapContainer;
      if (scrollableContainer.id === 'prereq-tree') {
          minimapContainer = prereqMinimapContainer;
      } else if (scrollableContainer.id === 'future-tree') {
          minimapContainer = futureMinimapContainer;
      } else {
          return;
      }
      if (!minimapContainer) return;

      const { contentWidth, contentHeight } = contentDims;
      const isScrollable = scrollableContainer.scrollHeight > scrollableContainer.clientHeight || scrollableContainer.scrollWidth > scrollableContainer.clientWidth;

      if (!isScrollable) {
          minimapContainer.classList.remove('visible');
          return;
      }

      minimapContainer.classList.add('visible');
      minimapContainer.innerHTML = '';
      const minimapSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const minimapG = mainSvg.querySelector('g').cloneNode(true);
      minimapSvg.appendChild(minimapG);
      minimapContainer.appendChild(minimapSvg);

      minimapSvg.addEventListener('click', (e) => {
          e.preventDefault();
          const minimapWidth = minimapContainer.clientWidth;
          const scale = minimapWidth / contentWidth;
          
          const targetSvgX = e.offsetX / scale;
          const targetSvgY = e.offsetY / scale;

          const mainViewBox = mainSvg.getAttribute('viewBox').split(' ').map(Number);
          const [vx, vy, vw, vh] = mainViewBox;

          const mainClientRect = mainSvg.getBoundingClientRect();
          if (mainClientRect.width === 0 || mainClientRect.height === 0) return;

          const scaleX = vw / mainClientRect.width;
          const scaleY = vh / mainClientRect.height;

          const clientWidth = scrollableContainer.clientWidth;
          const clientHeight = scrollableContainer.clientHeight;

          let newScrollLeft = ((targetSvgX - vx) / scaleX) - (clientWidth / 2);
          let newScrollTop = ((targetSvgY - vy) / scaleY) - (clientHeight / 2);

          scrollableContainer.scroll({
              left: newScrollLeft,
              top: newScrollTop,
              behavior: 'smooth'
          });
      });

      const minimapWidth = minimapContainer.clientWidth;
      const scale = minimapWidth / contentWidth;
      const minimapHeight = contentHeight * scale;

      minimapSvg.setAttribute('viewBox', `0 0 ${contentWidth} ${contentHeight}`);
      minimapSvg.setAttribute('width', minimapWidth);
      minimapSvg.setAttribute('height', minimapHeight);

      const viewportRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      viewportRect.setAttribute('class', 'minimap-viewport');
      minimapSvg.appendChild(viewportRect);

      function updateViewport() {
          const mainViewBox = mainSvg.getAttribute('viewBox').split(' ').map(Number);
          const [vx, vy, vw, vh] = mainViewBox;

          const mainClientRect = mainSvg.getBoundingClientRect();
          if (mainClientRect.width === 0 || mainClientRect.height === 0) return;

          const scaleX = vw / mainClientRect.width;
          const scaleY = vh / mainClientRect.height;

          const { scrollLeft, scrollTop, clientWidth, clientHeight } = scrollableContainer;

          const rectX = vx + scrollLeft * scaleX;
          const rectY = vy + scrollTop * scaleY;
          const rectW = clientWidth * scaleX;
          const rectH = clientHeight * scaleY;

          viewportRect.setAttribute('x', rectX);
          viewportRect.setAttribute('y', rectY);
          viewportRect.setAttribute('width', rectW);
          viewportRect.setAttribute('height', rectH);
      }

      scrollableContainer.addEventListener('scroll', updateViewport);
      const observer = new MutationObserver(() => updateViewport());
      observer.observe(mainSvg, { attributes: true, attributeFilter: ['viewBox'] });
      updateViewport();
  }

  function rect(g, x, y, w, h, r, className){
    const el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    el.setAttribute("x", String(x));
    el.setAttribute("y", String(y));
    el.setAttribute("width", String(w));
    el.setAttribute("height", String(h));
    el.setAttribute("rx", String(r));
    el.setAttribute("class", className);
    g.appendChild(el);
    return el;
  }

  function svgText(g, x, y, text, className, textAnchor, dominantBaseline){
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", String(x));
    t.setAttribute("y", String(y));
    if(className) t.setAttribute("class", className);
    if(textAnchor) t.setAttribute("text-anchor", textAnchor);
    if(dominantBaseline) t.setAttribute("dominant-baseline", dominantBaseline);
    t.textContent = text;
    g.appendChild(t);
    return t;
  }

  function svgCircle(g, cx, cy, r, className){
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", String(cx));
    c.setAttribute("cy", String(cy));
    c.setAttribute("r", String(r));
    if(className) c.setAttribute("class", className);
    g.appendChild(c);
    return c;
  }

  // Suggestion logic: show only after a digit is typed (e.g., cs1)
  function shouldSuggest(q){
    // Start suggesting after at least 3 chars or once a digit appears
    return q.length >= 3 || /\d/.test(q);
  }

  function getAllKnownCodes(){
    return allCourseCodesCache.length ? allCourseCodesCache : [];
  }

  function renderSuggestions(query){
    const q = (query || "").trim().toUpperCase();
    if(!q || !shouldSuggest(q)){
      suggestionsEl.classList.remove("visible");
      suggestionsEl.innerHTML = "";
      suggestionIndex = -1;
      return;
    }
    // Debounced backend suggestions
    const apiBase = window.API_BASE || "http://localhost:8000";
    if(suggestTimer){ clearTimeout(suggestTimer); }
    suggestTimer = setTimeout(()=>{
      if(suggestAbort){ suggestAbort.abort(); }
      suggestAbort = new AbortController();
      const signal = suggestAbort.signal;
      fetch(`${apiBase}/api/courses/suggest?q=${encodeURIComponent(q)}&limit=40`, { signal })
        .then(res => res.ok ? res.json() : Promise.reject())
        .then(data => {
          if(signal.aborted) return;
          const items = (data.items || []).map(it => ({ code: String(it.course_id).toUpperCase(), title: it.course_name || "" }));
          renderSuggestionItems(rankFuzzy(items, q));
        })
        .catch(()=>{ /* DB-only mode: no local fallback */ });
    }, 120);
  }

  function renderLocalSuggestions(_q){ /* disabled */ }

  function renderSuggestionItems(items){
    if(!items || items.length === 0){ suggestionsEl.classList.remove("visible"); suggestionsEl.innerHTML = ""; suggestionIndex = -1; return; }
    const seen = new Set();
    const deduped = [];
    for(const it of items){ if(!seen.has(it.code)){ seen.add(it.code); deduped.push(it); } }
    const top = deduped.slice(0, 20);
    suggestionsEl.innerHTML = top.map((it, idx)=>
      `<div class="item${idx===suggestionIndex?" active":""}" role="option" data-code="${it.code}">`+
      `<span class="code">${it.code}</span>`+
      `<span class="title">${it.title}</span>`+
      `</div>`
    ).join("");
    suggestionsEl.classList.add("visible");
    suggestionIndex = 0;
  }

  // Simple fuzzy utilities
  function fuzzyMatch(text, q){
    // returns match score position or -1; sequential subsequence match
    text = (text || '').toUpperCase();
    q = (q || '').toUpperCase();
    let ti = 0, qi = 0, score = 0, last = -1;
    while(ti < text.length && qi < q.length){
      if(text[ti] === q[qi]){ score += last === ti-1 ? 2 : 1; last = ti; qi++; }
      ti++;
    }
    return qi === q.length ? score : -1;
  }

  function rankFuzzy(items, q){
    const scored = items.map(it => ({
      it,
      s: Math.max(
        fuzzyMatch(it.code, q),
        fuzzyMatch(it.title || '', q)
      )
    })).filter(x => x.s >= 0);
    scored.sort((a,b)=> b.s - a.s || a.it.code.localeCompare(b.it.code));
    return scored.map(x => x.it);
  }

  function pickSuggestion(code){
    if(!code) return;
    navigateToCourse(code);
  }

  async function performSearch(){
    const query = normalizeCode(currentCourseId || "");
    if(!query){
      statusEl.textContent = "";
      prereqContainer.innerHTML = "";
      futureContainer.innerHTML = "";
      prereqMinimapContainer.classList.remove('visible');
      futureMinimapContainer.classList.remove('visible');
      lastPrereqRoot = null;
      lastFutureRoot = null;
      return;
    }

    // Try API first
    const apiBase = window.API_BASE || "http://localhost:8000";
    try{
      // Clear previous drawings while loading
      prereqContainer.innerHTML = "";
      futureContainer.innerHTML = "";
      lastPrereqRoot = null; lastFutureRoot = null;
      statusEl.textContent = "Loading...";

      const prereqDepth = prereqDepthSelect.value;
      const futureDepth = futureDepthSelect.value;
      
      const url = `${apiBase}/api/course/${encodeURIComponent(query)}/tree?prereq_depth=${prereqDepth}&future_depth=${futureDepth}`;
      const res = await fetch(url);
      if(!res.ok){
        const body = await res.text().catch(()=>"");
        console.error("API error", res.status, res.statusText, body);
        statusEl.textContent = `API error ${res.status} ${res.statusText} for ${query}`;
        return;
      }
      let data = null;
      try { data = await res.json(); } catch(err) { data = null; console.error("Parse JSON failed:", err); }
      if(data && data.prereq_tree){
        const course = data.course || { course_id: query };
        courseIdToCourse.set(normalizeCode(course.course_id), course);
        // Merge metrics from backend
        const metricsMap = data.course_metrics || {};
        for(const [cid, m] of Object.entries(metricsMap)){
          const id = normalizeCode(cid);
          const existing = courseIdToCourse.get(id) || { course_id: id };
          existing.liked = m && typeof m.liked === 'number' ? m.liked : existing.liked;
          existing.easy = m && typeof m.easy === 'number' ? m.easy : existing.easy;
          existing.useful = m && typeof m.useful === 'number' ? m.useful : existing.useful;
          existing.ratings = m && typeof m.rating_num === 'number' ? m.rating_num : existing.ratings;
          courseIdToCourse.set(id, existing);
        }
        metricsMedian = data.metrics_median || metricsMedian;
        metricsMin = data.metrics_min || metricsMin;
        lastPrereqRoot = transformApiTreeToRenderableTree(data.prereq_tree);
        lastFutureRoot = data.future_tree || { id: query, children: [] };
        updateAllCourseCodesCache();
        // Compute selection for current preference
        PathFinder.updateMetrics({ median: metricsMedian, min: metricsMin });
        PathFinder.setPreference((prefSelect && prefSelect.value) || 'balanced');
        computeSelection();
        renderPrereqTree(prereqContainer, lastPrereqRoot);
        renderSideTree(futureContainer, lastFutureRoot, true);
        statusEl.textContent = "";
        return;
      }
    }catch(e){
      console.error("Fetch failed:", e);
      /* fall back */ }

    // API unavailable or not found: try local in-memory data (only if API not available)
    if(!apiAvailable && prereqRows.length){
      const prereqIndex = buildIndexes();
      const reverseIndex = buildReverseIndex();
      // Seed course map with the query if missing
      if(!courseIdToCourse.has(query)){
        courseIdToCourse.set(query, { course_id: query });
      }
      renderTrees(query, prereqIndex, reverseIndex);
      statusEl.textContent = "";
      return;
    }

    // No local data either → show message
    prereqContainer.innerHTML = "";
    futureContainer.innerHTML = "";
    statusEl.textContent = `Course not found or API unavailable for: ${query}`;
  }

  searchBtn.addEventListener("click", () => navigateToCourse(courseInput.value));
  courseInput.addEventListener("keydown", e=>{
    if(e.key === "Enter"){
      e.preventDefault();
      if(suggestionsEl.classList.contains("visible") && suggestionIndex >= 0){
        const el = suggestionsEl.querySelectorAll('.item')[suggestionIndex];
        if(el) pickSuggestion(el.getAttribute('data-code'));
      } else {
        navigateToCourse(courseInput.value);
      }
    } else if(e.key === "ArrowDown" || e.key === "ArrowUp"){
      const items = suggestionsEl.querySelectorAll('.item');
      if(items.length){
        e.preventDefault();
        if(e.key === "ArrowDown") suggestionIndex = (suggestionIndex + 1) % items.length;
        else suggestionIndex = (suggestionIndex - 1 + items.length) % items.length;
        renderSuggestions(courseInput.value);
      }
    } else if(e.key === "Escape"){
      suggestionsEl.classList.remove("visible");
      suggestionIndex = -1;
    }
  });
  courseInput.addEventListener("input", ()=>{
    suggestionIndex = -1;
    renderSuggestions(courseInput.value);
  });
  suggestionsEl.addEventListener("mousedown", (e)=>{
    // Use mousedown so selection works before input loses focus
    const target = e.target.closest('.item');
    if(target){ pickSuggestion(target.getAttribute('data-code')); }
  });
  futureDepthSelect.addEventListener("change", () => {
    if (currentCourseId) {
      shouldAutoZoomFuture = true;
      performSearch();
    }
  });

  prereqDepthSelect.addEventListener('change', () => {
    if (currentCourseId) {
      shouldAutoZoomPrereq = true;
      performSearch();
    }
  });

  // Reflow on window resize to consume available width
  window.addEventListener("resize", ()=>{
    if(lastPrereqRoot){ renderPrereqTree(prereqContainer, lastPrereqRoot); }
    if(lastFutureRoot){ renderSideTree(futureContainer, lastFutureRoot, true); }
  });

  if(prefSelect){
    prefSelect.addEventListener('change', ()=>{
      PathFinder.setPreference(prefSelect.value);
      computeSelection();
      // Keep current viewport; no auto-zoom or centering on preference change
      shouldAutoZoomPrereq = false;
      if(lastPrereqRoot){ renderPrereqTree(prereqContainer, lastPrereqRoot); }
    });
  }

  if(clearSelectionBtn){
    clearSelectionBtn.addEventListener('click', ()=>{
      currentSelection = new Set();
      if (prefSelect) {
        try {
          // Clear visible value
          prefSelect.selectedIndex = -1;
          // Ensure no option is marked selected in the native menu
          const opts = prefSelect.options || [];
          for(let i=0;i<opts.length;i++) opts[i].selected = false;
          prefSelect.value = '';
        } catch(_) {}
      }
      // Keep current viewport; no auto-zoom or centering on Clear
      shouldAutoZoomPrereq = false;
      shouldAutoZoomFuture = false;
      if(lastPrereqRoot){ renderPrereqTree(prereqContainer, lastPrereqRoot); }
    });
  }

  function centerTree(container) {
    const scrollWidth = container.scrollWidth;
    const scrollHeight = container.scrollHeight;
    const clientWidth = container.clientWidth;
    const clientHeight = container.clientHeight;
    container.scrollLeft = (scrollWidth - clientWidth) / 2;
    container.scrollTop = (scrollHeight - clientHeight) / 2;
  }

  prereqZoomInBtn.addEventListener('click', () => {
    prereqZoom += 0.2;
    if(lastPrereqRoot) {
      renderPrereqTree(prereqContainer, lastPrereqRoot);
      centerTree(prereqContainer);
    }
  });
  prereqZoomOutBtn.addEventListener('click', () => {
    prereqZoom = Math.max(0.2, prereqZoom - 0.2);
    if(lastPrereqRoot) {
      renderPrereqTree(prereqContainer, lastPrereqRoot);
      centerTree(prereqContainer);
    }
  });
  prereqZoomResetBtn.addEventListener('click', () => {
    shouldAutoZoomPrereq = true;
    if(lastPrereqRoot) {
      renderPrereqTree(prereqContainer, lastPrereqRoot);
    }
  });

  futureZoomInBtn.addEventListener('click', () => {
    futureZoom += 0.2;
    if(lastFutureRoot) {
      renderSideTree(futureContainer, lastFutureRoot, true);
      centerTree(futureContainer);
    }
  });
  futureZoomOutBtn.addEventListener('click', () => {
    futureZoom = Math.max(0.2, futureZoom - 0.2);
    if(lastFutureRoot) {
      renderSideTree(futureContainer, lastFutureRoot, true);
      centerTree(futureContainer);
    }
  });
  futureZoomResetBtn.addEventListener('click', () => {
    shouldAutoZoomFuture = true;
    if(lastFutureRoot) {
      renderSideTree(futureContainer, lastFutureRoot, true);
    }
  });

  window.addEventListener('hashchange', () => {
    const hash = normalizeCode((location.hash || "").replace(/^#/, ""));
    currentCourseId = hash;
    performSearch();
  });

  // Init
  loadData().then(()=>{
    // prefill from hash if present
    const hash = (location.hash || "").replace(/^#/, "").trim();
    // Ensure default preference is balanced on first load
    if (prefSelect) {
      prefSelect.value = 'balanced';
      PathFinder.setPreference('balanced');
    }
    if(hash){
      currentCourseId = normalizeCode(hash);
      performSearch();
    }
    loadSearchHistory();
  });
})();


