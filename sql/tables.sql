-- course
CREATE TABLE IF NOT EXISTS course (
  course_id        VARCHAR(20) PRIMARY KEY,
  course_name      VARCHAR(200),
  department       VARCHAR(100),
  course_level     INT,
  description      TEXT,
  liked            NUMERIC(5,2),
  easy             NUMERIC(5,2),
  useful           NUMERIC(5,2),
  rating_num       INT
);

-- course_prereq
CREATE TABLE IF NOT EXISTS course_prereq (
  course_id            VARCHAR(20) NOT NULL,
  prereq_course_id     VARCHAR(20) NOT NULL,
  prerequisite_group   INT NOT NULL,
  min_grade            INT,
  CONSTRAINT pk_course_prereq
    PRIMARY KEY (course_id, prereq_course_id, prerequisite_group),
  CONSTRAINT fk_cp_course
    FOREIGN KEY (course_id) REFERENCES course(course_id)
      ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_cp_prereq_course
    FOREIGN KEY (prereq_course_id) REFERENCES course(course_id)
      ON UPDATE CASCADE ON DELETE RESTRICT
);

-- Helpful indexes (match your query patterns)
CREATE INDEX IF NOT EXISTS ix_cp_course            ON course_prereq(course_id);
CREATE INDEX IF NOT EXISTS ix_cp_prereq_course     ON course_prereq(prereq_course_id);
CREATE INDEX IF NOT EXISTS ix_cp_course_group      ON course_prereq(course_id, prerequisite_group);


-- visitor_log
CREATE TABLE IF NOT EXISTS visitor_log (
  log_id           SERIAL PRIMARY KEY,
  ip_address       VARCHAR(45),
  path             TEXT,
  user_agent       TEXT,
  visited_at       TIMESTAMP WITHOUT TIME ZONE
);