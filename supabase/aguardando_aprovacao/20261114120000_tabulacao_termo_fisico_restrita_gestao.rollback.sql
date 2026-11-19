-- ROLLBACK REVERSÍVEL de 20261114120000_tabulacao_termo_fisico_restrita_gestao.sql
--
-- Restaura o estado anterior à migração: remove SOMENTE os objetos que ela criou
-- (função da trigger, trigger, RPC, tabela de contenção) e as duas linhas do catálogo
-- que ela gravou. Não apaga histórico (aluno_movimentacoes) e não altera objeto
-- preexistente: a migração só cria objetos novos e só faz GRANT/REVOKE neles (verificado por leitura
-- do .pendente). As pré-condições garantem existência, não ACL; o snapshot do CI cobre ACL e RLS das tabelas tocadas.
--
-- Recusa com motivo específico (P0001), SEM alterar nada, quando:
--   1. há registros de termo físico em aluno_movimentacoes (reverter removeria o histórico);
--   2. há alunos com código de termo físico no estado (alunos);
--   3. o catálogo de termo físico não é exatamente as duas linhas gravadas pela migração;
--   4. a contenção está ativa, ou foi alterada por outro autor (alterado_por diferente).
--      A detecção de alteração é por alterado_por: uma mudança que volta ao valor original
--      sem alterar alterado_por não é detectada, e não precisa ser, porque o estado final é o gravado.
--
-- Alternativa operacional quando recusado: ativar a contenção
-- (termo_fisico_contencao.contencao_ativa = true), que suspende novos registros
-- sem remover nada.

\set VERBOSITY verbose
begin;

do $$
declare
  v_n integer;
  v_codigos constant text[] := array['TERMO_FISICO_EM_ANDAMENTO','TERMO_FISICO_ARQUIVADO'];
begin
  -- 1. histórico. Mesma normalização da trigger (ASCII antes do upper, COLLATE "C"): variantes de caixa/espaço contam.
  select count(*) into v_n
    from public.aluno_movimentacoes
   where upper(regexp_replace(coalesce(tipo, ''), '[^A-Za-z0-9_]', '', 'g') COLLATE "C") = 'REGISTRO_ADMINISTRATIVO'
      or upper(regexp_replace(coalesce(status_novo, ''), '[^A-Za-z0-9_]', '', 'g') COLLATE "C") = any (v_codigos);
  if v_n > 0 then
    raise exception 'rollback recusado: % registro(s) de termo físico em aluno_movimentacoes. Reverter removeria o histórico. Nada foi alterado. Alternativa operacional: ativar a contenção (termo_fisico_contencao.contencao_ativa = true).', v_n
      using errcode = 'P0001';
  end if;

  -- 2. estado do aluno (mesma normalização)
  select count(*) into v_n
    from public.alunos
   where upper(regexp_replace(coalesce(status_atual, ''), '[^A-Za-z0-9_]', '', 'g') COLLATE "C") = any (v_codigos)
      or upper(regexp_replace(coalesce(status_jornada, ''), '[^A-Za-z0-9_]', '', 'g') COLLATE "C") = any (v_codigos)
      or upper(regexp_replace(coalesce(status_acionamento, ''), '[^A-Za-z0-9_]', '', 'g') COLLATE "C") = any (v_codigos);
  if v_n > 0 then
    raise exception 'rollback recusado: % aluno(s) com código de termo físico no estado do aluno. Nada foi alterado. Alternativa operacional: ativar a contenção (termo_fisico_contencao.contencao_ativa = true).', v_n
      using errcode = 'P0001';
  end if;

  -- 3. catálogo: exatamente as duas linhas gravadas pela migração, sem alteração posterior
  select count(*) into v_n from public.tabulacoes where codigo = any (v_codigos);
  if v_n <> 2 then
    raise exception 'rollback recusado: o catálogo de termo físico tem % linha(s), e o esperado são 2. Nada foi alterado.', v_n
      using errcode = 'P0001';
  end if;
  -- Conteúdo exato gravado pela migração (qualquer edição, inclusive rótulo, recusa).
  select count(*) into v_n
    from public.tabulacoes t
    join (values
      ('TERMO_FISICO_EM_ANDAMENTO', 'Possui termo físico assinado, em andamento', 355),
      ('TERMO_FISICO_ARQUIVADO',    'Termo físico arquivado, quitado',            356)
    ) as e(codigo, rotulo, ordem) on t.codigo = e.codigo
   where t.rotulo = e.rotulo and t.ordem = e.ordem
     and t.ativa is true and t.somente_gestao is true
     and t.grupo = 'ADMINISTRATIVO' and t.retorno_modo = 'NENHUM' and t.proxima_acao = 'CONTATAR'
     and t.retorno_dias_uteis is null and t.bloco_ficha is null
     and t.exige_processo is false and t.bloqueia_acionamento is false and t.sistema is false
     and t.efeito_desfecho is null and t.redireciona_para_email is null
     and t.criado_por = 'migration_termo_fisico'
     and t.criado_em = timestamptz '2026-11-14 00:00:00-03'
     and t.atualizado_em is null and t.atualizado_por is null
     and t.desativada_em is null and t.desativada_por is null;
  if v_n <> 2 then
    raise exception 'rollback recusado: o catálogo de termo físico foi alterado depois da migração (% de 2 linhas íntegras). Nada foi alterado.', v_n
      using errcode = 'P0001';
  end if;

  -- 4. contenção
  if to_regclass('public.termo_fisico_contencao') is not null then
    if exists (select 1 from public.termo_fisico_contencao
                where alterado_por is distinct from 'migration_termo_fisico') then
      raise exception 'rollback recusado: a contenção foi alterada por outro autor (alterado_por diferente da migração). Nada foi alterado. Decisão da gestão antes de reverter.'
        using errcode = 'P0001';
    end if;
    if exists (select 1 from public.termo_fisico_contencao where contencao_ativa is true) then
      raise exception 'rollback recusado: a contenção de termo físico está ativa. Nada foi alterado. Reverter exige decisão da gestão.'
        using errcode = 'P0001';
    end if;
  end if;

  -- Remoção: somente o que esta migração criou.
  drop trigger if exists aluno_mov_tabulacao_so_gestao on public.aluno_movimentacoes;
  drop function if exists public.registrar_administrativo_termo_fisico(text, text);
  drop function if exists public.aluno_movimentacao_tabulacao_so_gestao();
  drop table if exists public.termo_fisico_contencao;
  delete from public.tabulacoes
   where codigo = any (v_codigos) and criado_por = 'migration_termo_fisico';

  -- VIGIA: nada desta migração sobrou.
  if exists (select 1 from pg_trigger where tgname = 'aluno_mov_tabulacao_so_gestao' and not tgisinternal) then
    raise exception 'rollback: trigger aluno_mov_tabulacao_so_gestao ainda existe';
  end if;
  if to_regprocedure('public.registrar_administrativo_termo_fisico(text,text)') is not null
     or to_regprocedure('public.aluno_movimentacao_tabulacao_so_gestao()') is not null then
    raise exception 'rollback: função de termo físico ainda existe';
  end if;
  if to_regclass('public.termo_fisico_contencao') is not null then
    raise exception 'rollback: tabela termo_fisico_contencao ainda existe';
  end if;
  if exists (select 1 from public.tabulacoes where codigo = any (v_codigos)) then
    raise exception 'rollback: linhas de termo físico ainda existem no catálogo';
  end if;
end
$$;

commit;
