-- ROLLBACK de 20260930090000_fidelizacao_por_responsavel_atual.sql
--
-- Mesmo timestamp da migration que desfaz, por convencao deste diretorio.
-- `supabase/rollbacks/` e auxiliar: o `supabase db push` NAO le esta pasta.
--
-- EXECUTAVEL E TESTADO. O ciclo migration -> rollback -> migration roda em
-- PostgreSQL real (PGlite) sobre a fixture estrutural de producao, em
-- supabase/tests/fidelizacao_por_dono_comportamento.test.js.
--
-- O QUE ESTE ARQUIVO NAO TOCA, em nenhuma hipotese:
--   casos.data_ultimo_acionamento          -- dado operacional, preservado
--   alunos.responsavel_atual_*             -- posse, preservada
--   aluno_movimentacoes / historico_operadores_alunos  -- historico, preservado
--   casos_elegiveis_liberacao_fidelizacao  -- a v1, nunca foi alterada
--   caso_dentro_prazo_fidelizacao          -- nunca foi alterada
--   internal.matricula_em_fidelizacao      -- nunca foi alterada
--   liberar_fidelizacao_caso / liberar_casos_fidelizacao_vencida -- nunca alteradas
--   caso_protegido_redistribuicao, caso_encerrado_operacional, eh_tipo_acionamento
--   os 9 gatilhos de INSERT/UPDATE de public.casos que ja existiam
--
-- DOIS MODOS:
--   PADRAO  -- desfaz tudo e MANTEM a coluna casos.fidelizacao_inicio. Seguro
--              para reverter comportamento sem perder o relogio ja gravado, e
--              reversivel: reaplicar a migration volta ao estado anterior.
--   COMPLETO -- derruba tambem a coluna. Perde o conteudo dela. Pedir assim:
--              set fidelizacao.rollback_completo = 'sim';
--              \i supabase/rollbacks/20260930090000_fidelizacao_por_responsavel_atual.rollback.sql

begin;

-- ---------------------------------------------------------------------------
-- 1. OBJETOS DEPENDENTES -- a policy depende da tabela; a tabela depende de
--    hoje_brt() no default da coluna `dia`. Sai de fora para dentro.
-- ---------------------------------------------------------------------------
drop policy if exists fidelizacao_sombra_leitura_gestao on public.fidelizacao_sombra;

-- ---------------------------------------------------------------------------
-- 2. TABELA DA SOMBRA (leva a RLS e o default que usa hoje_brt())
-- ---------------------------------------------------------------------------
drop table if exists public.fidelizacao_sombra;

-- ---------------------------------------------------------------------------
-- 3. FUNCAO v2 e a rotina da sombra
-- ---------------------------------------------------------------------------
drop function if exists public.casos_elegiveis_liberacao_fidelizacao_v2();
drop function if exists public.fidelizacao_sombra_registrar();

-- ---------------------------------------------------------------------------
-- 4. fn_atualizar_ultimo_acionamento RESTAURADA -- texto EXATO de producao,
--    lido com pg_get_functiondef em 30/09/2026.
--    md5(prosrc) esperado apos este bloco: 8ba80756f6441b5084e053da775ac89d
--    (o teste de rollback confere esse md5; se divergir, o rollback falhou)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_atualizar_ultimo_acionamento()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uuid uuid;
begin
  if not public.eh_tipo_acionamento(new.tipo) then
    return new;
  end if;

  -- Acao massiva confirmada e ATIVIDADE (fica registrada e visivel), mas NAO e
  -- contato operacional: nao renova fidelizacao, nao mexe no nivelamento nem na
  -- liberacao. A cobertura le a movimentacao diretamente.
  if new.tipo in ('ACAO_MASSIVA_EXTERNA', 'ACAO_MASSIVA_EXTERNA_EMAIL') then
    return new;
  end if;

  begin
    v_uuid := new.aluno_id::uuid;
  exception when others then
    return new;
  end;

  update public.alunos a
     set data_ultimo_acionamento = new.registrado_em
   where a.id = v_uuid
     and (a.data_ultimo_acionamento is null
          or a.data_ultimo_acionamento < new.registrado_em);

  update public.casos c
     set data_ultimo_acionamento = new.registrado_em::date
   where c.aluno_id = v_uuid
     and (c.data_ultimo_acionamento is null
          or c.data_ultimo_acionamento < new.registrado_em::date);

  -- recalcular situacao/criticidade apos o acionamento (dias_sem_acionamento zera).
  -- protegido: falha aqui nunca impede o registro do acionamento.
  begin
    perform public.recalcular_situacao_aluno(v_uuid, 'acionamento');
  exception when others then
    null;
  end;

  return new;
exception when others then
  -- nunca impedir o registro do acionamento por falha na atualizacao da ficha
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. GATILHO DA FIDELIZACAO na troca de dono
-- ---------------------------------------------------------------------------
drop trigger if exists trg_fidelizacao_nasce_com_o_dono on public.casos;
drop function if exists public._fidelizacao_nasce_com_o_dono();

-- ---------------------------------------------------------------------------
-- 6. HELPERS NOVOS e o parametro de configuracao
--    Ordem: quem e usado por outro sai depois.
-- ---------------------------------------------------------------------------
drop function if exists public.fidelizacao_backfill_corte();
drop function if exists public.fidelizacao_vencida(timestamptz);
drop function if exists public.fidelizacao_elegivel_em(timestamptz);
drop function if exists public.fidelizacao_limite_vencido();
drop function if exists public.fidelizacao_corte_ts();
drop function if exists public.fidelizacao_corte();
drop function if exists public.fidelizacao_teto_diario();
drop function if exists public.fidelizacao_modo();
drop function if exists public.fidelizacao_dias();
drop function if exists public.hoje_brt();
drop function if exists public.fidelizacao_param();
drop function if exists public.eh_acionamento_fidelizacao(text);

-- A chave que a migration inseriu. Nenhuma outra linha de parametros_operacao e
-- tocada.
delete from public.parametros_operacao where chave = 'fidelizacao_por_dono';

-- ---------------------------------------------------------------------------
-- 7. INDICE
-- ---------------------------------------------------------------------------
drop index if exists public.idx_casos_fidelizacao_inicio;

-- ---------------------------------------------------------------------------
-- 8. COLUNA -- SO no rollback completo, e por ultimo.
-- ---------------------------------------------------------------------------
do $col$
begin
  if coalesce(current_setting('fidelizacao.rollback_completo', true), '') = 'sim' then
    alter table public.casos drop column if exists fidelizacao_inicio;
    raise notice 'rollback COMPLETO: casos.fidelizacao_inicio removida.';
  else
    raise notice 'rollback PADRAO: casos.fidelizacao_inicio MANTIDA (use set fidelizacao.rollback_completo = ''sim'' para remover).';
  end if;
end
$col$;

commit;
