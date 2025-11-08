#!/usr/bin/env python3
"""
Export Neon database to static JSON files for frontend consumption.
This script exports all course data and prerequisites into optimized JSON files.
"""

import os
import json
import psycopg
from dotenv import load_dotenv
from collections import defaultdict
from datetime import datetime

# Load environment variables
load_dotenv()


def get_db_connection():
    """Get database connection using environment variables."""
    dsn = (
        os.getenv("NEON_URL")
        or os.getenv("NETLIFY_DATABASE_URL")
        or os.getenv("DATABASE_URL")
    )
    if not dsn:
        raise RuntimeError(
            "Set NEON_URL/NETLIFY_DATABASE_URL/DATABASE_URL to your Postgres connection string"
        )
    return psycopg.connect(dsn)


def export_courses(cursor):
    """Export all courses with their metadata and ratings."""
    print("📚 Exporting courses...")
    cursor.execute("""
        SELECT 
            course_id, 
            COALESCE(course_name, '') AS course_name,
            COALESCE(department, '') AS department,
            course_level,
            COALESCE(description, '') AS description,
            liked,
            easy,
            useful,
            rating_num
        FROM course
        ORDER BY course_id
    """)
    
    courses = {}
    for row in cursor.fetchall():
        courses[row[0]] = {
            "course_id": row[0],
            "course_name": row[1],
            "department": row[2],
            "course_level": row[3],
            "description": row[4],
            "liked": None if row[5] is None else float(row[5]),
            "easy": None if row[6] is None else float(row[6]),
            "useful": None if row[7] is None else float(row[7]),
            "rating_num": None if row[8] is None else int(row[8]),
        }
    
    print(f"   ✓ Exported {len(courses)} courses")
    return courses


def export_prereqs(cursor):
    """Export all prerequisite relationships grouped by course."""
    print("🔗 Exporting prerequisites...")
    cursor.execute("""
        SELECT 
            course_id,
            prereq_course_id,
            prerequisite_group,
            min_grade
        FROM course_prereq
        ORDER BY course_id, prerequisite_group, prereq_course_id
    """)
    
    # Group by course_id -> groups -> courses
    prereqs_by_course = defaultdict(lambda: defaultdict(list))
    
    for row in cursor.fetchall():
        course_id = row[0]
        prereq_id = row[1]
        group = int(row[2])
        min_grade = None if row[3] is None else int(row[3])
        
        prereqs_by_course[course_id][group].append({
            "course_id": prereq_id,
            "min_grade": min_grade
        })
    
    # Convert to final structure matching API format
    result = {}
    total_relationships = 0
    
    for course_id, groups in prereqs_by_course.items():
        result[course_id] = []
        for group_num in sorted(groups.keys()):
            courses = groups[group_num]
            group_type = "OR" if len(courses) > 1 else "AND"
            result[course_id].append({
                "group": group_num,
                "type": group_type,
                "courses": courses
            })
            total_relationships += len(courses)
    
    print(f"   ✓ Exported {total_relationships} prerequisite relationships across {len(result)} courses")
    return result


def export_offerings(cursor):
    """Export course offering history (terms)."""
    print("📅 Exporting course offerings...")
    cursor.execute("""
        SELECT course_id, term
        FROM offering
        ORDER BY course_id, term DESC
    """)
    
    offerings = defaultdict(list)
    for row in cursor.fetchall():
        offerings[row[0]].append({"term": row[1]})
    
    print(f"   ✓ Exported offerings for {len(offerings)} courses")
    return dict(offerings)


def calculate_metrics(cursor):
    """Calculate global median and min metrics for weighting algorithm."""
    print("📊 Calculating global metrics...")
    cursor.execute("""
        SELECT 
            COALESCE((SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY liked) 
                      FROM course WHERE liked IS NOT NULL), 0.0) AS liked_med,
            COALESCE((SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY easy) 
                      FROM course WHERE easy IS NOT NULL), 0.0) AS easy_med,
            COALESCE((SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY useful) 
                      FROM course WHERE useful IS NOT NULL), 0.0) AS useful_med,
            COALESCE((SELECT MIN(liked) FROM course WHERE liked IS NOT NULL), 0.0) AS liked_min,
            COALESCE((SELECT MIN(easy) FROM course WHERE easy IS NOT NULL), 0.0) AS easy_min,
            COALESCE((SELECT MIN(useful) FROM course WHERE useful IS NOT NULL), 0.0) AS useful_min
    """)
    
    row = cursor.fetchone()
    
    metrics = {
        "median": {
            "liked": float(row[0]),
            "easy": float(row[1]),
            "useful": float(row[2])
        },
        "min": {
            "liked": float(row[3]),
            "easy": float(row[4]),
            "useful": float(row[5])
        }
    }
    
    print(f"   ✓ Median: liked={metrics['median']['liked']:.1f}, easy={metrics['median']['easy']:.1f}, useful={metrics['median']['useful']:.1f}")
    return metrics


def export_all():
    """Main export function."""
    print("\n" + "="*60)
    print("🚀 Starting Database Export to Static JSON")
    print("="*60 + "\n")
    
    start_time = datetime.now()
    
    # Create data directory if it doesn't exist
    os.makedirs("data", exist_ok=True)
    
    with get_db_connection() as conn:
        with conn.cursor() as cur:
            # Export all data
            courses = export_courses(cur)
            prereqs = export_prereqs(cur)
            # Skip offerings - table doesn't exist in current schema
            # offerings = export_offerings(cur)
            metrics = calculate_metrics(cur)
    
    # Prepare final export structure
    export_data = {
        "version": "1.0",
        "exported_at": datetime.now().isoformat(),
        "courses": courses,
        "prereqs": prereqs,
        "metrics": metrics
    }
    
    # Write to JSON file
    output_file = "data/courses_data.json"
    print(f"\n💾 Writing to {output_file}...")
    
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(export_data, f, indent=2, ensure_ascii=False)
    
    # Calculate file size
    file_size = os.path.getsize(output_file)
    file_size_mb = file_size / (1024 * 1024)
    
    elapsed = (datetime.now() - start_time).total_seconds()
    
    print("\n" + "="*60)
    print("✅ Export Complete!")
    print("="*60)
    print(f"📦 Output file: {output_file}")
    print(f"📏 File size: {file_size_mb:.2f} MB ({file_size:,} bytes)")
    print(f"⏱️  Time taken: {elapsed:.2f} seconds")
    print(f"📊 Summary:")
    print(f"   - {len(courses)} courses")
    print(f"   - {len(prereqs)} courses with prerequisites")
    print("="*60 + "\n")
    
    return export_data


if __name__ == "__main__":
    try:
        export_all()
        print("🎉 Ready to deploy! Your static data is in data/courses_data.json")
    except Exception as e:
        print(f"\n❌ Error during export: {e}")
        import traceback
        traceback.print_exc()
        exit(1)

