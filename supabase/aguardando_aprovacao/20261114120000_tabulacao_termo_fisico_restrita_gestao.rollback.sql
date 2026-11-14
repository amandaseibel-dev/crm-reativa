-- Rollback de 20261114120000_tabulacao_termo_fisico_restrita_gestao.sql.
-- Restaura EXATAMENTE o estado anterior: antes da migração as duas linhas não existiam.
-- Por isso o rollback REMOVE as linhas, e só se for seguro:
--   1. as linhas precisam estar exatamente como a migração as deixou (nenhuma alteração
--      posterior, inclusive somente_gestao e rótulo). Se mudaram: recusa INTEIRA;
--   2. nenhum registro de histórico pode citar os códigos (o histórico é preservado).
--      Se existir, recusa INTEIRA. Nada é removido nem alterado.
-- Só depois das duas guardas passarem: remove as linhas, a trigger e a função.
BEGIN;
do $$
declare
  v_codigos constant text[] := array['TERMO_FISICO_EM_ANDAMENTO','TERMO_FISICO_ARQUIVADO'];
  v_alteradas integer;
  v_usados integer;
begin
  select count(*) into v_alteradas
    from public.tabulacoes t
   where t.codigo = any(v_codigos)
     and not (t.criado_por = 'migration_termo_fisico'
              and t.rotulo in ('Possui termo físico assinado, em andamento','Termo físico arquivado, quitado')
              and t.ativa and t.somente_gestao
              and t.grupo = 'ADMINISTRATIVO' and t.retorno_modo = 'NENHUM' and t.retorno_dias_uteis is null
              and t.proxima_acao = 'CONTATAR' and t.bloco_ficha is null
              and not t.exige_processo and not t.bloqueia_acionamento and not t.sistema
              and t.atualizado_em is null and t.atualizado_por is null
              and t.desativada_em is null and t.desativada_por is null
              and t.redireciona_para_email is null and t.efeito_desfecho is null);
  if v_alteradas > 0 then
    raise exception 'rollback recusado: a tabulação de termo físico foi alterada depois da migração. Nada foi removido. Tratar pelo fluxo autorizado.';
  end if;

  select count(*) into v_usados
    from public.aluno_movimentacoes m
   where upper(regexp_replace(coalesce(m.status_novo, ''), '[^A-Za-z0-9_]', '', 'g')) = any(v_codigos);
  if v_usados > 0 then
    raise exception 'rollback recusado: % registro(s) de histórico já usam estes códigos. O histórico é preservado; nada foi removido. Tratar pelo fluxo autorizado.', v_usados;
  end if;

  delete from public.tabulacoes where codigo = any(v_codigos) and criado_por = 'migration_termo_fisico';
  drop trigger if exists aluno_mov_tabulacao_so_gestao on public.aluno_movimentacoes;
  drop function if exists public.aluno_movimentacao_tabulacao_so_gestao();
end $$;
COMMIT;
