# UW Course Explorer

Interactive UW Prereq Explorer: visualize UW course prerequisite and future-course trees, with search and ratings-weighted path recommendations. This tool helps University of Waterloo students plan their academic path by providing a clear, visual representation of complex course dependencies and suggesting optimal prerequisite pathways based on their personal preferences.

## Website

https://uwtree.site/

## Architecture

**🚀 Fully Static Site** - No backend required!

```mermaid
%%{init: {'flowchart': {'nodeSpacing': 80, 'rankSpacing': 120}, 'themeVariables': {'fontSize': '20px'}}}%%
flowchart TB
  U[User types target course] --> F[Frontend app.js]
  F -->|Loads once| D[Static JSON Data<br/>data/courses_data.json]
  D --> F
  F --> T[Build AND/OR prereq tree]
  T --> LP[Solve LP to pick optimal subtree]
  LP --> R[Render trees + highlight chosen path]
```

**Benefits:**
- ⚡ **10-100x faster** - No database queries or API calls
- ❄️ **Zero cold starts** - Instant response times
- 🌍 **Global CDN** - Fast worldwide with Netlify
- 💰 **$0 hosting costs** - No backend infrastructure needed
- 📱 **Works offline** - After initial load

### Data Flow

1. **One-time load**: 3.5 MB JSON file (compresses to ~500 KB with Brotli)
2. **Browser caches**: All subsequent visits are instant
3. **Local processing**: All tree building happens in your browser

## Optimal Course Path Selection

For any given target course, its prerequisites can form a tree of requirements with AND/OR logic (we processed it with our own parser to convert natural language into a logical format, and this takes LONG time!). Then, the primary challenge is to navigate this structure to find an "optimal" course path for a student. This project frames the challenge as an **optimal directed subtree selection problem**. The goal is to select a subtree, rooted at the target course, that satisfies all logical requirements while maximizing a total "weight" score (how we find it is in the next section) derived from user preferences and historical course data from UWFlow.

### Methodology: Heuristic-Guided Greedy Traversal

We model the structure as a rooted **Directed Acyclic Graph (DAG)** with course nodes and junction nodes (AND/OR). The optimal prerequisite path is found using a greedy recursive traversal that makes locally optimal choices.

-   At **OR-nodes**, it selects the child branch with the lowest total cost (i.e., the highest-rated and most efficient path).
-   At **AND-nodes**, all child branches must be satisfied. A simple sequential traversal can lead to suboptimal choices due to its arbitrary processing order. To mitigate this, we use a heuristic:
    1.  First, the algorithm performs a "dry run" to calculate the standalone cost of satisfying each child branch.
    2.  It then sorts the branches from most expensive to least expensive.
    3.  Finally, it traverses the branches in this sorted order, accumulating selected courses. This allows cheaper branches to benefit from course reuse opportunities created by the more complex branches.

While the theoretical optimum can be described by a linear program, this heuristic-guided greedy approach provides a fast and effective solution that finds more efficient and intuitive course paths.

#### LP/MILP Formulation (Theoretical Model)

Let $V_c$ be course nodes and $V_j$ be junction nodes (AND/OR). Define binary decision variables for all nodes $x_v \in \{0,1\}$ indicating whether node $v$ is chosen in the prerequisite subtree. The target course $r$ is forced to be selected: $x_r = 1$.

Objective (minimize total cost of selected courses):

$$\min \sum_{v \in V_c} c_v\, x_v$$

where $c_v = 1 - \frac{w_v}{100} + p_v$ combines preference-based weight $w_v$ and an optional depth-aware penalty $p_v$ to encourage course reuse. Globally,

$$ p_v(d) = \frac{\lambda_0}{1 + d} $$

applies only the first time course $v$ is included at depth $d$ ($d=0$ at the root). $\lambda_0 \in [0, 1]$ is a tunable base (default $0.5$ in code).

Constraints encode AND/OR logic:

- AND node $u$ with children $C(u)$: for all $v \in C(u)$, $x_v \ge x_u$. If an AND is selected, all children must be selected.
- OR node $u$ with children $C(u)$: $\sum_{v \in C(u)} x_v \ge x_u$. If an OR is selected, at least one child must be selected.
- Junction-to-course propagation: if a course node has a parent junction $p$, enforce $x_{course} \ge x_p$ when that edge exists.

This MILP returns a binary selection over nodes that satisfies all logic and minimizes total cost. The frontend then highlights the selected course nodes as the recommended path.

#### AND/OR Graph Example

```mermaid
graph LR
  R[Target Course] --> A((AND))
  A --> G1((OR Group 1))
  A --> G2((OR Group 2))
  G1 --> C1[Course A]
  G1 --> C2[Course B]
  G2 --> D1[Course C]
  G2 --> D2[Course D]
```

Selecting `R` requires selecting `A`. For the two OR groups under `A`, at least one child is chosen from each group to satisfy the AND.

### Course Path Finder: The Weighting Algorithm

To make the path "optimal," each course is assigned a weight based on historical student feedback and the user's selected preference.

**1. Input Metrics:** For each course, we use:
-   `liked` score (0-100)
-   `easy` score (0-100)
-   `useful` score (0-100)
-   Number of ratings

**2. User Preference:** The user selects a preference (e.g., "Focus on likeness," "Balanced"), which translates to a weight vector $\beta = (\beta_1, \beta_2, \beta_3)$. For example, "Focus on likeness" might use $\beta = (0.7, 0.15, 0.15)$.

**3. Reliability Scaling:** To account for rating confidence, a scaling factor $\lambda_i$ is applied. Courses with more ratings (e.g., > 100) receive a slight boost ($\lambda_i = 1.1$), while those with few ratings (e.g., < 50) are slightly penalized ($\lambda_i = 0.9$).

**4. Final Node Weight Calculation:** The final weight $y_i$ for a course is a weighted average of its scores, adjusted for reliability:

$$ y_i = \lambda_i \cdot (\beta_1 x_{\text{liked}} + \beta_2 x_{\text{easy}} + \beta_3 x_{\text{useful}}) $$

### Global Optimization: Promoting Course Reuse

A naive algorithm might select high-weight courses that lead to an inefficient path with many total courses. To solve this, the model introduces a **depth-aware new-course penalty**.

-   The "cost" of adding a course to the path is $1 - \frac{y_v}{100}$.
-   If a course is selected for the *first time*, an additional penalty is added. This penalty decreases with the prerequisite's depth, encouraging the reuse of courses that appear in multiple branches (like reusing MATH 138 for both a STAT and a MATH prerequisite).

The algorithm's objective is to find a valid path $P$ that minimizes the total cost, balancing course quality (high weight) with path efficiency (course reuse).

---

## Development

### Local Development

```bash
# 1. Start local server
python3 -m http.server 8080

# 2. Open browser
open http://localhost:8080
```

The site uses vanilla JavaScript - no build tools required!

### Project Structure

```
uw_app/
├── index.html          # Main HTML page
├── app.js              # Frontend logic & tree rendering
├── pathfinder.js       # Optimal path selection algorithm
├── styles.css          # Styling
├── data/
│   └── courses_data.json  # Static course data (3.5 MB)
├── scripts/
│   ├── export_db_to_static.py  # Export database to JSON
│   └── update_data.sh          # Automated update workflow
├── scraper/
│   ├── uwflow_scraper.py      # Scrape course data from UWFlow
│   ├── calendar_verifier.py   # Parse prerequisites from UW Calendar
│   └── llm_parser.py           # LLM-based prerequisite parsing
├── backend/            # (Archived - no longer used)
│   └── server.py       # Old FastAPI backend
└── sql/
    └── tables.sql      # Database schema
```

### Data Pipeline

The course data flows through these stages:

1. **Scraping** → `scraper/uwflow_scraper.py` + `calendar_verifier.py`
   - Fetches course info from UWFlow
   - Parses prerequisites from UW Course Calendar
   - Uses LLM to parse complex prerequisite text
   
2. **Storage** → Neon Postgres Database
   - Stores courses, prerequisites, ratings
   
3. **Export** → `scripts/export_db_to_static.py`
   - Exports database to `data/courses_data.json`
   
4. **Deploy** → Git push → Netlify auto-deploys

---

## Updating Course Data

When you want to update the course data (e.g., after scraping new data):

### Quick Update

```bash
./scripts/update_data.sh
```

This script will:
1. Export latest data from Neon database
2. Commit the changes
3. Ask if you want to push (triggers deployment)

### Manual Update

```bash
# 1. Export data from database
source venv/bin/activate
python3 scripts/export_db_to_static.py

# 2. Commit and push
git add data/courses_data.json
git commit -m "Update course data"
git push
```

Netlify will automatically deploy the changes (~1-2 minutes).

---

## Deployment

### Production

The site is deployed on **Netlify** with automatic deployments:

- **URL**: https://uwtree.site/
- **Hosting**: Netlify (free tier)
- **CDN**: Global edge network
- **Auto-deploy**: Triggered by git push to main branch

### Environment Variables

For running scrapers and export scripts locally:

Create a `.env` file:
```bash
NEON_URL=postgresql://user:password@host/database
```

---

## Data Sources

- **Course Ratings**: [UWFlow](https://uwflow.com)
- **Prerequisites**: UW Course Calendar
- **Database**: Neon Postgres (cloud-hosted)

---

## Tech Stack

**Frontend (Production):**
- Vanilla JavaScript (no frameworks!)
- SVG for tree visualization
- CSS3 for styling

**Data Pipeline:**
- Python 3.13
- psycopg (PostgreSQL driver)
- Neon Postgres Database
- OpenAI/Perplexity LLM for prerequisite parsing

**Deployment:**
- Netlify (static hosting + CDN)
- Git-based deployment

---

## Performance

**Load Times:**
- First visit: ~150-300ms (includes 500 KB data download)
- Subsequent visits: ~50-100ms (cached)
- Tree rendering: <100ms for most courses

**Data Size:**
- Raw JSON: 3.5 MB
- Compressed (Brotli): ~500 KB
- 9,360+ courses
- 3,174 courses with prerequisites

---

## License & Credits

**Design and Implementation:** [Steven Shi](https://github.com/StevenShi998)

**Data Source:** All course data scraped from [UWFlow](https://uwflow.com)
