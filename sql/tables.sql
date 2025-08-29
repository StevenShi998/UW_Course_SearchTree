-- Course table matching the production schema
CREATE TABLE IF NOT EXISTS course (
course_id VARCHAR(20) PRIMARY KEY,
course_name VARCHAR(200) NULL,
department VARCHAR(100) NULL,
course_level INT NULL,
description TEXT NULL
) ENGINE=InnoDB;

-- Offering table: uniqueness by (term, course_id)
CREATE TABLE IF NOT EXISTS offering (
term VARCHAR(50) NOT NULL,
course_id VARCHAR(20) NOT NULL,
CONSTRAINT pk_offering PRIMARY KEY (term, course_id),
CONSTRAINT fk_offering_course
FOREIGN KEY (course_id) REFERENCES course(course_id)
ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS course_prereq (
course_id VARCHAR(20) NOT NULL,
prereq_course_id VARCHAR(20) NOT NULL,
prerequisite_group INT NOT NULL,
min_grade INT NULL,

CONSTRAINT pk_course_prereq
PRIMARY KEY (course_id, prereq_course_id, prerequisite_group),

CONSTRAINT fk_cp_course
FOREIGN KEY (course_id) REFERENCES course(course_id)
ON UPDATE CASCADE ON DELETE CASCADE,
CONSTRAINT fk_cp_prereq_course
FOREIGN KEY (prereq_course_id) REFERENCES course(course_id)
ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE INDEX ix_offering_course ON offering(course_id);
CREATE INDEX ix_cp_course ON course_prereq(course_id);
CREATE INDEX ix_cp_prereq_course ON course_prereq(prereq_course_id);
CREATE INDEX ix_cp_course_group ON course_prereq(course_id, prerequisite_group);

-- Stores raw prerequisite text/HTML and a structured JSON representation
-- of the parsed logic for auditing and re-parsing. One row per course
-- (latest parse wins; replace on each scraper run).
CREATE TABLE IF NOT EXISTS course_prereq_text (
course_id VARCHAR(20) NOT NULL,
source VARCHAR(20) NOT NULL DEFAULT 'uw_calendar',
raw_text LONGTEXT NULL,
logic_json JSON NULL,
parsed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT pk_course_prereq_text PRIMARY KEY (course_id),
CONSTRAINT fk_cpt_course FOREIGN KEY (course_id) REFERENCES course(course_id)
ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;