-- ============================================================================
-- ROLLBACK da regra definitiva 20260930_1.
-- ============================================================================
-- Devolve `prime_vincular_por_negociacao` ao corpo de producao de 30/09/2026,
-- COM O DEFEITO (o UPDATE que sobrescreve o motor). So use se a correcao
-- quebrar algo -- ela e a causa raiz das 64 mensalidades presas.
--
-- NAO derruba `mensalidade_reconciliar_negociado_quitado` nem a tabela de log:
-- a ferramenta de reconciliacao e o registro de auditoria nao causam efeito
-- sozinhos e apaga-los perderia historico. Para remove-los de fato, rode os
-- dois DROP comentados no fim.
-- ============================================================================

begin;

create or replace function public.prime_vincular_por_negociacao(
  p_confirmar boolean default false,
  p_dias_tolerancia integer default 45
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '600s'
as $function$
declare v_vinculos int := 0; v_titulos int := 0; v_alunos int := 0; v_lote text;
begin
  if coalesce(current_setting('reativa.fluxo_pagamentos', true),'') <> 'on'
     and coalesce(auth.role(),'') <> 'service_role'
     and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode='42501';
  end if;

  create temp table _pvn_grupo on commit drop as
  select pe.matricula, pe.liquidado_em, count(*) qtd,
         round(sum(coalesce(pe.valor_liquido,0)),2) valor,
         array_agg(pe.boleto) boletos
    from public.prime_extrato pe
   where pe.portador = 195 and pe.liquidado_em is not null
   group by 1,2;

  create temp table _pvn_casa on commit drop as
  select distinct on (g.matricula, g.liquidado_em)
         g.matricula, g.liquidado_em, g.boletos, g.qtd, g.valor,
         a.id acordo_id, a.aluno_id, a.numero_acordo
    from _pvn_grupo g
    join public.prime_contratos pc on pc.registration = g.matricula
    join public.alunos al on regexp_replace(coalesce(al.cpf,''),'\D','','g') = regexp_replace(pc.cpf,'\D','','g')
    join public.acordos a on a.aluno_id = al.id
     and upper(coalesce(a.status,'')) in ('ATIVO','QUITADO')
     and a.criado_em::date >= g.liquidado_em
     and a.criado_em::date <= g.liquidado_em + p_dias_tolerancia
   order by g.matricula, g.liquidado_em, (a.criado_em::date - g.liquidado_em);

  create temp table _pvn_alvo on commit drop as
  select distinct c.acordo_id, c.aluno_id, t.id titulo_id,
         coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0) valor
    from _pvn_casa c
    join public.acordos_titulos t
      on t.aluno_id = c.aluno_id
     and ltrim(t.documento,'0') = any (select ltrim(b,'0') from unnest(c.boletos) b)
     and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and upper(coalesce(t.situacao,'')) = 'ABERTO'
   where not exists (select 1 from public.acordo_titulo_vinculo v
                      where v.titulo_id = t.id and coalesce(v.ativo,true));

  select count(*), count(distinct aluno_id) into v_titulos, v_alunos from _pvn_alvo;

  if not coalesce(p_confirmar,false) then
    return jsonb_build_object('modo','previa',
      'alunos_no_espelho', (select count(distinct matricula) from public.prime_extrato),
      'grupos_de_negociacao', (select count(*) from _pvn_grupo),
      'grupos_casados_com_acordo', (select count(*) from _pvn_casa),
      'titulos_a_vincular', v_titulos,
      'valor', (select round(coalesce(sum(valor),0),2) from _pvn_alvo),
      'alunos', v_alunos);
  end if;

  v_lote := to_char(clock_timestamp(),'YYYYMMDDHH24MISS');
  execute format('create table if not exists public.%I as
     select t.*, now() salvo_em from public.acordos_titulos t
      where t.id in (select titulo_id from _pvn_alvo)', '_backup_vinc_negociacao_' || v_lote);

  insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo, origem)
  select a.acordo_id, a.titulo_id, true, 'EXATO_PRIME_195' from _pvn_alvo a
   where not exists (select 1 from public.acordo_titulo_vinculo v
                      where v.titulo_id = a.titulo_id and v.acordo_id = a.acordo_id);
  get diagnostics v_vinculos = row_count;

  update public.acordos_titulos t
     set situacao='NEGOCIADO', status='vinculada', acordo_id = a.acordo_id,
         motivo_ajuste = coalesce(t.motivo_ajuste,'')
           || case when coalesce(t.motivo_ajuste,'')='' then '' else ' | ' end
           || 'vinculado pelo Prime: liquidado no portador 195 junto com as outras mensalidades do mesmo acordo',
         atualizado_em = now()
    from _pvn_alvo a where t.id = a.titulo_id;

  perform public.recalcular_situacao_aluno(x.aluno_id) from (select distinct aluno_id from _pvn_alvo) x;

  return jsonb_build_object('modo','aplicado','lote', v_lote,
    'vinculos_criados', v_vinculos, 'titulos', v_titulos, 'alunos', v_alunos,
    'backup', '_backup_vinc_negociacao_' || v_lote);
end;
$function$;

-- drop function if exists public.mensalidade_reconciliar_negociado_quitado(boolean);
-- drop table if exists public.mensalidade_reconciliacao_log;

commit;
