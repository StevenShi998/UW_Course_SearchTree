import os
from typing import List, Tuple, Iterable

import mysql.connector
import psycopg
from psycopg import sql


def get_mysql_connection():
    host = os.getenv("DB_HOST", "127.0.0.1")
    port = int(os.getenv("DB_PORT", "3306"))
    user = os.getenv("DB_USER")
    password = os.getenv("DB_PASSWORD")
    database = os.getenv("DB_NAME")
    if not all([user, database]):
        raise RuntimeError("Missing MySQL env vars: DB_USER/DB_PASSWORD/DB_NAME")
    return mysql.connector.connect(
        host=host,
        port=port,
        user=user,
        password=password,
        database=database,
    )


def get_pg_connection():
    dsn = (
        os.getenv("NEON_URL")
        or os.getenv("NETLIFY_DATABASE_URL")
        or os.getenv("DATABASE_URL")
    )
    if not dsn:
        raise RuntimeError(
            "Set NEON_URL (or NETLIFY_DATABASE_URL/DATABASE_URL) to your Neon connection string"
        )
    return psycopg.connect(dsn, autocommit=False)


def fetch_all_mysql(cursor, query: str) -> List[Tuple]:
    cursor.execute(query)
    return list(cursor.fetchall())


def chunked(iterable: Iterable[Tuple], size: int = 1000) -> Iterable[List[Tuple]]:
    buf: List[Tuple] = []
    for item in iterable:
        buf.append(item)
        if len(buf) >= size:
            yield buf
            buf = []
    if buf:
        yield buf


def migrate_course(cur_mysql, pg_conn):
    print("Migrating table: course ...")
    rows = fetch_all_mysql(
        cur_mysql,
        (
            "SELECT course_id, course_name, department, course_level, description, "
            "liked, easy, useful, rating_num FROM course"
        ),
    )

    with pg_conn.cursor() as cur_pg:
        cur_pg.execute("TRUNCATE TABLE course RESTART IDENTITY CASCADE;")
        query = (
            "INSERT INTO course ("
            "  course_id, course_name, department, course_level, description,"
            "  liked, easy, useful, rating_num"
            ") VALUES ("
            "  %s, %s, %s, %s, %s, %s, %s, %s, %s"
            ") ON CONFLICT (course_id) DO UPDATE SET "
            "  course_name = EXCLUDED.course_name,"
            "  department = EXCLUDED.department,"
            "  course_level = EXCLUDED.course_level,"
            "  description = EXCLUDED.description,"
            "  liked = EXCLUDED.liked,"
            "  easy = EXCLUDED.easy,"
            "  useful = EXCLUDED.useful,"
            "  rating_num = EXCLUDED.rating_num"
        )
        for chunk in chunked(rows, size=1000):
            cur_pg.executemany(query, chunk)
    print(f"  Inserted/updated {len(rows)} rows into course")


def migrate_course_prereq(cur_mysql, pg_conn):
    print("Migrating table: course_prereq ...")
    rows = fetch_all_mysql(
        cur_mysql,
        (
            "SELECT course_id, prereq_course_id, prerequisite_group, min_grade "
            "FROM course_prereq"
        ),
    )

    with pg_conn.cursor() as cur_pg:
        cur_pg.execute("TRUNCATE TABLE course_prereq;")
        query = (
            "INSERT INTO course_prereq ("
            "  course_id, prereq_course_id, prerequisite_group, min_grade"
            ") VALUES ("
            "  %s, %s, %s, %s"
            ") ON CONFLICT (course_id, prereq_course_id, prerequisite_group) DO UPDATE SET "
            "  min_grade = EXCLUDED.min_grade"
        )
        for chunk in chunked(rows, size=2000):
            cur_pg.executemany(query, chunk)
    print(f"  Inserted/updated {len(rows)} rows into course_prereq")


def main():
    mysql_conn = get_mysql_connection()
    try:
        with mysql_conn.cursor() as cur_mysql:
            pg_conn = get_pg_connection()
            try:
                migrate_course(cur_mysql, pg_conn)
                migrate_course_prereq(cur_mysql, pg_conn)
                pg_conn.commit()
                print("Migration complete.")
            except Exception:
                pg_conn.rollback()
                raise
            finally:
                pg_conn.close()
    finally:
        mysql_conn.close()


if __name__ == "__main__":
    main()


