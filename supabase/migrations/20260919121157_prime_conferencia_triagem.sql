-- TRIAGEM OPERACIONAL DA CONFERENCIA PRIME (19/09/2026)
--
-- Os titulos EM_CONFIRMACAO viram uma fila priorizada, pronta para decisao
-- humana. SOMENTE ORGANIZACAO: nada aqui marca PAGO, NEGOCIADO, tira de
-- EM_CONFIRMACAO, cria pagamento/acordo/parcela/vinculo, mexe em aluno, caso,
-- responsavel, saldo, honorario ou reposicao. A regra permanente de entrada
-- (20260918230000) nao e alterada.
--
-- Sem tabela nova. prime_conferencia_decisao ganha:
--   triagem / triagem_em            snapshot derivado (grupo historico, origem
--                                   provavel, prioridade, necessita_manual,
--                                   evidencias_resumo, matricula, campus, curso)
--   classe_humana (+obs/por/em)     o que a gestao viu na tela do Prime. So
--                                   registro: a decisao financeira continua
--                                   PENDENTE e segue pelas rotas oficiais.
--
-- DUAS TRAVAS:
--   1. prime_conferencia_classificar_humano so grava as 4 colunas + auditoria.
--   2. a triagem automatica (cron :55 / botao Recalcular) so grava triagem e
--      triagem_em; nunca toca classe_humana*.
--
-- Compativel com o PGlite dos testes: prime_contratos, solicitacoes_financeiro,
-- prime_portador_membro, reposicao_carteira_fila, sistema_sob_carga e pg_cron
-- so sao usados quando existem.

begin;

-- ===== 0. FOTO DE ANTES =====================================================
create temp table _tri_antes on commit drop as
select (select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='EM_CONFIRMACAO') em_conf,
       (select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='PAGO') pagos,
       (select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='NEGOCIADO') negociados,
       (select count(*) from public.prime_conferencia_decisao where decisao='PENDENTE') pendentes,
       (select coalesce(round(sum(valor),2),0) from public.prime_conferencia_decisao where decisao='PENDENTE') valor_pendente,
       (select md5(string_agg(titulo_id::text||decisao||coalesce(motivo,'')||coalesce(decidido_por,''), ',' order by titulo_id)) from public.prime_conferencia_decisao) decisoes_md5,
       (select md5(string_agg(id::text||coalesce(situacao,'')||coalesce(status,'')||coalesce(atualizado_em::text,''), ',' order by id)) from public.acordos_titulos) titulos_md5,
       (select md5(string_agg(id::text||coalesce(situacao_operacional,'')||coalesce(responsavel_atual_email,''), ',' order by id)) from public.alunos) alunos_md5,
       (select md5(string_agg(id::text||coalesce(operador_email,'')||coalesce(encerrado_operacional::text,''), ',' order by id)) from public.casos) casos_md5,
       (select count(*) from public.pagamentos) pag, (select count(*) from public.acordos) ac,
       (select count(*) from public.parcelas) parc, (select count(*) from public.acordo_titulo_vinculo) vinc;

-- ===== 1. ESTRUTURA =========================================================
alter table public.prime_conferencia_decisao
  add column if not exists triagem jsonb,
  add column if not exists triagem_em timestamptz,
  add column if not exists classe_humana text,
  add column if not exists classe_humana_obs text,
  add column if not exists classe_humana_por text,
  add column if not exists classe_humana_em timestamptz;

alter table public.prime_conferencia_decisao drop constraint if exists prime_conferencia_decisao_classe_humana_check;
alter table public.prime_conferencia_decisao add constraint prime_conferencia_decisao_classe_humana_check
  check (classe_humana is null or classe_humana = any (array['PAGAMENTO_REAL','ACORDO','LIQUIDACAO_INSTITUCIONAL',
         'CANCELAMENTO_ESTORNO','ISENCAO_FIES_BOLSA','SUBSTITUICAO_TITULO','INCONCLUSIVO']));

-- ===== 2. A TRIAGEM (snapshot) ==============================================
-- Recalcula triagem/triagem_em dos PENDENTES (todos, ou so p_titulos).
-- Nunca escreve em outra coluna nem em outra tabela.
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
      case
        when b.subgrupo = 'A_PAGAMENTO_COMPROVADO' or b.corroboracao = 'PAGAMENTO_REATIVA' or b.pag_no_dia_ev then 'PAGAMENTO_COMPROVADO'
        when b.subgrupo in ('B_ACORDO_COMPROVADO','A2_COBRE') then 'ACORDO_COMPROVADO'
        when b.fies or b.isencao then 'FIES_ISENCAO_PROVAVEL'
        when b.ctr_cancel_7d > 0 or b.tranc or (b.ctr_2026_2_vivo = 0 and b.ctr_2026_cancel > 0) then 'CANCELAMENTO_PROVAVEL'
        when b.valor < 50 then 'RESIDUO'
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
           case when p.pag_prox > 0 then 'pagamento ReATIVA ate 10 dias da liquidacao' end,
           case when p.revisao_obrigatoria or p.acordo_cancelado_hist then 'acordo cancelado no historico' end,
           case when p.m166 then 'CPF no portador 166' end
         ]) x where x is not null) z),
      'evidencias_resumo', jsonb_build_object(
        'pagamento_reativa_prox', p.pag_prox > 0, 'acordos_crm', p.acordos, 'santander_mesmo_dia', p.sant_md,
        'santander_vencidas_mesmo_dia', p.sant_md_venc, 'boletos_195_mesmo_dia', p.n195_md, 'boletos_195_total', p.n195_tot,
        'contrato_2026_2_vivo', p.ctr_2026_2_vivo > 0, 'contrato_cancelado_prox', p.ctr_cancel_7d > 0,
        'narrativa_fies', p.fies, 'narrativa_isencao', p.isencao, 'narrativa_trancamento', p.tranc,
        'solicitacao_financeira_ligada', p.sol_aberta, 'portador_166', p.m166, 'cpf_confere', p.cpf_confere,
        'titulos_do_aluno_na_fila', p.n_titulos_aluno, 'situacao_aluno', p.situacao_operacional, 'situacao_academica', p.situacao_academica),
      'versao', '2026-09-19.1')) triagem
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

-- ===== 3. CLASSE HUMANA (so registro) =======================================
create or replace function public.prime_conferencia_classificar_humano(p_titulo_id uuid, p_classe text, p_obs text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_obs text := nullif(btrim(coalesce(p_obs,'')), '');
  v_dec public.prime_conferencia_decisao%rowtype;
begin
  if not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Classificar na Conferencia Prime e da gestao.' using errcode = '42501';
  end if;
  if p_classe is null or p_classe not in ('PAGAMENTO_REAL','ACORDO','LIQUIDACAO_INSTITUCIONAL','CANCELAMENTO_ESTORNO',
                                          'ISENCAO_FIES_BOLSA','SUBSTITUICAO_TITULO','INCONCLUSIVO') then
    raise exception 'CLASSE_INVALIDA: %', coalesce(p_classe, 'nula');
  end if;
  if length(coalesce(v_obs,'')) < 10 then
    raise exception 'MOTIVO_OBRIGATORIO: escreva o que apareceu no Prime (minimo 10 caracteres).';
  end if;
  select * into v_dec from public.prime_conferencia_decisao where titulo_id = p_titulo_id for update;
  if not found then raise exception 'TITULO_NAO_ENCONTRADO'; end if;
  if v_dec.decisao <> 'PENDENTE' then
    raise exception 'SEM_DECISAO_PENDENTE: este titulo ja foi decidido (%).', v_dec.decisao;
  end if;

  -- SO ISTO. Nenhuma outra coluna, nenhuma outra tabela alem da auditoria.
  update public.prime_conferencia_decisao
     set classe_humana = p_classe, classe_humana_obs = v_obs,
         classe_humana_por = nullif(v_email,''), classe_humana_em = now()
   where titulo_id = p_titulo_id;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (coalesce(nullif(v_email,''),'gestao'), 'CONFERENCIA_PRIME_CLASSE_HUMANA', 'prime_conferencia_decisao', p_titulo_id,
          jsonb_build_object('classe', p_classe, 'obs', v_obs, 'classe_anterior', v_dec.classe_humana,
                             'decisao', v_dec.decisao, 'sem_efeito_financeiro', true));

  return jsonb_build_object('ok', true, 'titulo_id', p_titulo_id, 'classe_humana', p_classe,
                            'decisao', 'PENDENTE', 'efeito_financeiro', 'nenhum');
end;
$function$;

-- ===== 4. A FILA (mesma RPC, colunas a mais) ================================
drop function if exists public.prime_conferencia_fila();
create function public.prime_conferencia_fila()
 returns table(titulo_id uuid, aluno_id uuid, aluno_nome text, cpf text, documento text, vencimento date, valor numeric,
               liquidado_em date, portador integer, corroboracao text, subgrupo text, acordo_id uuid, acordo_numero text,
               acordo_status text, razao numeric, revisao_obrigatoria boolean, operador_responsavel text,
               outras_dividas boolean, detectado_em timestamp with time zone, evidencia jsonb,
               classificacao text, motivo_entrada text,
               matricula text, campus text, curso text, grupo_historico text, origem_provavel text, prioridade text,
               necessita_manual boolean, dias_pendente integer, triagem jsonb, triagem_em timestamp with time zone,
               classe_humana text, classe_humana_obs text, classe_humana_por text, classe_humana_em timestamp with time zone)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not coalesce(public.usuario_e_gestao(), false) and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Conferencia Prime e decisao da gestao.' using errcode = '42501';
  end if;
  return query
  select d.titulo_id, d.aluno_id, al.nome, d.cpf, d.documento, t.vencimento, d.valor,
         coalesce((d.evidencia->>'liquidado_em')::date, (d.evidencia->'prime'->>'liquidado_em')::date),
         coalesce((d.evidencia->>'portador')::int, (d.evidencia->'prime'->>'portador')::int),
         d.corroboracao, d.subgrupo, d.acordo_id, d.acordo_numero, ac.status,
         (d.evidencia->>'razao_acordo_lote')::numeric, d.revisao_obrigatoria,
         al.responsavel_atual_email,
         not public.caso_aguarda_confirmacao_financeira(d.aluno_id),
         d.detectado_em, d.evidencia,
         coalesce(d.evidencia->>'classificacao', case when d.subgrupo like 'A%' then 'GRUPO_A_HISTORICO' end),
         d.motivo_entrada,
         coalesce(d.triagem->>'matricula', al.matricula), coalesce(d.triagem->>'campus', al.unidade),
         coalesce(d.triagem->>'curso', al.curso_real, al.curso),
         d.triagem->>'grupo_historico', d.triagem->>'origem_provavel', d.triagem->>'prioridade',
         coalesce((d.triagem->>'necessita_manual')::boolean, true),
         greatest(0, (current_date - d.detectado_em::date))::int,
         d.triagem, d.triagem_em, d.classe_humana, d.classe_humana_obs, d.classe_humana_por, d.classe_humana_em
    from public.prime_conferencia_decisao d
    join public.acordos_titulos t on t.id = d.titulo_id
    left join public.alunos al on al.id = d.aluno_id
    left join public.acordos ac on ac.id = d.acordo_id
   where d.decisao = 'PENDENTE'
   order by case d.triagem->>'prioridade' when 'CRITICO' then 0 when 'ALTO' then 1 when 'NORMAL' then 2 when 'BAIXO' then 3 else 4 end,
            d.valor desc, d.titulo_id;
end;
$function$;

-- ===== 5. PAINEL ============================================================
create or replace function public.prime_conferencia_painel()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_corte timestamptz; v_res jsonb;
begin
  if not coalesce(public.usuario_e_gestao(), false) and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Painel da Conferencia Prime e da gestao.' using errcode = '42501';
  end if;
  select max(ativado_em) into v_corte from public.prime_liquidacao_regra;
  with p as (select d.*, current_date - d.detectado_em::date dias from public.prime_conferencia_decisao d where d.decisao = 'PENDENTE'),
  cnt as (select k, n from (
      select 'origem:'||coalesce(triagem->>'origem_provavel','SEM_TRIAGEM') k, count(*) n from p group by 1
      union all select 'prioridade:'||coalesce(triagem->>'prioridade','SEM_TRIAGEM'), count(*) from p group by 1
      union all select 'campus:'||coalesce(triagem->>'campus','-'), count(*) from p group by 1
      union all select 'grupo:'||coalesce(triagem->>'grupo_historico','-'), count(*) from p group by 1
      union all select 'classe_humana:'||coalesce(classe_humana,'-'), count(*) from p group by 1) z)
  select jsonb_build_object(
    'total', (select count(*) from p), 'valor', (select coalesce(round(sum(valor),2),0) from p),
    'alunos', (select count(distinct aluno_id) from p),
    'novos_apos_corte', (select count(*) from p where motivo_entrada = 'PRIME_LIQUIDACAO_ORIGEM_NAO_COMPROVADA'),
    'historicos', (select count(*) from p where motivo_entrada is distinct from 'PRIME_LIQUIDACAO_ORIGEM_NAO_COMPROVADA'),
    'resolvidos_hoje', (select count(*) from public.prime_conferencia_decisao d where d.decisao <> 'PENDENTE' and d.decidido_em::date = current_date),
    'classificados_hoje', (select count(*) from p where classe_humana_em::date = current_date),
    'com_classe_humana', (select count(*) from p where classe_humana is not null),
    'necessita_manual', (select count(*) from p where coalesce((triagem->>'necessita_manual')::boolean, true)),
    'pendentes_mais_1_dia', (select count(*) from p where dias > 1),
    'pendentes_mais_3_dias', (select count(*) from p where dias > 3),
    'pendentes_mais_7_dias', (select count(*) from p where dias > 7),
    'sem_triagem', (select count(*) from p where triagem is null),
    'triagem_em', (select max(triagem_em) from p),
    'corte', v_corte,
    'por_origem', (select coalesce(jsonb_object_agg(substr(k, 8), n), '{}'::jsonb) from cnt where k like 'origem:%'),
    'por_prioridade', (select coalesce(jsonb_object_agg(substr(k, 12), n), '{}'::jsonb) from cnt where k like 'prioridade:%'),
    'por_campus', (select coalesce(jsonb_object_agg(substr(k, 8), n), '{}'::jsonb) from cnt where k like 'campus:%'),
    'por_grupo', (select coalesce(jsonb_object_agg(substr(k, 7), n), '{}'::jsonb) from cnt where k like 'grupo:%'),
    'por_classe_humana', (select coalesce(jsonb_object_agg(substr(k, 15), n), '{}'::jsonb) from cnt where k like 'classe_humana:%'))
  into v_res;
  return v_res;
end;
$function$;

-- ===== 6. FICHA DE DECISAO ==================================================
create or replace function public.prime_conferencia_ficha(p_titulo_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_d record; v_cpf11 text; v_liq date; v_ctr jsonb := '[]'::jsonb; v_sol jsonb := '[]'::jsonb; v_res jsonb;
begin
  if not coalesce(public.usuario_e_gestao(), false) and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Ficha da Conferencia Prime e da gestao.' using errcode = '42501';
  end if;
  select d.*, t.vencimento, t.situacao situacao_titulo, t.status status_titulo, t.created_at::date importado_em,
         al.nome, al.matricula, al.unidade, coalesce(nullif(al.curso_real,''), al.curso) curso, al.situacao_operacional,
         al.situacao_academica, al.responsavel_atual_email, al.cpf cpf_aluno,
         lpad(regexp_replace(coalesce(al.cpf,''),'\D','','g'),11,'0') cpf11
    into v_d
    from public.prime_conferencia_decisao d
    join public.acordos_titulos t on t.id = d.titulo_id
    left join public.alunos al on al.id = d.aluno_id
   where d.titulo_id = p_titulo_id;
  if not found then return null; end if;
  v_cpf11 := v_d.cpf11;
  v_liq := coalesce((v_d.evidencia->>'liquidado_em')::date, (v_d.evidencia->'prime'->>'liquidado_em')::date);

  if to_regclass('public.prime_contratos') is not null then
    execute $q$select coalesce(jsonb_agg(jsonb_build_object('registration', c.registration, 'status', c.status, 'tipo', c.tipo, 'turno', c.turno,
                 'campus', c.campus, 'curso', c.curso, 'valid_from', c.valid_from, 'valid_to', c.valid_to, 'cancelado_em', c.cancelado_em)
                 order by c.valid_from desc), '[]'::jsonb)
                 from public.prime_contratos c where lpad(regexp_replace(coalesce(c.cpf,''),'\D','','g'),11,'0') = $1$q$
      into v_ctr using v_cpf11;
  end if;
  if to_regclass('public.solicitacoes_financeiro') is not null then
    execute $q$select coalesce(jsonb_agg(jsonb_build_object('tipo', 'financeiro', 'em', s.criado_em, 'status', s.status, 'motivo', left(s.motivo, 300),
                 'retorno', left(s.retorno_financeiro, 300)) order by s.criado_em desc), '[]'::jsonb)
                 from public.solicitacoes_financeiro s where s.aluno_id = $1$q$
      into v_sol using v_d.aluno_id::text;
  end if;

  select jsonb_build_object(
    'titulo', jsonb_build_object('titulo_id', v_d.titulo_id, 'documento', v_d.documento, 'vencimento', v_d.vencimento, 'valor', v_d.valor,
       'situacao', v_d.situacao_titulo, 'status', v_d.status_titulo, 'importado_em', v_d.importado_em),
    'aluno', jsonb_build_object('aluno_id', v_d.aluno_id, 'nome', v_d.nome, 'cpf', v_d.cpf_aluno,
       'matricula', coalesce(v_d.triagem->>'matricula', v_d.matricula), 'campus', v_d.unidade, 'curso', v_d.curso,
       'situacao_operacional', v_d.situacao_operacional, 'situacao_academica', v_d.situacao_academica,
       'responsavel', v_d.responsavel_atual_email),
    'decisao', jsonb_build_object('decisao', v_d.decisao, 'subgrupo', v_d.subgrupo, 'motivo_entrada', v_d.motivo_entrada,
       'corroboracao', v_d.corroboracao, 'revisao_obrigatoria', v_d.revisao_obrigatoria, 'detectado_em', v_d.detectado_em,
       'triagem', v_d.triagem, 'triagem_em', v_d.triagem_em, 'classe_humana', v_d.classe_humana,
       'classe_humana_obs', v_d.classe_humana_obs, 'classe_humana_por', v_d.classe_humana_por, 'classe_humana_em', v_d.classe_humana_em),
    'evidencias', public.prime_liquidacao_evidencias(p_titulo_id),
    'contratos', v_ctr,
    'mesmo_evento', (select coalesce(jsonb_agg(jsonb_build_object('boleto', x.boleto, 'portador', x.portador, 'portador_nome', x.portador_nome,
        'vencimento', x.vencimento, 'valor_bruto', x.valor_bruto, 'valor_pago', x.valor_pago) order by x.portador, x.vencimento), '[]'::jsonb)
      from (select distinct on (e.boleto) e.* from public.prime_extrato e
             where lpad(regexp_replace(coalesce(e.cpf,''),'\D','','g'),11,'0') = v_cpf11 and e.liquidado_em = v_liq
               and ltrim(e.boleto,'0') <> ltrim(coalesce(v_d.documento,''),'0')
             order by e.boleto, e.coletado_em desc) x),
    'outros_na_fila', (select coalesce(jsonb_agg(jsonb_build_object('titulo_id', o.titulo_id, 'documento', o.documento, 'valor', o.valor,
        'liquidado_em', coalesce((o.evidencia->>'liquidado_em')::date, (o.evidencia->'prime'->>'liquidado_em')::date),
        'prioridade', o.triagem->>'prioridade', 'origem_provavel', o.triagem->>'origem_provavel', 'classe_humana', o.classe_humana)), '[]'::jsonb)
      from public.prime_conferencia_decisao o where o.aluno_id = v_d.aluno_id and o.decisao = 'PENDENTE' and o.titulo_id <> p_titulo_id),
    'narrativas', (select coalesce(jsonb_agg(jsonb_build_object('em', m.registrado_em, 'tipo', m.tipo, 'por', m.registrado_por_email,
        'texto', left(m.descricao, 300)) order by m.registrado_em desc), '[]'::jsonb)
      from (select * from public.aluno_movimentacoes m where m.aluno_id = v_d.aluno_id::text
              and m.tipo not in ('REDISTRIBUICAO_SINCRONIZACAO','ACAO_MASSIVA_EXTERNA','ACAO_MASSIVA_EXTERNA_EMAIL')
             order by m.registrado_em desc limit 15) m),
    'solicitacoes', v_sol || (select coalesce(jsonb_agg(jsonb_build_object('tipo', 'confirmacao_pagamento', 'em', s.criado_em, 'status', s.status,
        'motivo', left(s.motivo, 300), 'retorno', left(s.observacao_adm, 300)) order by s.criado_em desc), '[]'::jsonb)
      from public.solicitacoes_confirmacao_pagamento s where s.aluno_id = v_d.aluno_id::text))
  into v_res;
  return v_res;
end;
$function$;

-- ===== 7. PERMISSOES ========================================================
grant execute on function public.prime_conferencia_triagem_recalcular(uuid[]) to authenticated, service_role;
grant execute on function public.prime_conferencia_classificar_humano(uuid, text, text) to authenticated, service_role;
grant execute on function public.prime_conferencia_fila() to authenticated, service_role;
grant execute on function public.prime_conferencia_painel() to authenticated, service_role;
grant execute on function public.prime_conferencia_ficha(uuid) to authenticated, service_role;

-- ===== 8. CRON :55 (separado da regra permanente) ===========================
do $liga$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'prime_conferencia_triagem_hora';
    perform cron.schedule('prime_conferencia_triagem_hora', '55 * * * *', $job$
  do $inner$
  declare v_carga jsonb;
  begin
    v_carga := public.sistema_sob_carga();
    if coalesce((v_carga->>'sob_carga')::boolean, false) then return; end if;
    perform public.prime_conferencia_triagem_recalcular(null);
  end
  $inner$;
  $job$);
  end if;
end
$liga$;

-- ===== 9. PRIMEIRA TRIAGEM + PROVA DE "NADA MUDOU" ==========================
do $prova$
declare a record; d record; r jsonb;
begin
  r := public.prime_conferencia_triagem_recalcular(null);
  select * into a from _tri_antes;
  select (select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='EM_CONFIRMACAO') em_conf,
         (select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='PAGO') pagos,
         (select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='NEGOCIADO') negociados,
         (select count(*) from public.prime_conferencia_decisao where decisao='PENDENTE') pendentes,
         (select coalesce(round(sum(valor),2),0) from public.prime_conferencia_decisao where decisao='PENDENTE') valor_pendente,
         (select md5(string_agg(titulo_id::text||decisao||coalesce(motivo,'')||coalesce(decidido_por,''), ',' order by titulo_id)) from public.prime_conferencia_decisao) decisoes_md5,
         (select md5(string_agg(id::text||coalesce(situacao,'')||coalesce(status,'')||coalesce(atualizado_em::text,''), ',' order by id)) from public.acordos_titulos) titulos_md5,
         (select md5(string_agg(id::text||coalesce(situacao_operacional,'')||coalesce(responsavel_atual_email,''), ',' order by id)) from public.alunos) alunos_md5,
         (select md5(string_agg(id::text||coalesce(operador_email,'')||coalesce(encerrado_operacional::text,''), ',' order by id)) from public.casos) casos_md5,
         (select count(*) from public.pagamentos) pag, (select count(*) from public.acordos) ac,
         (select count(*) from public.parcelas) parc, (select count(*) from public.acordo_titulo_vinculo) vinc
    into d;
  if to_jsonb(a) <> to_jsonb(d) then
    raise exception 'TRIAGEM: a migration mexeu em algo alem de triagem (antes % / depois %)', to_jsonb(a), to_jsonb(d);
  end if;
  if (r->>'triados')::int <> a.pendentes then
    raise exception 'TRIAGEM: triou % de % pendentes', r->>'triados', a.pendentes;
  end if;
  if exists (select 1 from public.prime_conferencia_decisao where classe_humana is not null) then
    raise exception 'TRIAGEM: classe_humana nao pode existir na primeira triagem';
  end if;
  insert into public.auditoria (usuario, acao, tabela_afetada, detalhes)
  values ('migration', 'CONFERENCIA_PRIME_TRIAGEM_INICIAL', 'prime_conferencia_decisao', r);
end
$prova$;

commit;
