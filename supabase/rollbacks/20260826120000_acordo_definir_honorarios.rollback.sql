-- Rollback: remove a funcao. Os honorarios ja informados NAO sao revertidos --
-- sao dado de trabalho, informado por gente, e apagar em massa seria pior que
-- o problema original. Para achar o que foi informado por este caminho:
--
--   select * from public.aluno_movimentacoes
--   where tipo = 'HONORARIO_INFORMADO' order by registrado_em desc;

drop function if exists public.acordo_definir_honorarios(uuid, numeric, numeric, text);
