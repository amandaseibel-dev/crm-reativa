-- ROLLBACK de 20260916210000_acoes_massivas_exportar_sem_registrar.
--
-- Remove as tres funcoes. A tabela de lotes NAO e apagada: e renomeada para
-- backup (RLS continua ligado, sem grant), para nao perder o registro de quem
-- exportou contatos e de quais lotes ja foram confirmados.
--
-- ATENCAO: com o rollback aplicado e o front novo publicado, o botao "Exportar
-- planilha" passa a falhar (a funcao nao existe) -- ele NUNCA cai de volta no
-- registro. Para voltar ao fluxo antigo, publicar tambem o front anterior.

drop function if exists public.acoes_massivas_lotes_pendentes();
drop function if exists public.acoes_massivas_concluir_lote(uuid, text);
drop function if exists public.acoes_massivas_exportar(text[], text, text, text);

do $rollback$
begin
  if to_regclass('public.acoes_massivas_lotes') is not null then
    execute format('alter table public.acoes_massivas_lotes rename to %I',
                   '_backup_acoes_massivas_lotes_' || to_char(now(), 'YYYYMMDDHH24MISS'));
  end if;
end $rollback$;
