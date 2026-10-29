-- Saúde da Carteira: separar o saldo entre ACORDO e MENSALIDADE.
--
-- Hoje a tela mostra um número só: `saldo_total` e `saldo_vencido`, ambos
-- somados do campo GRAVADO no caso. Isso junta duas situações opostas no mesmo
-- balde. Medido em prod 2026-08-25:
--
--   ACORDO (parcelas)      R$ 11.551.180,25  -- vencido 5.816.885,73 | a vencer 5.734.294,52
--   MENSALIDADE (titulos)  R$ 36.825.849,15  -- vencido 36.824.288,04 | a vencer 1.561,11
--
-- Metade do saldo de acordo AINDA NÃO VENCEU: é dívida negociada, com data
-- marcada, sendo paga. A mensalidade é 99,99% vencida: passivo cru, sem
-- negociação. Somar as duas responde mal qualquer pergunta de gestão.
--
-- POR QUE CALCULAR DA ORIGEM E NÃO DA MATVIEW: o `casos.saldo_total` gravado
-- está defasado em 1.425 casos (R$ 5,83 mi a menos que a dívida real). O corte
-- por origem nasce lendo `parcelas` e `acordos_titulos` direto, então já vem
-- imune a essa defasagem. O efeito colateral é que este bloco é SEMPRE a
-- posição de agora, enquanto os demais cards vêm da matview -- por isso a RPC
-- também devolve `saldo_por_origem.calculado_em` e a tela precisa rotular os
-- dois blocos com sua própria data. Números de datas diferentes na mesma tela,
-- sem rótulo, é como se perde a confiança no painel inteiro.
--
-- Regra de "mensalidade em aberto" -- a mesma de `saldo_titulos_aberto`:
-- situacao ABERTO, status em_aberto, sem acordo_id E sem linha de vínculo.
-- A dupla checagem (acordo_id + vínculo) evita contar de novo a mensalidade
-- que já virou acordo; hoje as duas concordam, depois do reparo dos 169
-- títulos em 20260826020000, mas a fonte da verdade é o vínculo.
--
-- Escopo de operador preservado: o bloco lê os alunos de `tmp_sc`, que já vem
-- filtrado por `saude_carteira_escopo`. Operador continua vendo só o dele.
--
-- Rollback: supabase/rollbacks/20260826040000_saude_carteira_saldo_por_origem.rollback.sql

create or replace function public.saude_carteira_saldo_por_origem(p_alunos uuid[])
returns jsonb language sql stable security definer set search_path to 'public' as $$
  with acordo as (
    select ac.aluno_id,
      sum(coalesce(p.valor,0))                                      as total,
      sum(coalesce(p.valor,0)) filter (where p.status='VENCIDA')    as vencido,
      sum(coalesce(p.valor,0)) filter (where p.status='A_VENCER')   as a_vencer
    from public.parcelas p
    join public.acordos ac on ac.id = p.acordo_id
    where p.status in ('VENCIDA','A_VENCER')
      and ac.status = 'ATIVO'
      and ac.aluno_id = any(p_alunos)
    group by 1
  ),
  mensal as (
    select t.aluno_id,
      sum(coalesce(t.saldo_corrigido,t.valor_original,0))                                                as total,
      sum(coalesce(t.saldo_corrigido,t.valor_original,0)) filter (where t.vencimento <  current_date)    as vencido,
      sum(coalesce(t.saldo_corrigido,t.valor_original,0)) filter (where t.vencimento >= current_date)    as a_vencer
    from public.acordos_titulos t
    where t.situacao = 'ABERTO'
      and t.status = 'em_aberto'
      and t.acordo_id is null
      and not exists (select 1 from public.acordo_titulo_vinculo v
                       where v.titulo_id = t.id and coalesce(v.ativo, true))
      and t.aluno_id = any(p_alunos)
    group by 1
  )
  select jsonb_build_object(
    'acordo_total',        coalesce((select sum(total)    from acordo),0),
    'acordo_vencido',      coalesce((select sum(vencido)  from acordo),0),
    'acordo_a_vencer',     coalesce((select sum(a_vencer) from acordo),0),
    'acordo_alunos',       coalesce((select count(*) from acordo where total > 0),0),
    'mensalidade_total',   coalesce((select sum(total)    from mensal),0),
    'mensalidade_vencido', coalesce((select sum(vencido)  from mensal),0),
    'mensalidade_a_vencer',coalesce((select sum(a_vencer) from mensal),0),
    'mensalidade_alunos',  coalesce((select count(*) from mensal where total > 0),0),
    'total',               coalesce((select sum(total) from acordo),0) + coalesce((select sum(total) from mensal),0),
    'vencido',             coalesce((select sum(vencido) from acordo),0) + coalesce((select sum(vencido) from mensal),0),
    'a_vencer',            coalesce((select sum(a_vencer) from acordo),0) + coalesce((select sum(a_vencer) from mensal),0),
    'calculado_em',        now()
  );
$$;

comment on function public.saude_carteira_saldo_por_origem(uuid[]) is
  'Saldo em aberto separado entre acordo (parcelas) e mensalidade (titulos), lido das tabelas de origem -- imune a defasagem do saldo gravado no caso. Recebe os alunos ja filtrados pelo escopo do chamador.';

revoke all on function public.saude_carteira_saldo_por_origem(uuid[]) from public, anon;
grant execute on function public.saude_carteira_saldo_por_origem(uuid[]) to authenticated;

------------------------------------------------------------------------------
-- Liga o bloco novo à RPC do resumo. Todo o resto da função é idêntico ao que
-- já estava: só entram a variável `v_origem`, a chamada logo após montar
-- `tmp_sc`, e a chave `saldo_por_origem` no retorno.
------------------------------------------------------------------------------
create or replace function public.saude_carteira_resumo_impl(p_filtros jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare
  v_ctx jsonb := public.saude_carteira_escopo(p_filtros);
  v_f jsonb := v_ctx->'filtros';
  v_incluir_encerrados boolean := coalesce((v_f->>'incluir_encerrados')::boolean, false);
  v_min_dias int := coalesce((v_f->>'min_dias_sem_acionamento')::int, 5);
  v_estab text := nullif(v_f->>'estabelecimento','');
  v_operador text := nullif(v_f->>'operador_email','');
  v_totais jsonb; v_estabs jsonb; v_mtx_faixa jsonb; v_mtx_tempo jsonb; v_operadores jsonb;
  v_origem jsonb; v_alunos uuid[];
begin
  drop table if exists tmp_sc; create temporary table tmp_sc on commit drop as
  select * from public.mv_saude_carteira v
  where (v_incluir_encerrados or v.encerrado = false)
    and (v_estab is null or v.estabelecimento = v_estab)
    and (v_operador is null or v.operador_email is not distinct from v_operador);

  -- Saldo por origem: lido das tabelas de origem, com os MESMOS alunos do escopo.
  select array_agg(distinct aluno_id) into v_alunos from tmp_sc where aluno_id is not null;
  v_origem := public.saude_carteira_saldo_por_origem(coalesce(v_alunos, array[]::uuid[]));

  select jsonb_build_object(
    'casos_ativos', count(*), 'cpfs_unicos', count(distinct aluno_id),
    'saldo_vencido', coalesce(sum(saldo_vencido),0), 'saldo_total', coalesce(sum(saldo_total),0),
    'nunca_acionados', count(*) filter (where nunca_acionado),
    'sem_acionamento_limite', count(*) filter (where nunca_acionado or dias_sem_acionamento >= v_min_dias),
    'pct_sem_acionamento', round(100.0 * count(*) filter (where nunca_acionado or dias_sem_acionamento >= v_min_dias) / greatest(count(*),1), 1),
    'retornos_vencidos', count(*) filter (where retorno_vencido),
    'sem_telefone', count(*) filter (where sem_telefone), 'sem_responsavel', count(*) filter (where sem_responsavel),
    'criticos', count(*) filter (where critico_canonico), 'urgentes', count(*) filter (where urgente_canonico),
    'acordos_em_dia', count(*) filter (where acordo_situacao = 'EM_DIA'),
    'acordos_vencidos', count(*) filter (where acordo_situacao = 'VENCIDO'),
    'acordos_quebrados', count(*) filter (where acordo_situacao = 'QUEBRADO'),
    'acordos_em_dia_sem_acompanhamento', count(*) filter (where acordo_situacao='EM_DIA' and (data_retorno is null or data_retorno < current_date)),
    'casos_revisao', count(*) filter (where cpf_conta is null or aluno_id is null),
    'fidelizacao_ativa', count(*) filter (where fidelizacao_situacao='ATIVA'),
    'fidelizacao_vence_3d', count(*) filter (where fidelizacao_situacao in ('ATENCAO','URGENTE','ULTIMO_DIA')),
    'fidelizacao_vence_amanha', count(*) filter (where fidelizacao_situacao='URGENTE'),
    'fidelizacao_expira_hoje', count(*) filter (where fidelizacao_situacao='ULTIMO_DIA'),
    'fidelizacao_expirada', count(*) filter (where fidelizacao_situacao='EXPIRADA'),
    'casos_livres', count(*) filter (where fidelizacao_situacao='LIVRE'),
    'saldo_livres', coalesce(sum(saldo_total) filter (where fidelizacao_situacao='LIVRE'),0),
    'protegidas', count(*) filter (where fidelizacao_situacao='PROTEGIDA'),
    'min_dias_sem_acionamento', v_min_dias
  ) into v_totais from tmp_sc;

  select jsonb_agg(t order by t.sem_acionamento_limite desc) into v_estabs from (
    select estabelecimento, count(*) as casos_ativos, count(distinct aluno_id) as cpfs_unicos,
      coalesce(sum(saldo_vencido),0) as saldo_vencido, coalesce(sum(saldo_total),0) as saldo_total,
      count(*) filter (where nunca_acionado) as nunca_acionados,
      count(*) filter (where nunca_acionado or dias_sem_acionamento >= v_min_dias) as sem_acionamento_limite,
      round(100.0 * count(*) filter (where nunca_acionado or dias_sem_acionamento >= v_min_dias) / greatest(count(*),1),1) as pct_sem_acionamento,
      count(*) filter (where nunca_acionado or dias_sem_acionamento > 7) as sem_ac_7,
      count(*) filter (where nunca_acionado or dias_sem_acionamento > 15) as sem_ac_15,
      count(*) filter (where nunca_acionado or dias_sem_acionamento > 30) as sem_ac_30,
      count(*) filter (where retorno_vencido) as retornos_vencidos,
      count(*) filter (where sem_telefone) as sem_telefone, count(*) filter (where sem_responsavel) as sem_responsavel,
      count(*) filter (where critico_canonico) as criticos, count(*) filter (where urgente_canonico) as urgentes,
      count(*) filter (where acordo_situacao='EM_DIA') as acordos_em_dia,
      count(*) filter (where acordo_situacao='VENCIDO') as acordos_vencidos,
      count(*) filter (where acordo_situacao='QUEBRADO') as acordos_quebrados,
      count(*) filter (where fidelizacao_situacao='LIVRE') as casos_livres,
      coalesce(sum(saldo_total) filter (where fidelizacao_situacao='LIVRE'),0) as saldo_livres,
      count(*) filter (where fidelizacao_situacao='ATIVA') as fidelizacao_ativa,
      count(*) filter (where fidelizacao_situacao='EXPIRADA') as fidelizacao_expirada,
      count(*) filter (where cpf_conta is null or aluno_id is null) as casos_revisao
    from tmp_sc group by estabelecimento
  ) t;

  select jsonb_agg(t order by t.estabelecimento) into v_mtx_faixa from (
    select estabelecimento,
      count(*) filter (where faixa_atraso='A_VENCER') as a_vencer,
      count(*) filter (where faixa_atraso='1_30') as f1_30, count(*) filter (where faixa_atraso='31_60') as f31_60,
      count(*) filter (where faixa_atraso='61_90') as f61_90, count(*) filter (where faixa_atraso='91_180') as f91_180,
      count(*) filter (where faixa_atraso='181_365') as f181_365, count(*) filter (where faixa_atraso='MAIS_365') as f_mais_365,
      count(distinct aluno_id) as cpfs, coalesce(sum(saldo_vencido),0) as saldo_vencido,
      coalesce(sum(saldo_total),0) as saldo_total, count(*) as total
    from tmp_sc group by estabelecimento
  ) t;

  select jsonb_agg(t order by t.estabelecimento) into v_mtx_tempo from (
    select estabelecimento,
      count(*) filter (where faixa_tempo_sem_acionamento='NUNCA') as nunca,
      count(*) filter (where faixa_tempo_sem_acionamento='1D') as d1, count(*) filter (where faixa_tempo_sem_acionamento='2_3D') as d2_3,
      count(*) filter (where faixa_tempo_sem_acionamento='4_5D') as d4_5, count(*) filter (where faixa_tempo_sem_acionamento='6_7D') as d6_7,
      count(*) filter (where faixa_tempo_sem_acionamento='8_15D') as d8_15, count(*) filter (where faixa_tempo_sem_acionamento='16_30D') as d16_30,
      count(*) filter (where faixa_tempo_sem_acionamento='MAIS_30D') as d_mais_30,
      count(distinct aluno_id) as cpfs, coalesce(sum(saldo_vencido),0) as saldo_vencido,
      coalesce(sum(saldo_total),0) as saldo_total, count(*) as total
    from tmp_sc group by estabelecimento
  ) t;

  select jsonb_agg(t order by t.casos_ativos desc) into v_operadores from (
    select coalesce(operador_email,'(SEM RESPONSAVEL)') as operador_email, count(*) as casos_ativos,
      count(distinct aluno_id) as cpfs_unicos, coalesce(sum(saldo_vencido),0) as saldo_vencido,
      coalesce(sum(saldo_total),0) as saldo_total, count(*) filter (where nunca_acionado) as nunca_acionados,
      count(*) filter (where nunca_acionado or dias_sem_acionamento >= v_min_dias) as sem_acionamento_limite,
      round(100.0 * count(*) filter (where nunca_acionado or dias_sem_acionamento >= v_min_dias) / greatest(count(*),1),1) as pct_sem_acionamento,
      count(*) filter (where retorno_vencido) as retornos_vencidos, count(*) filter (where sem_telefone) as sem_telefone,
      count(*) filter (where critico_canonico) as criticos, count(*) filter (where urgente_canonico) as urgentes,
      count(*) filter (where acordo_situacao='EM_DIA') as acordos_em_dia,
      count(*) filter (where acordo_situacao='VENCIDO') as acordos_vencidos,
      count(*) filter (where fidelizacao_situacao='ATIVA') as fidelizacao_ativa,
      count(*) filter (where fidelizacao_situacao='EXPIRADA') as fidelizacao_expirada
    from tmp_sc group by coalesce(operador_email,'(SEM RESPONSAVEL)')
  ) t;

  return jsonb_build_object('totais', v_totais, 'estabelecimentos', coalesce(v_estabs,'[]'::jsonb),
    'matriz_faixa_atraso', coalesce(v_mtx_faixa,'[]'::jsonb),
    'matriz_tempo_sem_acionamento', coalesce(v_mtx_tempo,'[]'::jsonb),
    'operadores', coalesce(v_operadores,'[]'::jsonb),
    'saldo_por_origem', v_origem,
    'escopo', jsonb_build_object('is_gestao', v_ctx->'is_gestao', 'operador', v_ctx->'operador_forcado'),
    'atualizado_em', (select atualizado_em from public.saude_carteira_mv_meta where id),
    'filtros', v_f, 'gerado_em', now());
end; $function$;
