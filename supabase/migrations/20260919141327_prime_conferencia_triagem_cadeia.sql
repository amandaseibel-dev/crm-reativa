-- TRIAGEM DA CONFERENCIA PRIME -- AJUSTE 2 (19/09/2026): CADEIA OBJETIVA
--
-- Problema encontrado no lote dos 20: "pagamento ReATIVA no dia" e "acordo na
-- janela" viravam PAGAMENTO_COMPROVADO / ACORDO_COMPROVADO. Pagamento do mesmo
-- CPF no mesmo dia NAO prova que pagou ESTE titulo; acordo perto da data NAO
-- prova vinculo. Agora:
--   PAGAMENTO_COMPROVADO  so com cadeia pagamento -> boleto/parcela -> acordo
--                         -> este titulo (composicao, vinculo ou acordo_id),
--                         ou solicitacao com titulo_id + pagamento_id, ou o
--                         subgrupo A_PAGAMENTO_COMPROVADO da regra de entrada.
--   ACORDO_COMPROVADO     so com vinculo/composicao/acordo_id que cobre este
--                         titulo (QUITADO exige dinheiro real), solicitacao com
--                         titulo_id + acordo/parcela, ou B_ACORDO_COMPROVADO.
--   PAGAMENTO_CANDIDATO   ha pagamento do aluno perto da data, sem cadeia.
--   ACORDO_CANDIDATO      ha acordo do aluno perto da data / A2 / composicao
--                         QUITADA sem dinheiro real, sem vinculo comprovado.
-- Candidatos sao necessita_manual = true. Somente origem_provavel,
-- evidencias_resumo, motivos e necessita_manual mudam. Prioridade, classe
-- humana, decisao, titulo, pagamento, acordo, parcela, vinculo e crons NAO.

begin;

create temp table _tri2_antes on commit drop as
select (select count(*) from public.prime_conferencia_decisao where decisao='PENDENTE') pendentes,
       (select coalesce(round(sum(valor),2),0) from public.prime_conferencia_decisao where decisao='PENDENTE') valor_pendente,
       (select md5(string_agg(titulo_id::text||decisao||coalesce(classe_humana,'')||coalesce(classe_humana_obs,'')||coalesce(classe_humana_por,'')||coalesce(classe_humana_em::text,'')||coalesce(triagem->>'prioridade',''), ',' order by titulo_id)) from public.prime_conferencia_decisao) decisoes_md5,
       (select md5(string_agg(id::text||coalesce(situacao,'')||coalesce(status,''), ',' order by id)) from public.acordos_titulos) titulos_md5,
       (select md5(string_agg(id::text||coalesce(situacao_operacional,'')||coalesce(responsavel_atual_email,''), ',' order by id)) from public.alunos) alunos_md5,
       (select count(*) from public.pagamentos) pag, (select count(*) from public.acordos) ac,
       (select count(*) from public.parcelas) parc, (select count(*) from public.acordo_titulo_vinculo) vinc;

create or replace function public.prime_conferencia_triagem_recalcular(p_titulos uuid[] default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '120s'
as $function$
declare
  v_n int := 0; v_ini timestamptz := clock_timestamp(); v_res jsonb;
  v_tem_ctr boolean := to_regclass('public.prime_contratos') is not null;
  v_tem_sol boolean := to_regclass('public.solicitacoes_financeiro') is not null;
  v_tem_166 boolean := to_regclass('public.prime_portador_membro') is not null;
begin
  if auth.jwt() is not null
     and not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Triagem da Conferencia Prime e da gestao ou da rotina.' using errcode = '42501';
  end if;

  -- alvo: pendentes
  drop table if exists _tr_alvo;
  create temp table _tr_alvo on commit drop as
  select d.titulo_id, d.aluno_id, d.documento, coalesce(d.valor,0) valor, d.subgrupo, d.motivo_entrada, d.evidencia,
         d.corroboracao, d.revisao_obrigatoria, d.detectado_em,
         coalesce((d.evidencia->>'liquidado_em')::date, (d.evidencia->'prime'->>'liquidado_em')::date) liq,
         coalesce((d.evidencia->>'cpf_confere')::boolean, (d.evidencia->'prime'->>'cpf_confere')::boolean, true) cpf_confere,
         coalesce((d.evidencia->>'acordo_cancelado_no_historico')::boolean, false) acordo_cancelado_hist,
         coalesce((d.evidencia->>'pagamento_reativa_no_dia')::boolean, false) pag_no_dia_ev,
         coalesce((d.evidencia->>'no_portador_166')::boolean, (d.evidencia->>'portador_166')::boolean) m166_ev,
         d.evidencia->'reaberta_por_auditoria'->>'classe' classe_aud,
         coalesce((d.evidencia->'reaberta_por_auditoria'->>'lote_48_altos')::boolean, false) lote48
    from public.prime_conferencia_decisao d
   where d.decisao = 'PENDENTE' and (p_titulos is null or d.titulo_id = any(p_titulos));

  drop table if exists _tr_al;
  create temp table _tr_al on commit drop as
  select a.id, lpad(regexp_replace(coalesce(a.cpf,''),'\D','','g'),11,'0') cpf11, a.matricula, a.unidade,
         coalesce(nullif(a.curso_real,''), a.curso) curso, a.situacao_operacional, a.situacao_academica
    from public.alunos a where a.id in (select aluno_id from _tr_alvo);

  -- o extrato do aluno (ultima coleta de cada boleto), uma varredura so
  drop table if exists _tr_ext;
  create temp table _tr_ext on commit drop as
  select distinct on (x.boleto) x.*
    from (select lpad(regexp_replace(coalesce(e.cpf,''),'\D','','g'),11,'0') cpf11, ltrim(e.boleto,'0') boleto,
                 e.portador, e.liquidado_em, e.vencimento, e.coletado_em
            from public.prime_extrato e
           where lpad(regexp_replace(coalesce(e.cpf,''),'\D','','g'),11,'0') in (select cpf11 from _tr_al)) x
   order by x.boleto, x.coletado_em desc;

  drop table if exists _tr_ctr;
  create temp table _tr_ctr (cpf11 text, registration text, status text, valid_from date, cancelado_em date, coletado_em timestamptz) on commit drop;
  if v_tem_ctr then
    execute $q$insert into _tr_ctr select lpad(regexp_replace(coalesce(c.cpf,''),'\D','','g'),11,'0'), c.registration, c.status, c.valid_from, c.cancelado_em, c.coletado_em
                 from public.prime_contratos c where lpad(regexp_replace(coalesce(c.cpf,''),'\D','','g'),11,'0') in (select cpf11 from _tr_al)$q$;
  end if;

  -- narrativas: o que operador e financeiro escreveram sobre o aluno
  drop table if exists _tr_narr;
  create temp table _tr_narr (aluno_id text, fies boolean, isencao boolean, tranc boolean, sol_aberta boolean) on commit drop;
  insert into _tr_narr
  select m.aluno_id,
         bool_or(m.descricao ilike '%fies%'),
         bool_or(m.descricao ilike '%isen%' or m.descricao ilike '%bolsa%'),
         bool_or(m.descricao ilike '%tranc%' or m.descricao ilike '%cancel%matr%' or m.descricao ilike '%desist%'),
         false
    from public.aluno_movimentacoes m
   where m.aluno_id in (select id::text from _tr_al) and m.tipo not like 'REABERTURA%' and m.tipo not like 'TITULO_%'
   group by 1;
  insert into _tr_narr
  select s.aluno_id, bool_or(s.motivo ilike '%fies%'), bool_or(s.motivo ilike '%isen%' or s.motivo ilike '%bolsa%'),
         bool_or(s.motivo ilike '%tranc%' or s.motivo ilike '%desist%'), false
    from public.solicitacoes_confirmacao_pagamento s where s.aluno_id in (select id::text from _tr_al) group by 1;
  if v_tem_sol then
    execute $q$insert into _tr_narr
      select s.aluno_id, bool_or(s.motivo ilike '%fies%'), bool_or(s.motivo ilike '%isen%' or s.motivo ilike '%bolsa%'),
             bool_or(s.motivo ilike '%tranc%' or s.motivo ilike '%desist%'), false
        from public.solicitacoes_financeiro s where s.aluno_id in (select id::text from _tr_al) group by 1$q$;
  end if;

  -- Solicitacao financeira que conta para CRITICO: ainda ATIVA e com relacao
  -- objetiva com ESTE titulo (mesmo titulo, mesmo acordo/parcela, mesmo
  -- pagamento, ou o boleto citado no texto). Solicitacao antiga do aluno sem
  -- ligacao com a divida em conferencia nao eleva a prioridade.
  drop table if exists _tr_solrel;
  create temp table _tr_solrel on commit drop as
  select distinct t.titulo_id
    from _tr_alvo t
    join public.solicitacoes_confirmacao_pagamento s on s.aluno_id = t.aluno_id::text
   where s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')
     and (s.titulo_id = t.titulo_id
          or (s.acordo_id is not null and s.acordo_id::text in (t.evidencia->>'acordo_id', t.evidencia->'acordo_candidato'->>'acordo_id',
                                                                  t.evidencia->'acordo_composicao'->>'acordo_id', t.evidencia->'vinculo_ativo'->>'acordo_id'))
          or (s.parcela_id is not null and exists (select 1 from public.parcelas pa where pa.id = s.parcela_id
                and pa.acordo_id::text in (t.evidencia->>'acordo_id', t.evidencia->'acordo_candidato'->>'acordo_id', t.evidencia->'acordo_composicao'->>'acordo_id')))
          or (s.pagamento_id is not null and s.pagamento_id::text in (t.evidencia->>'pagamento_id', t.evidencia->>'pagamento_candidato_id'))
          or (coalesce(t.documento,'') <> '' and s.motivo ilike '%' || ltrim(t.documento,'0') || '%'));
  if v_tem_sol then
    execute $q$insert into _tr_solrel
      select distinct t.titulo_id from _tr_alvo t
        join public.solicitacoes_financeiro s on s.aluno_id = t.aluno_id::text
       where s.retorno_em is null and s.status in ('AGUARDANDO_ENVIO_FINANCEIRO','ENVIADO_FINANCEIRO')
         and coalesce(t.documento,'') <> '' and s.motivo ilike '%' || ltrim(t.documento,'0') || '%'
         and not exists (select 1 from _tr_solrel r where r.titulo_id = t.titulo_id)$q$;
  end if;

  -- CADEIA OBJETIVA (19/09, ajuste 2): pagamento so prova quando fecha a
  -- cadeia pagamento -> boleto/parcela -> acordo -> ESTE titulo (composicao
  -- documental, vinculo ou acordo_id), ou quando uma solicitacao de
  -- confirmacao traz titulo_id + pagamento_id. Mesmo CPF, mesma data, valor
  -- parecido ou "pagamento ReATIVA no dia" NAO fecham cadeia: viram candidato.
  drop table if exists _tr_cadeia;
  create temp table _tr_cadeia on commit drop as
  with pg as (
    select t.titulo_id, g.id pag_id, g.status_conciliacao, pa.acordo_id
      from _tr_alvo t join _tr_al al on al.id = t.aluno_id
      join public.pagamentos g on (g.aluno_id = t.aluno_id or lpad(regexp_replace(coalesce(g.cpf,''),'\D','','g'),11,'0') = al.cpf11)
      left join public.parcelas pa on ltrim(coalesce(pa.boleto,''),'0') = ltrim(coalesce(g.numero_parcela_completo,''),'0')
  ),
  cobre as (  -- o acordo cobre ESTE titulo de forma explicita
    select t.titulo_id, a.id acordo_id, upper(coalesce(a.status,'')) status
      from _tr_alvo t join public.acordos a on a.aluno_id = t.aluno_id
     where upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
       and (exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.titulo_id and v.acordo_id = a.id and coalesce(v.ativo,true))
            or exists (select 1 from public.acordos_titulos x where x.id = t.titulo_id and x.acordo_id = a.id)
            or exists (select 1 from public.parcelas pa where pa.acordo_id = a.id
                         and ltrim(coalesce(t.documento,''),'0') = any (select ltrim(btrim(x),'0') from unnest(string_to_array(coalesce(pa.titulos_origem,''), ',')) x)))
  )
  select t.titulo_id,
    -- pagamento fecha a cadeia
    (exists (select 1 from pg join cobre c on c.titulo_id = pg.titulo_id and c.acordo_id = pg.acordo_id where pg.titulo_id = t.titulo_id)
     or exists (select 1 from public.solicitacoes_confirmacao_pagamento s where s.titulo_id = t.titulo_id and s.pagamento_id is not null
                  and s.status not in ('CANCELADO','PAGAMENTO_REJEITADO'))
     or t.subgrupo = 'A_PAGAMENTO_COMPROVADO') pag_cadeia,
    -- acordo fecha o vinculo (ATIVO cobre; QUITADO so com dinheiro real)
    (exists (select 1 from cobre c where c.titulo_id = t.titulo_id and c.status <> 'QUITADO')
     or exists (select 1 from cobre c where c.titulo_id = t.titulo_id and c.status = 'QUITADO'
                  and coalesce((public.prime_liquidacao_acordo_pago_de_verdade(c.acordo_id)->>'suficiente')::boolean, false))
     or exists (select 1 from public.solicitacoes_confirmacao_pagamento s where s.titulo_id = t.titulo_id and (s.acordo_id is not null or s.parcela_id is not null)
                  and s.status not in ('CANCELADO','PAGAMENTO_REJEITADO'))
     or t.subgrupo = 'B_ACORDO_COMPROVADO') acordo_cadeia,
    (select count(*) from pg where pg.titulo_id = t.titulo_id) pag_qualquer,
    (select string_agg(distinct a.numero_acordo::text, ',') from public.acordos a where a.aluno_id = t.aluno_id
       and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
       and (t.liq is not null and a.criado_em::date between t.liq - 30 and t.liq + 30 or a.id::text in (t.evidencia->>'acordo_id', t.evidencia->'acordo_candidato'->>'acordo_id'))) acordos_candidatos
  from _tr_alvo t;

  drop table if exists _tr_166;
  create temp table _tr_166 (cpf11 text) on commit drop;
  if v_tem_166 then
    execute $q$insert into _tr_166 select distinct lpad(regexp_replace(m.cpf,'\D','','g'),11,'0') from public.prime_portador_membro m
                 where m.portador = 166 and lpad(regexp_replace(m.cpf,'\D','','g'),11,'0') in (select cpf11 from _tr_al)$q$;
  end if;

  drop table if exists _tr_calc;
  create temp table _tr_calc on commit drop as
  with base as (
    select t.*, al.cpf11, al.unidade, al.curso, al.situacao_operacional, al.situacao_academica,
      coalesce(nullif(al.matricula,''), (select c.registration from _tr_ctr c where c.cpf11 = al.cpf11 order by c.valid_from desc nulls last limit 1)) matricula,
      (select count(*) from _tr_alvo b where b.aluno_id = t.aluno_id) n_titulos_aluno,
      (select count(*) from public.pagamentos p where (p.aluno_id = t.aluno_id or lpad(regexp_replace(coalesce(p.cpf,''),'\D','','g'),11,'0') = al.cpf11)
          and t.liq is not null and p.data_pagamento between t.liq - 10 and t.liq + 10) pag_prox,
      (select string_agg(distinct upper(coalesce(ac.status,'')), ',') from public.acordos ac where ac.aluno_id = t.aluno_id) acordos,
      (select count(*) from _tr_ext s where s.cpf11 = al.cpf11 and s.portador in (95,160,162,9) and s.liquidado_em = t.liq) sant_md,
      (select count(*) from _tr_ext s where s.cpf11 = al.cpf11 and s.portador in (95,160,162,9) and s.liquidado_em = t.liq and s.vencimento < t.liq - 30) sant_md_venc,
      (select count(*) from _tr_ext s where s.cpf11 = al.cpf11 and s.portador = 195 and s.liquidado_em = t.liq) n195_md,
      (select count(*) from _tr_ext s where s.cpf11 = al.cpf11 and s.portador = 195) n195_tot,
      (select count(*) from _tr_ctr c where c.cpf11 = al.cpf11 and t.liq is not null and c.cancelado_em between t.liq - 7 and t.liq + 7) ctr_cancel_7d,
      (select count(*) from _tr_ctr c where c.cpf11 = al.cpf11 and c.status in ('Confirmado','Aberto') and c.valid_from >= date '2026-07-01') ctr_2026_2_vivo,
      (select count(*) from _tr_ctr c where c.cpf11 = al.cpf11 and c.status in ('Cancelado','Anulado') and c.valid_from >= date '2026-01-01') ctr_2026_cancel,
      coalesce((select bool_or(n.fies) from _tr_narr n where n.aluno_id = t.aluno_id::text), false) fies,
      coalesce((select bool_or(n.isencao) from _tr_narr n where n.aluno_id = t.aluno_id::text), false) isencao,
      coalesce((select bool_or(n.tranc) from _tr_narr n where n.aluno_id = t.aluno_id::text), false) tranc,
      exists (select 1 from _tr_solrel r where r.titulo_id = t.titulo_id) sol_aberta,
      coalesce((select k.pag_cadeia from _tr_cadeia k where k.titulo_id = t.titulo_id), false) pag_cadeia,
      coalesce((select k.acordo_cadeia from _tr_cadeia k where k.titulo_id = t.titulo_id), false) acordo_cadeia,
      coalesce((select k.acordos_candidatos from _tr_cadeia k where k.titulo_id = t.titulo_id), '') acordos_candidatos,
      coalesce(t.m166_ev, exists (select 1 from _tr_166 m where m.cpf11 = al.cpf11)) m166
    from _tr_alvo t join _tr_al al on al.id = t.aluno_id
  ),
  regras as (
    select b.*,
      (b.unidade ilike '%MEDICINA%' or b.curso ilike '%MEDICINA%') medicina,
      (coalesce(b.situacao_operacional,'') like 'COBRANCA%') aluno_em_cobranca,
      (b.subgrupo = 'A2_NAO_COBRE' or not b.cpf_confere or b.sol_aberta) divergencia,
      case
        when b.motivo_entrada = 'PRIME_LIQUIDACAO_ORIGEM_NAO_COMPROVADA' then 'NOVO_APOS_CORTE'
        when b.motivo_entrada = 'PRIME_LIQUIDADO_ORIGEM_NAO_COMPROVADA' then 'D2_OUTRA_DIVIDA'
        when b.classe_aud = 'D' and b.lote48 then 'D_LOTE_48'
        when b.classe_aud = 'D' then 'D3'
        when b.classe_aud = 'C_166' then 'C_166'
        when b.classe_aud = 'C_parcial' then 'C_PARCIAL'
        when b.subgrupo like 'A2%' then 'A2_HISTORICO'
        when b.subgrupo = 'A1' then 'A1_HISTORICO'
        else 'OUTRO' end grupo_historico,
      -- pagamento perto, pagamento ReATIVA no dia, acordo perto, A2, acordo
      -- QUITADO sem dinheiro real: CANDIDATO, nunca comprovado
      (b.pag_prox > 0 or b.corroboracao = 'PAGAMENTO_REATIVA' or b.pag_no_dia_ev or b.evidencia ? 'pagamento_candidato_id') pag_candidato,
      (b.subgrupo like 'A2%' or b.evidencia ? 'acordo_candidato' or b.evidencia ? 'acordo_composicao' or b.acordos_candidatos <> '') acordo_candidato,
      case
        when b.pag_cadeia then 'PAGAMENTO_COMPROVADO'
        when b.acordo_cadeia then 'ACORDO_COMPROVADO'
        when b.fies or b.isencao then 'FIES_ISENCAO_PROVAVEL'
        when b.ctr_cancel_7d > 0 or b.tranc or (b.ctr_2026_2_vivo = 0 and b.ctr_2026_cancel > 0) then 'CANCELAMENTO_PROVAVEL'
        when b.valor < 50 then 'RESIDUO'
        when b.pag_prox > 0 or b.corroboracao = 'PAGAMENTO_REATIVA' or b.pag_no_dia_ev or b.evidencia ? 'pagamento_candidato_id' then 'PAGAMENTO_CANDIDATO'
        when b.subgrupo like 'A2%' or b.evidencia ? 'acordo_candidato' or b.evidencia ? 'acordo_composicao' or b.acordos_candidatos <> '' then 'ACORDO_CANDIDATO'
        when (b.sant_md > 0 or (b.n195_md = b.n195_tot and b.n195_tot > 1)) and b.ctr_2026_2_vivo > 0 then 'INSTITUCIONAL_PROVAVEL'
        else 'NAO_COMPROVADA' end origem
    from base b
  ),
  prio as (
    select r.*,
      (r.revisao_obrigatoria or r.acordo_cancelado_hist or r.m166 or not r.cpf_confere or r.sol_aberta or r.aluno_em_cobranca or r.divergencia or r.pag_prox > 0) marca_risco,
      case
        when r.valor >= 5000 or (r.medicina and r.valor >= 2000) or r.aluno_em_cobranca or r.divergencia then 'CRITICO'
        when r.origem in ('CANCELAMENTO_PROVAVEL','FIES_ISENCAO_PROVAVEL') or r.tranc or r.n_titulos_aluno >= 3 then 'ALTO'
        else 'NORMAL' end prio_base
    from regras r
  )
  select p.titulo_id,
    jsonb_strip_nulls(jsonb_build_object(
      'grupo_historico', p.grupo_historico,
      'origem_provavel', p.origem,
      'prioridade', case when p.prio_base = 'NORMAL' and p.valor < 200 and not p.marca_risco then 'BAIXO' else p.prio_base end,
      'necessita_manual', p.origem not in ('PAGAMENTO_COMPROVADO','ACORDO_COMPROVADO'),
      'matricula', p.matricula, 'campus', p.unidade, 'curso', p.curso,
      'liquidado_em', p.liq,
      'motivos', (select coalesce(jsonb_agg(m), '[]'::jsonb) from (
         select x m from unnest(array[
           case when p.valor >= 5000 then 'valor >= 5.000' end,
           case when p.medicina and p.valor >= 2000 then 'Medicina >= 2.000' end,
           case when p.aluno_em_cobranca then 'aluno ainda em cobranca ('||p.situacao_operacional||')' end,
           case when p.subgrupo = 'A2_NAO_COBRE' then 'acordo na janela nao cobre' end,
           case when not p.cpf_confere then 'CPF do extrato diverge' end,
           case when p.sol_aberta then 'solicitacao financeira ativa ligada a este titulo' end,
           case when p.fies then 'narrativa: FIES' end,
           case when p.isencao then 'narrativa: isencao/bolsa' end,
           case when p.tranc then 'narrativa: trancamento/cancelamento de matricula' end,
           case when p.ctr_cancel_7d > 0 then 'contrato cancelado ate 7 dias da liquidacao' end,
           case when p.ctr_2026_2_vivo = 0 and p.ctr_2026_cancel > 0 then 'contrato 2026 cancelado/anulado, sem 2026/2 vivo' end,
           case when p.valor < 50 then 'residuo < 50' end,
           case when p.sant_md_venc > 0 then 'Santander vencidas liquidadas no mesmo dia' end,
           case when p.sant_md > 0 and p.sant_md_venc = 0 then 'Santander correntes liquidadas no mesmo dia' end,
           case when p.n195_md = p.n195_tot and p.n195_tot > 1 then 'todos os boletos 195 do aluno no mesmo dia' end,
           case when p.n_titulos_aluno >= 3 then p.n_titulos_aluno||' titulos do aluno na fila' end,
           case when p.pag_cadeia then 'cadeia pagamento -> acordo/parcela -> titulo fechada' end,
           case when p.acordo_cadeia and not p.pag_cadeia then 'acordo com vinculo/composicao que cobre este titulo' end,
           case when p.pag_candidato and not p.pag_cadeia then 'pagamento do aluno perto da data, SEM cadeia com este titulo' end,
           case when p.acordo_candidato and not p.acordo_cadeia then 'acordo do aluno ('||coalesce(nullif(p.acordos_candidatos,''),'?')||') sem vinculo comprovado com este titulo' end,
           case when p.pag_prox > 0 then 'pagamento ReATIVA ate 10 dias da liquidacao' end,
           case when p.revisao_obrigatoria or p.acordo_cancelado_hist then 'acordo cancelado no historico' end,
           case when p.m166 then 'CPF no portador 166' end
         ]) x where x is not null) z),
      'evidencias_resumo', jsonb_build_object(
        'pagamento_reativa_prox', p.pag_prox > 0, 'acordos_crm', p.acordos,
        'cadeia_pagamento', p.pag_cadeia, 'cadeia_acordo', p.acordo_cadeia,
        'pagamento_candidato', p.pag_candidato and not p.pag_cadeia, 'acordo_candidato', nullif(p.acordos_candidatos,''), 'santander_mesmo_dia', p.sant_md,
        'santander_vencidas_mesmo_dia', p.sant_md_venc, 'boletos_195_mesmo_dia', p.n195_md, 'boletos_195_total', p.n195_tot,
        'contrato_2026_2_vivo', p.ctr_2026_2_vivo > 0, 'contrato_cancelado_prox', p.ctr_cancel_7d > 0,
        'narrativa_fies', p.fies, 'narrativa_isencao', p.isencao, 'narrativa_trancamento', p.tranc,
        'solicitacao_financeira_ligada', p.sol_aberta, 'portador_166', p.m166, 'cpf_confere', p.cpf_confere,
        'titulos_do_aluno_na_fila', p.n_titulos_aluno, 'situacao_aluno', p.situacao_operacional, 'situacao_academica', p.situacao_academica),
      'versao', '2026-09-19.2')) triagem
  from prio p;

  -- A ESCRITA: so triagem e triagem_em. classe_humana* fica intacta por
  -- construcao (nao aparece no SET).
  update public.prime_conferencia_decisao d
     set triagem = c.triagem, triagem_em = now()
    from _tr_calc c where c.titulo_id = d.titulo_id;
  get diagnostics v_n = row_count;

  select jsonb_build_object('triados', v_n, 'segundos', round(extract(epoch from (clock_timestamp() - v_ini))::numeric, 2),
           'por_prioridade', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (select triagem->>'prioridade' k, count(*) n from _tr_calc group by 1) z),
           'por_origem', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (select triagem->>'origem_provavel' k, count(*) n from _tr_calc group by 1) z))
    into v_res;
  return v_res;
end;
$function$;

do $prova$
declare a record; d record; r jsonb;
begin
  r := public.prime_conferencia_triagem_recalcular(null);
  select * into a from _tri2_antes;
  select (select count(*) from public.prime_conferencia_decisao where decisao='PENDENTE') pendentes,
         (select coalesce(round(sum(valor),2),0) from public.prime_conferencia_decisao where decisao='PENDENTE') valor_pendente,
         (select md5(string_agg(titulo_id::text||decisao||coalesce(classe_humana,'')||coalesce(classe_humana_obs,'')||coalesce(classe_humana_por,'')||coalesce(classe_humana_em::text,'')||coalesce(triagem->>'prioridade',''), ',' order by titulo_id)) from public.prime_conferencia_decisao) decisoes_md5,
         (select md5(string_agg(id::text||coalesce(situacao,'')||coalesce(status,''), ',' order by id)) from public.acordos_titulos) titulos_md5,
         (select md5(string_agg(id::text||coalesce(situacao_operacional,'')||coalesce(responsavel_atual_email,''), ',' order by id)) from public.alunos) alunos_md5,
         (select count(*) from public.pagamentos) pag, (select count(*) from public.acordos) ac,
         (select count(*) from public.parcelas) parc, (select count(*) from public.acordo_titulo_vinculo) vinc
    into d;
  if to_jsonb(a) <> to_jsonb(d) then
    raise exception 'TRIAGEM2: mexeu em algo alem de origem/evidencias (antes % / depois %)', to_jsonb(a), to_jsonb(d);
  end if;
  if (r->>'triados')::int <> a.pendentes then raise exception 'TRIAGEM2: triou % de %', r->>'triados', a.pendentes; end if;
  insert into public.auditoria (usuario, acao, tabela_afetada, detalhes)
  values ('migration', 'CONFERENCIA_PRIME_TRIAGEM_CADEIA', 'prime_conferencia_decisao', r);
end
$prova$;

commit;
