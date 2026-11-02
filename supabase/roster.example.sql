-- PRIVATE TEMPLATE: copy to Supabase SQL Editor and replace placeholders.
-- Do not commit the filled-in roster or real student codes to GitHub.
-- Run after schema.sql, as project owner. The first imported admin can use the app.

-- select private.upsert_student('SE-2421','REPLACE_CODE','REPLACE_FIRST_NAME','REPLACE_LAST_NAME','admin');
-- select private.upsert_student('SE-2421','REPLACE_CODE','REPLACE_FIRST_NAME','REPLACE_LAST_NAME','student');

-- Bulk example (all values here are placeholders, not real students):
-- select private.upsert_student('SE-2421',student_code,first_name,last_name,role)
-- from (values
--   ('REPLACE_CODE_1','REPLACE_FIRST_NAME','REPLACE_LAST_NAME','admin'),
--   ('REPLACE_CODE_2','REPLACE_FIRST_NAME','REPLACE_LAST_NAME','student')
-- ) as roster(student_code,first_name,last_name,role);

-- To revoke a student's access without deleting their history:
-- update private.students set active=false
-- where code_hash=private.code_hash('REPLACE_CODE');

-- Owner-only roster listing deliberately excludes code hashes:
-- select id,first_name,last_name,role,active from private.students order by last_name,first_name;
