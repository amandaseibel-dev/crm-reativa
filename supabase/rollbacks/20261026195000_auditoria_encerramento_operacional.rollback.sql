-- ROLLBACK -- 20261026195000_auditoria_encerramento_operacional.sql
--
-- PRESERVA O HISTORICO JA PRODUZIDO. Este rollback desliga a captura (gatilho e
-- funcao) e NAO apaga `casos_encerramento_auditoria` nem uma linha dela. Trilha
-- de auditoria que o proprio rollback apaga nao e trilha: se a captura precisa
-- sair, o que ela ja registrou continua sendo o unico registro de quem encerrou
-- caso neste intervalo.
--
-- Depois de rodar isto, encerramento volta a mudar sem rastro -- que e
-- exatamente o estado anterior, e e por isso que este rollback e de ultimo
-- recurso.
--
-- Para descartar a tabela tambem, e decisao separada e explicita da gestao:
--     drop table public.casos_encerramento_auditoria;
-- Nao esta aqui de proposito.

begin;

drop trigger if exists trg_auditar_encerramento_operacional on public.casos;
drop function if exists public.trg_auditar_encerramento_operacional();

do $$
declare v_n bigint;
begin
  if to_regclass('public.casos_encerramento_auditoria') is null then
    raise notice 'tabela de auditoria ausente: nada a preservar';
    return;
  end if;
  execute 'select count(*) from public.casos_encerramento_auditoria' into v_n;
  raise notice 'captura desligada. Linhas preservadas em casos_encerramento_auditoria: %', v_n;
end
$$;

commit;
