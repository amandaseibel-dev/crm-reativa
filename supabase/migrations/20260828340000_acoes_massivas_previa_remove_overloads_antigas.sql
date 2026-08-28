-- Tres versoes de acoes_massivas_previa conviviam no banco. Quando o cliente
-- manda um conjunto de chaves que serve para mais de uma, o PostgREST recusa
-- com "could not choose a best candidate function".
--
-- So existe UM chamador (src/pages/AcoesMassivas.jsx) e ele manda todos os
-- parametros, inclusive p_matricula.

drop function if exists public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean,text);
drop function if exists public.acoes_massivas_previa(text,integer,integer,boolean,text,text,boolean,text,uuid[]);
