(function(){
  "use strict";

  // Data loaded from static JSON file (exported from database)
  
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
  const donationBtn = document.getElementById("donation-btn");
  const donationModal = document.getElementById("donation-modal");
  const modalCloseBtn = document.getElementById("modal-close-btn");
  const brandBtn = document.getElementById("brand");

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
  let staticDataLoaded = false;
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

  // Static data loaded from JSON file - no backend needed!

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

  function clearAll(){
    // Reset state and UI (but preserve loaded static data for suggestions)
    currentCourseId = null;
    lastPrereqRoot = null;
    lastFutureRoot = null;
    currentSelection = new Set();
    // Don't clear courseIdToCourse and prereqRows - they're needed for suggestions!
    // courseIdToCourse = new Map();
    // prereqRows = [];
    statusEl.textContent = "";
    prereqContainer.innerHTML = "";
    futureContainer.innerHTML = "";
    prereqMinimapContainer.classList.remove('visible');
    futureMinimapContainer.classList.remove('visible');
    // Clear input and hash
    if(courseInput) courseInput.value = '';
    if(location.hash) history.replaceState(null, '', location.pathname + location.search);
    // Clear suggestions and history
    suggestionsEl.classList.remove("visible");
    suggestionsEl.innerHTML = "";
    searchHistory = [];
    try{ localStorage.removeItem('uw_search_history'); }catch(_){ }
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


  async function loadData(){
    // Load static JSON data file (exported from database)
    statusEl.textContent = "Loading course data...";
    try {
      const response = await fetch('./data/courses_data.json');
      if (!response.ok) {
        throw new Error(`Failed to load data: ${response.status}`);
      }
      
      const data = await response.json();
      
      // Load courses into Map
      courseIdToCourse = new Map();
      for (const [courseId, courseData] of Object.entries(data.courses)) {
        courseIdToCourse.set(courseId, courseData);
      }
      
      // Load prerequisites into flat array (for compatibility with existing code)
      prereqRows = [];
      for (const [courseId, groups] of Object.entries(data.prereqs)) {
        for (const group of groups) {
          for (const prereqCourse of group.courses) {
            prereqRows.push({
              course_id: courseId,
              prereq_course_id: prereqCourse.course_id,
              prerequisite_group: group.group,
              min_grade: prereqCourse.min_grade
            });
          }
        }
      }
      
      // Load global metrics for weighting
      if (data.metrics) {
        metricsMedian = data.metrics.median || metricsMedian;
        metricsMin = data.metrics.min || metricsMin;
      }
      
      updateAllCourseCodesCache();
      staticDataLoaded = true;
      statusEl.textContent = "";
      
      console.log(`✅ Loaded ${courseIdToCourse.size} courses and ${prereqRows.length} prerequisite relationships`);
      
    } catch (error) {
      console.error('Error loading static data:', error);
      statusEl.textContent = `Error loading course data: ${error.message}. Please refresh the page.`;
    }
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
    const prereqDepth = Math.max(1, Math.min(100, Number(prereqDepthSelect.value || 99)));
    lastPrereqRoot = buildPrereqHierarchy(courseId, prereqIndex, prereqDepth);
    renderPrereqTree(prereqContainer, lastPrereqRoot);
    const depth = Math.max(0, Math.min(4, Number(futureDepthSelect.value || 0)));
    lastFutureRoot = buildFutureHierarchy(courseId, reverseIndex, depth);
    renderSideTree(futureContainer, lastFutureRoot, true);
  }

  function buildPrereqHierarchy(courseId, prereqIndex, maxDepth){
    // Recursively expand prerequisites until leaves or max depth
    // Match backend logic exactly: start at depth=0, use depth >= maxDepth
    const visited = new Set();
    function dfs(courseInfo, depth){
      const id = (typeof courseInfo === 'string') ? courseInfo : courseInfo.id;
      const min_grade = (typeof courseInfo === 'object') ? courseInfo.min_grade : undefined;

      // Stop expanding if we've hit the depth limit or already visited
      // Backend uses: if depth >= max_depth: return {"id": course_id, "groups": [], "min_grade": min_grade}
      if(depth >= maxDepth || visited.has(id)) return { id, groups: [], min_grade };
      visited.add(id);
      
      const groupsMap = prereqIndex.get(id) || new Map();
      const groups = Array.from(groupsMap.keys()).sort((a,b)=>a-b).map(k=>{
        const g = groupsMap.get(k);
        const computedType = (g.courses.length > 1) ? 'OR' : 'AND';
        return { group:k, type:computedType, courses:g.courses };
      });
      // Build children with junction nodes
      const children = [];
      if(groups.length > 1){
        // Multiple AND groups: create an intermediate AND junction
        const andNode = { id: `and-${id}`, children:[] };
      for(const g of groups){
          const orNode = { id: `or-group-${g.group}`, children: g.courses.map(c => dfs(c, depth+1)), isGroup: true };
          andNode.children.push(orNode);
        }
        children.push(andNode);
      } else if (groups.length === 1) {
        const g = groups[0];
        if (g.courses.length > 1) {
          // Single OR group, needs a junction
          const orNode = { id: `or-group-${g.group}`, children: g.courses.map(c => dfs(c, depth+1)), isGroup: true };
          children.push(orNode);
        } else {
          // Single course, no group node needed, just the course itself
          children.push(...g.courses.map(c => dfs(c, depth+1)));
        }
      }
      return { id, groups, children, min_grade };
    }
    return dfs(courseId, 0);
  }

  function prunePrereqTree(node, maxDepth){
    // Post-process tree to remove empty groups at maxDepth boundary
    // This matches backend behavior where nodes at depth >= maxDepth have empty groups
    function prune(n, depth){
      if(!n) return;
      if(depth >= maxDepth){
        // At maxDepth boundary, ensure groups and children are empty (backend behavior)
        if(Array.isArray(n.groups)) n.groups = [];
        if(Array.isArray(n.children)) n.children.length = 0;
        return;
      }
      if(Array.isArray(n.children)){
        for(let i = n.children.length - 1; i >= 0; i--){
          const child = n.children[i];
          prune(child, depth + 1);
          const hasDescendants = child && Array.isArray(child.children) && child.children.length > 0;
          const hasGroups = child && Array.isArray(child.groups) && child.groups.length > 0;
          if(child && child.isGroup && !hasDescendants && !hasGroups){
            n.children.splice(i, 1);
          }
        }
      }
    }
    prune(node, 0);
  }

  function navigateToCourse(courseId) {
    prereqDepthSelect.value = '1';
    futureDepthSelect.value = '1';
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

  function centerTree(container) {
    const scrollWidth = container.scrollWidth;
    const scrollHeight = container.scrollHeight;
    const clientWidth = container.clientWidth;
    const clientHeight = container.clientHeight;
    container.scrollLeft = (scrollWidth - clientWidth) / 2;
    container.scrollTop = (scrollHeight - clientHeight) / 2;
  }

  // Zoom helpers for user controls
  function setPrereqZoom(z){
    const minZ = 0.2, maxZ = 1.0; // cap so tree width never exceeds canvas width
    prereqZoom = Math.max(minZ, Math.min(maxZ, z));
    shouldAutoZoomPrereq = false;
    if(lastPrereqRoot){ renderPrereqTree(prereqContainer, lastPrereqRoot); }
  }

  function setFutureZoom(z){
    const minZ = 0.2, maxZ = 1.0; // cap zoom-in to avoid overflow
    futureZoom = Math.max(minZ, Math.min(maxZ, z));
    shouldAutoZoomFuture = false;
    if(lastFutureRoot){ renderSideTree(futureContainer, lastFutureRoot, true); }
  }

  function renderSideTree(container, root, isFuture){
    // Preserve viewport center point for better zoom behavior
    const { scrollLeft, scrollTop, scrollWidth, clientWidth, scrollHeight, clientHeight } = container;
    const viewportCenterX = scrollLeft + clientWidth / 2;
    const viewportCenterY = scrollTop + clientHeight / 2;
    const contentCenterX = scrollWidth / 2;
    const contentCenterY = scrollHeight / 2;
    const offsetX = viewportCenterX - contentCenterX;
    const offsetY = viewportCenterY - contentCenterY;

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

    // Draw edges (batched)
    const drawnEdges = new Set();
    const edgeFrag = document.createDocumentFragment();
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
          edgeFrag.appendChild(path);
        }
        drawEdges(child);
      }
    }

    drawEdges(root);
    g.appendChild(edgeFrag);

    // Draw nodes (batched)
    const nodeFrag = document.createDocumentFragment();
    function drawNode(node){
      const pos = nodePos(node);
      const w = getWidth(node);

      const nodeGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
      nodeGroup.setAttribute("class", "clickable-node");
      nodeGroup.addEventListener('click', (e) => {
        e.preventDefault();
        navigateToCourse(node.id);
      });
      nodeFrag.appendChild(nodeGroup);

      rect(nodeGroup, pos.x, pos.y, w, NODE_HEIGHT, 8, "node");
      const label = courseIdToCourse.get(node.id)?.course_id || node.id;
      svgText(nodeGroup, pos.x + 8, pos.y + NODE_HEIGHT/2, label, "node-label", "start", "middle");

      for(const child of (node.children || [])) drawNode(child);
    }

    drawNode(root);
    g.appendChild(nodeFrag);

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

    const zoom = futureZoom;
    // Zoom by shrinking the viewBox so content appears larger while
    // keeping intrinsic SVG size managed by earlier width/height attrs
    const viewBoxWidthF = baseViewBoxWidth / zoom;
    const viewBoxHeightF = baseViewBoxHeight / zoom;
    const viewBoxXF = (baseViewBoxWidth - viewBoxWidthF) / 2;
    const viewBoxYF = (baseViewBoxHeight - viewBoxHeightF) / 2;
    svg.setAttribute("viewBox", `${viewBoxXF} ${viewBoxYF} ${viewBoxWidthF} ${viewBoxHeightF}`);
    svg.style.width = "";
    svg.style.height = "";

    // Translate to remove left margin and let preserveAspectRatio center the result
    g.setAttribute("transform", `translate(${baseTranslateX},0)`);

    setupMinimap(container, svg, { contentWidth: baseViewBoxWidth, contentHeight: baseViewBoxHeight, zoom: isFuture ? futureZoom : prereqZoom });
    
    // Defer scroll restoration to allow browser to update layout
    requestAnimationFrame(()=>{
      if (didAutoZoomFuture) {
        centerTree(container);
      } else {
        // Preserve viewport center point relative to content center
        const newContentCenterX = container.scrollWidth / 2;
        const newContentCenterY = container.scrollHeight / 2;
        container.scrollLeft = Math.max(0, newContentCenterX + offsetX - container.clientWidth / 2);
        container.scrollTop = Math.max(0, newContentCenterY + offsetY - container.clientHeight / 2);
      }
    });
  }

  function renderPrereqTree(container, root){
    // Preserve viewport center point for better zoom behavior
    const { scrollLeft, scrollTop, scrollWidth, clientWidth, scrollHeight, clientHeight } = container;
    const viewportCenterX = scrollLeft + clientWidth / 2;
    const viewportCenterY = scrollTop + clientHeight / 2;
    const contentCenterX = scrollWidth / 2;
    const contentCenterY = scrollHeight / 2;
    const offsetX = viewportCenterX - contentCenterX;
    const offsetY = viewportCenterY - contentCenterY;

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
    while(iterations < 5) { // Limit iterations to keep tasks short
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
    const edgesFrag = document.createDocumentFragment();
    
    // Store convergence points for OR groups
    const orGroupConvergencePoints = new Map();
    
    function drawEdges(node){
      const p = nodePos(node);

      for(const child of (node.children || [])){
        // Skip OR groups - they're handled by drawORGroupEdges and drawConvergenceToParent
        if(child.isGroup && child.children && child.children.length > 0){
          continue; // Don't draw edge to OR group, and don't recurse (handled separately)
        }
        
        const c = nodePos(child);

        const edgeKey = `${node.id}->${child.id}`;
        if(!drawnEdges.has(edgeKey)){
          drawnEdges.add(edgeKey);
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");

          const parentIsJunction = (node.id || "").startsWith("and-") || (node.id || "").startsWith("or-") || node.isGroup;
          const childIsJunction = (child.id || "").startsWith("and-") || (child.id || "").startsWith("or-") || child.isGroup;

          const startX = parentIsJunction ? p.x : (p.x + 6);
          const startY = p.y + NODE_HEIGHT/2;
          const endX = childIsJunction ? c.x : (c.x + getWidth(child) - 6);
          const endY = c.y + NODE_HEIGHT/2;

          const d = `M ${startX} ${startY} L ${endX} ${endY}`;
          path.setAttribute("d", d);
          const highlight = currentSelection.size && (hasSelectedMap.get(child) || (isCourseNode(child) && currentSelection.has(nodeKey(child))));
          path.setAttribute("class", highlight ? "edge highlight-edge" : "edge");
          edgesFrag.appendChild(path);
        }
        drawEdges(child);
      }
    }
    
    // First pass: draw edges from OR group children to convergence points
    function drawORGroupEdges(node){
      if(node.isGroup && node.children && node.children.length > 0){
        const bounds = groupBounds.get(node);
        if(bounds){
          // Calculate convergence point on the right edge of the OR group
          let orGroupMinX = Infinity;
          let orGroupMinY = Infinity;
          let orGroupMaxY = -Infinity;
          for(const grandchild of node.children){
            const gc = nodePos(grandchild);
            orGroupMinX = Math.min(orGroupMinX, gc.x);
            orGroupMinY = Math.min(orGroupMinY, gc.y);
            orGroupMaxY = Math.max(orGroupMaxY, gc.y + NODE_HEIGHT);
          }
          const padding = 12;
          const orGroupRightEdge = orGroupMinX - padding;
          // Convergence Y is at the vertical center of the OR group
          const convergenceY = (orGroupMinY + orGroupMaxY) / 2;
          
          // Find parent of this OR group
          const parent = parentMap.get(node);
          if(parent){
            const parentPos = nodePos(parent);
            const parentIsJunction = (parent.id || "").startsWith("and-") || (parent.id || "").startsWith("or-") || parent.isGroup;
            const parentStartX = parentIsJunction ? parentPos.x : (parentPos.x + 6);
            
            // Convergence X is halfway between OR group right edge and parent left edge
            const convergenceX = (orGroupRightEdge + parentStartX) / 2;
            
            orGroupConvergencePoints.set(node, { x: convergenceX, y: convergenceY });
            
            // Draw edges from each child to convergence point
            for(const grandchild of node.children){
              const gc = nodePos(grandchild);
              const grandchildIsJunction = (grandchild.id || "").startsWith("and-") || (grandchild.id || "").startsWith("or-") || grandchild.isGroup;
              const grandchildEndX = grandchildIsJunction ? gc.x : (gc.x + getWidth(grandchild) - 6);
              const grandchildEndY = gc.y + NODE_HEIGHT/2;
              
              const edgeKey = `${grandchild.id}->converge-${node.id}`;
              if(!drawnEdges.has(edgeKey)){
                drawnEdges.add(edgeKey);
                const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
                const d = `M ${grandchildEndX} ${grandchildEndY} L ${convergenceX} ${convergenceY}`;
                path.setAttribute("d", d);
                const highlight = currentSelection.size && (hasSelectedMap.get(grandchild) || (isCourseNode(grandchild) && currentSelection.has(nodeKey(grandchild))));
                path.setAttribute("class", highlight ? "edge highlight-edge" : "edge");
                edgesFrag.appendChild(path);
              }
            }
          }
        }
      }
      for(const child of (node.children || [])){
        drawORGroupEdges(child);
      }
    }
    
    // Second pass: draw edges from convergence points to parents, and handle AND convergence
    function drawConvergenceToParent(node){
      if(node.isGroup && node.children && node.children.length > 0){
        const convergencePoint = orGroupConvergencePoints.get(node);
        if(convergencePoint){
          const parent = parentMap.get(node);
          if(parent){
            const parentPos = nodePos(parent);
            const parentIsJunction = (parent.id || "").startsWith("and-") || (parent.id || "").startsWith("or-") || parent.isGroup;
            const parentStartX = parentIsJunction ? parentPos.x : (parentPos.x + 6);
            const parentStartY = parentPos.y + NODE_HEIGHT/2;
            
            // Check if parent is AND node with multiple OR group children
            const isAndNode = (parent.id || "").startsWith("and-");
            const orGroupSiblings = (parent.children || []).filter(c => c.isGroup && c.children && c.children.length > 0);
            
            if(isAndNode && orGroupSiblings.length > 1){
              // Calculate intermediate convergence point for AND
              // The intermediate point is at the rightmost convergence X (closest to parent)
              // and at the vertical center of all OR group convergence Y values
              let rightmostConvergenceX = Infinity;
              let minConvergenceY = Infinity;
              let maxConvergenceY = -Infinity;
              for(const orSibling of orGroupSiblings){
                const convPt = orGroupConvergencePoints.get(orSibling);
                if(convPt){
                  rightmostConvergenceX = Math.min(rightmostConvergenceX, convPt.x);
                  minConvergenceY = Math.min(minConvergenceY, convPt.y);
                  maxConvergenceY = Math.max(maxConvergenceY, convPt.y);
                }
              }
              // Intermediate X is at the rightmost (closest to parent) convergence point
              const intermediateX = rightmostConvergenceX;
              // Intermediate Y is at the vertical center of all OR group convergence points
              const intermediateY = (minConvergenceY + maxConvergenceY) / 2;
              
              // Draw from this OR group's convergence to intermediate point
              const edgeKey = `converge-${node.id}->intermediate-${parent.id}`;
              if(!drawnEdges.has(edgeKey)){
                drawnEdges.add(edgeKey);
                const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
                const d = `M ${convergencePoint.x} ${convergencePoint.y} L ${intermediateX} ${intermediateY}`;
                path.setAttribute("d", d);
                const highlight = currentSelection.size && node.children.some(gc => hasSelectedMap.get(gc) || (isCourseNode(gc) && currentSelection.has(nodeKey(gc))));
                path.setAttribute("class", highlight ? "edge highlight-edge" : "edge");
                edgesFrag.appendChild(path);
              }
              
              // Draw from intermediate to parent (only once)
              const intermediateToParentKey = `intermediate-${parent.id}->${parent.id}`;
              if(!drawnEdges.has(intermediateToParentKey)){
                drawnEdges.add(intermediateToParentKey);
                const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
                const d = `M ${intermediateX} ${intermediateY} L ${parentStartX} ${parentStartY}`;
                path.setAttribute("d", d);
                const highlight = currentSelection.size && orGroupSiblings.some(og => og.children.some(gc => hasSelectedMap.get(gc) || (isCourseNode(gc) && currentSelection.has(nodeKey(gc)))));
                path.setAttribute("class", highlight ? "edge highlight-edge" : "edge");
                edgesFrag.appendChild(path);
              }
            } else {
              // Direct connection from convergence point to parent
              const edgeKey = `converge-${node.id}->${parent.id}`;
              if(!drawnEdges.has(edgeKey)){
                drawnEdges.add(edgeKey);
                const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
                const d = `M ${convergencePoint.x} ${convergencePoint.y} L ${parentStartX} ${parentStartY}`;
                path.setAttribute("d", d);
                const highlight = currentSelection.size && node.children.some(gc => hasSelectedMap.get(gc) || (isCourseNode(gc) && currentSelection.has(nodeKey(gc))));
                path.setAttribute("class", highlight ? "edge highlight-edge" : "edge");
                edgesFrag.appendChild(path);
              }
            }
          }
        }
      }
      for(const child of (node.children || [])){
        drawConvergenceToParent(child);
      }
    }
    
    hasSelectedMap.clear();
    markHasSelected(root);
    
    // Draw OR group edges first
    drawORGroupEdges(root);
    
    // Draw convergence to parent edges
    drawConvergenceToParent(root);
    
    // Draw remaining normal edges (non-OR-group connections)
    // Note: drawEdges skips OR groups since they're handled above
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
        nodesFrag.appendChild(nodeGroup);

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
    const nodesFrag = document.createDocumentFragment();
    drawNode(root);
    g.appendChild(edgesFrag);
    g.appendChild(nodesFrag);
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
    const viewBoxWidthP = baseViewBoxWidth / zoom;
    const viewBoxHeightP = baseViewBoxHeight / zoom;
    const viewBoxXP = (baseViewBoxWidth - viewBoxWidthP) / 2;
    const viewBoxYP = (baseViewBoxHeight - viewBoxHeightP) / 2;
    svg.setAttribute("viewBox", `${viewBoxXP} ${viewBoxYP} ${viewBoxWidthP} ${viewBoxHeightP}`);
    svg.style.width = "";
    svg.style.height = "";
    g.setAttribute("transform", `translate(${baseTranslateX + padding},0)`);

    setupMinimap(container, svg, { contentWidth: baseViewBoxWidth, contentHeight: baseViewBoxHeight });
    
    // Defer scroll restoration to allow browser to update layout
    requestAnimationFrame(()=>{
        if (didAutoZoomPrereq) {
          centerTree(container);
        } else {
          // Preserve viewport center point relative to content center
          // Calculate offsets AFTER new content is rendered
          const newContentCenterX = container.scrollWidth / 2;
          const newContentCenterY = container.scrollHeight / 2;
          // Use the stored offsets from BEFORE the render to maintain relative position
          // But clamp to valid scroll ranges
          const targetScrollLeft = Math.max(0, Math.min(container.scrollWidth - container.clientWidth, newContentCenterX + offsetX - container.clientWidth / 2));
          const targetScrollTop = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, newContentCenterY + offsetY - container.clientHeight / 2));
          container.scrollLeft = targetScrollLeft;
          container.scrollTop = targetScrollTop;
        }
    });
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

      // Throttle scroll-driven updates via rAF and use passive listener
      let __minimapRaf = 0;
      function scheduleViewportUpdate(){
          if(__minimapRaf) return;
          __minimapRaf = requestAnimationFrame(()=>{ __minimapRaf = 0; updateViewport(); });
      }

      scrollableContainer.addEventListener('scroll', scheduleViewportUpdate, { passive: true });
      const observer = new MutationObserver(() => scheduleViewportUpdate());
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
    // Start suggesting from the second letter (at least 2 characters)
    return q.length >= 2;
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
    
    // Use static data for suggestions
    if(!staticDataLoaded){
      return; // Wait for data to load
    }
    
    // Debounce for better performance
    if(suggestTimer){ clearTimeout(suggestTimer); }
    suggestTimer = setTimeout(()=>{
      // Build suggestion list from static data
      const items = [];
      for(const [courseId, course] of courseIdToCourse.entries()){
        const code = courseId.toUpperCase();
        const name = (course.course_name || "").toUpperCase();
        
        // Match on code or name
        if(code.includes(q) || name.includes(q)){
          items.push({ 
            code: courseId, 
            title: course.course_name || "" 
          });
        }
      }
      
      // Rank and limit results after collecting all matches
      const ranked = rankFuzzy(items, q);
      renderSuggestionItems(ranked);
    }, 80);
  }

  function renderSuggestionItems(items){
    if(!items || items.length === 0){ suggestionsEl.classList.remove("visible"); suggestionsEl.innerHTML = ""; suggestionIndex = -1; return; }
    const seen = new Set();
    const deduped = [];
    for(const it of items){ if(!seen.has(it.code)){ seen.add(it.code); deduped.push(it); } }
    const top = deduped.slice(0, 20);
    // Preserve current index if still valid; otherwise default to first
    if(suggestionIndex < 0 || suggestionIndex >= top.length) suggestionIndex = 0;
    suggestionsEl.innerHTML = top.map((it, idx)=>
      `<div class="item${idx===suggestionIndex?" active":""}" role="option" data-code="${it.code}">`+
      `<span class="code">${it.code}</span>`+
      `<span class="title">${it.title}</span>`+
      `</div>`
    ).join("");
    suggestionsEl.classList.add("visible");
    // Ensure only one active item between keyboard and mouse interactions
    const itemsEls = suggestionsEl.querySelectorAll('.item');
    itemsEls.forEach((el, idx)=>{
      el.addEventListener('mouseenter', ()=>{
        suggestionIndex = idx;
        itemsEls.forEach(x=>x.classList.remove('active'));
        el.classList.add('active');
      });
    });
  }

  // Simple fuzzy utilities
  function fuzzyMatch(text, q){
    // returns match score position or -1; sequential subsequence match
    text = (text || '').toUpperCase();
    q = (q || '').toUpperCase();
    
    // Prioritize exact prefix matches
    if(text.startsWith(q)){
      return 1000 + q.length; // High score for prefix matches
    }
    
    // Then prioritize matches at word boundaries (e.g., "CS" in "CS246")
    if(text.includes(q)){
      // Check if match is at a word boundary (start of string or after non-letter)
      const index = text.indexOf(q);
      if(index === 0 || !/[A-Z]/.test(text[index - 1])){
        return 500 + q.length; // Medium-high score for word boundary matches
      }
      return 100 + q.length; // Lower score for matches in middle of words
    }
    
    // Sequential subsequence match
    let ti = 0, qi = 0, score = 0, last = -1;
    while(ti < text.length && qi < q.length){
      if(text[ti] === q[qi]){ score += last === ti-1 ? 2 : 1; last = ti; qi++; }
      ti++;
    }
    return qi === q.length ? score : -1;
  }

  function rankFuzzy(items, q){
    const scored = items.map(it => {
      const codeScore = fuzzyMatch(it.code, q);
      const titleScore = fuzzyMatch(it.title || '', q);
      // Prioritize code matches over title matches by giving code matches 10x weight
      const s = codeScore >= 0 ? (codeScore * 10) : (titleScore >= 0 ? titleScore : -1);
      return { it, s };
    }).filter(x => x.s >= 0);
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

    // Ensure data is loaded
    if(!staticDataLoaded){
      statusEl.textContent = "Loading data, please wait...";
      await loadData();
    }

    // Clear previous drawings while loading
    prereqContainer.innerHTML = "";
    futureContainer.innerHTML = "";
    lastPrereqRoot = null; 
    lastFutureRoot = null;
    statusEl.textContent = "Building tree...";

    // Check if course exists in our data
    if(!courseIdToCourse.has(query)){
      statusEl.textContent = `Course not found: ${query}`;
      return;
    }

    // Build trees from static data
    const prereqIndex = buildIndexes();
    const reverseIndex = buildReverseIndex();
    
    // Update PathFinder with our static metrics
    PathFinder.updateMetrics({ median: metricsMedian, min: metricsMin });
    PathFinder.setPreference((prefSelect && prefSelect.value) || 'balanced');
    
    // Render the trees
    renderTrees(query, prereqIndex, reverseIndex);
    
    // Compute optimal path selection
    computeSelection();
    
    // Re-render with selection highlighted
    if(lastPrereqRoot){ 
      renderPrereqTree(prereqContainer, lastPrereqRoot); 
    }
    
    statusEl.textContent = "";
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
      shouldAutoZoomFuture = false; // Don't auto-center when user changes depth
      performSearch();
    }
  });

  if(prereqDepthSelect){
    prereqDepthSelect.addEventListener('change', () => {
      if (currentCourseId) {
        shouldAutoZoomPrereq = false; // Don't auto-center when user changes depth
        performSearch();
      }
    });
  }

  // Reflow on window resize to consume available width
  window.addEventListener("resize", ()=>{
    if(lastPrereqRoot){ renderPrereqTree(prereqContainer, lastPrereqRoot); }
    if(lastFutureRoot){ renderSideTree(futureContainer, lastFutureRoot, true); }
  });

  // Bind zoom buttons
  if(prereqZoomInBtn){ prereqZoomInBtn.addEventListener('click', ()=> setPrereqZoom(prereqZoom * 1.2)); }
  if(prereqZoomOutBtn){ prereqZoomOutBtn.addEventListener('click', ()=> setPrereqZoom(prereqZoom / 1.2)); }
  //set reset to default
  if(prereqZoomResetBtn){ prereqZoomResetBtn.addEventListener('click', ()=> {
    shouldAutoZoomPrereq = true;
    if(lastPrereqRoot) renderPrereqTree(prereqContainer, lastPrereqRoot);
  }); }
  if(futureZoomInBtn){ futureZoomInBtn.addEventListener('click', ()=> setFutureZoom(futureZoom * 1.2)); }
  if(futureZoomOutBtn){ futureZoomOutBtn.addEventListener('click', ()=> setFutureZoom(futureZoom / 1.2)); }
  if(futureZoomResetBtn){ futureZoomResetBtn.addEventListener('click', ()=> {
    shouldAutoZoomFuture = true;
    if(lastFutureRoot) renderSideTree(futureContainer, lastFutureRoot, true);
  }); }

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

  if (donationBtn && donationModal && modalCloseBtn) {
    donationBtn.addEventListener('click', () => {
      donationModal.style.display = 'flex';
    });

    modalCloseBtn.addEventListener('click', () => {
      donationModal.style.display = 'none';
    });

    donationModal.addEventListener('click', (e) => {
      if (e.target === donationModal) {
        donationModal.style.display = 'none';
      }
    });
  }

  if(brandBtn){
    brandBtn.style.cursor = 'pointer';
    brandBtn.setAttribute('title', 'Reset page');
    brandBtn.addEventListener('click', (e)=>{
      e.preventDefault();
      clearAll();
    });
  }

  window.addEventListener('hashchange', () => {
    const hash = normalizeCode((location.hash || "").replace(/^#/, ""));
    currentCourseId = hash;
    performSearch();
  });

  // Init - load static data and start app
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


