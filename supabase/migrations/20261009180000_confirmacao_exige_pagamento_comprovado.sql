-- CONFIRMACAO DE PAGAMENTO EXIGE PAGAMENTO COMPROVADO.
--
-- Pedido da gestao em 09/10/2026, em cinco regras. Esta migration cobre as
-- regras 1, 2, 3 e 5; a regra 4 (triagem dos 301 retroativos e o saneamento que
-- ela autoriza) esta em
-- supabase/aguardando_aprovacao/20261009_TRIAGEM_E_SANEAMENTO_confirmacao.sql.pendente,
-- e a medicao inteira em
-- docs/CONFIRMACAO-EXIGE-PAGAMENTO-COMPROVADO-2026-10-09.md.
--
-- FONTE DE VERDADE CONSULTADA ANTES (obrigatorio por CLAUDE.md):
-- docs/integracoes/README.md -> prime-mapa-fontes-verdade.md -> prime-api.md.
-- O que elas ja diziam, medido em 28/09/2026 e nao usado pela regra de 18/09:
--
--   * `financialStatement[].paymentDate` -- que vira `prime_extrato.liquidado_em`
--     -- "vem preenchido em ~100% das linhas do portador 195, INCLUSIVE em
--     titulos que o CRM mantem ABERTO" (0 de 302.477 nulos no portador 95).
--     "Nao inferir: presenca de `paymentDate` = pagamento";
--   * `paidAmount` -- que vira `prime_extrato.valor_pago` -- e "divida
--     corrigida na data da consulta, NAO e caixa; pode superar o valor pago
--     real" (no portador 95 aparece como o dobro exato do principal);
--   * "Caixa efetivamente recebido: **Santander**, NUNCA `paidAmount` da Prime";
--   * "Mensalidade liquidada (portador 195): CONDICIONAL -- nunca `paymentDate`
--     isolado".
--
-- REGRA 1 -- importacao de titulo, saldo atualizado e `liquidado_em` sem
-- comprovacao nao geram confirmacao isoladamente.
--   `prime_liquidacao_classificar_novas`, subgrupo `C_SEM_PROVA`, deixa de
--   chamar `prime_liquidacao_suspender`: a classificacao continua gravada em
--   `prime_liquidacao_classificacao` (a trilha de evidencia nao se perde) e o
--   titulo continua ABERTO/NEGOCIADO, com o valor que tinha. Nenhum
--   `prime_conferencia_decisao` PENDENTE novo nasce por essa rota.
--
-- REGRAS 2 e 3 -- pagamento comprovado continua protegido, Rota B preservada.
--   ROTA A (`A_PAGAMENTO_COMPROVADO`) e ROTA B (`B_ACORDO_COMPROVADO`) seguem
--   suspendendo e entrando na fila, BYTE A BYTE como antes: titulo com
--   pagamento provado continua fora da cobranca. Nada nelas foi tocado.
--
-- REGRA 5 -- a interpretacao de `valor_pago` e das datas da Prime.
--   `valor_pago` nunca foi prova nesta regra (a unica mencao e o `aviso` da
--   evidencia); agora a evidencia declara isso em campo proprio
--   (`valor_pago_e_divida_corrigida`). O que FALTAVA e entra aqui e a GUARDA DE
--   DATA, nos dois lugares que decidem:
--     - na elegibilidade de `prime_liquidacao_classificar_novas`;
--     - em `liquidacao_real`, dentro de `prime_liquidacao_evidencias`;
--   `liquidado_em` POSTERIOR a coleta (`coletado_em`) ou no FUTURO nao pode ser
--   pagamento ocorrido -- e `paymentDate` de parcela que ainda vai vencer. A
--   evidencia tambem passa a expor `liquidado_depois_da_coleta`.
--
-- EXPOSICAO DA GUARDA, MEDIDA EM PRODUCAO (09/10/2026, leitura):
--   * a coleta do extrato de 09/10 trouxe 20.838 linhas, 5 delas com
--     `liquidado_em` NO FUTURO (ate 05/12/2026);
--   * dos 3.058 titulos vivos que hoje casam com a forma "liquidacao real" da
--     regra, **0** seriam barrados pela guarda, e dos 301 PENDENTE
--     `C_SEM_PROVA`, **0** tem `liquidado_em` depois da coleta.
--   Ou seja: a guarda e PREVENTIVA, nao reclassifica nada hoje. Esta dito aqui
--   para ninguem procurar um efeito que ela nao tem.
--
-- O QUE NAO MUDA: `prime_liquidacao_suspender`,
-- `prime_liquidacao_reavaliar_pendentes`, a Conferencia Prime, a Fila
-- Confirmacao de Pagamento, `trg_pagamentos_gerar_confirmacao`, saldo, parcela,
-- acordo, pagamento, baixa, honorario, responsavel e reposicao.
--
-- OS 301 JA NA FILA NAO SAO TOCADOS AQUI. Esta migration e so DDL; a trava do
-- fim confere que nenhuma contagem de dado mudou.
--
-- CONSEQUENCIA ASSUMIDA: liquidacao da Prime sem prova volta a ficar dentro do
-- saldo cobravel. Era o que a regra de 18/09 tirava. O risco troca de lado --
-- menos confirmacao indevida, mais chance de cobrar quem pagou por fora do
-- extrato -- e e por isso que a regra 4 da gestao exige validar evidencia antes
-- de devolver qualquer titulo que JA esta na fila.
--
-- Rollback: supabase/rollbacks/20261009180000_confirmacao_exige_pagamento_comprovado.rollback.sql
-- (restaura as duas funcoes com o texto de producao: md5(prosrc)
-- b614689e6947d73f0d884a3bb0c28c61 e 4840e523762f189f03c0173f14233493).

begin;

-- ===== 0. FOTO DE ANTES =====================================================
create temp table _cepc_antes on commit drop as
select (select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='EM_CONFIRMACAO') em_conf,
       (select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='PAGO') pagos,
       (select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='NEGOCIADO') negociados,
       (select count(*) from public.prime_conferencia_decisao where decisao='PENDENTE') pendentes,
       (select count(*) from public.prime_liquidacao_classificacao) classificacoes,
       (select count(*) from public.solicitacoes_confirmacao_pagamento) solicitacoes,
       (select count(*) from public.pagamentos) pag,
       (select count(*) from public.parcelas) parc,
       (select count(*) from public.acordos) ac,
       (select count(*) from public.acordo_titulo_vinculo) vinc,
       (select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='prime_liquidacao_classificar_novas') md5_cn,
       (select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='prime_liquidacao_evidencias') md5_ev,
       (select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='prime_liquidacao_suspender') md5_sus,
       (select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.proname='prime_liquidacao_reavaliar_pendentes') md5_reav;

-- As duas funcoes que saem tem de ser as de producao. Se nao forem, alguem
-- mexeu no meio do caminho e esta migration para em vez de sobrescrever.
do $$
declare a record;
begin
  select * into a from _cepc_antes;
  if a.md5_cn is distinct from 'b614689e6947d73f0d884a3bb0c28c61' then
    raise exception 'prime_liquidacao_classificar_novas nao esta na definicao esperada (md5 %)', a.md5_cn;
  end if;
  if a.md5_ev is distinct from '4840e523762f189f03c0173f14233493' then
    raise exception 'prime_liquidacao_evidencias nao esta na definicao esperada (md5 %)', a.md5_ev;
  end if;
end $$;

-- ===== 1. A EVIDENCIA: GUARDA DE DATA (regra 5) =============================
create or replace function public.prime_liquidacao_evidencias(p_titulo_id uuid)
 returns jsonb
 language plpgsql
 stable
 set search_path to 'public'
as $function$
declare
  v_t record; v_ex record; v_comp record; v_cand record; v_vinc record;
  v_pag jsonb; v_pag_cobre boolean := false; v_pag_id uuid; v_pag_status text;
  v_acordo_pago jsonb := null; v_m166 boolean := null; v_canc boolean;
  v_valor numeric; v_cpf_a text;
begin
  select t.id, t.aluno_id, t.documento, t.vencimento, t.created_at::date as imp, t.situacao, t.status, t.acordo_id,
         coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as v,
         lpad(regexp_replace(coalesce(al.cpf,''),'\D','','g'),11,'0') as cpf_a
    into v_t
    from public.acordos_titulos t left join public.alunos al on al.id = t.aluno_id
   where t.id = p_titulo_id;
  if not found then return null; end if;
  v_valor := v_t.v; v_cpf_a := v_t.cpf_a;

  select e.liquidado_em, e.portador, e.valor_bruto, e.valor_pago, e.coletado_em,
         lpad(regexp_replace(coalesce(e.cpf,''),'\D','','g'),11,'0') as cpf_p
    into v_ex
    from public.prime_extrato e
   where ltrim(e.boleto,'0') = ltrim(coalesce(v_t.documento,''),'0')
   order by e.coletado_em desc limit 1;

  -- pagamento ReATIVA perto da liquidacao (ate 10 dias), o mais proximo primeiro
  select jsonb_agg(jsonb_build_object('pagamento_id', p.id, 'data', p.data_pagamento, 'valor', p.valor_pago,
           'base', round(p.valor_pago / 1.08, 2), 'status_conciliacao', p.status_conciliacao,
           'boleto', p.numero_parcela_completo,
           'cobre_o_titulo', round(p.valor_pago / 1.08, 2) >= 0.95 * v_valor) order by abs(p.data_pagamento - v_ex.liquidado_em), p.id)
    into v_pag
    from (select * from public.pagamentos p
           where (p.aluno_id = v_t.aluno_id or lpad(regexp_replace(coalesce(p.cpf,''),'\D','','g'),11,'0') = v_cpf_a)
             and v_ex.liquidado_em is not null
             and p.data_pagamento between v_ex.liquidado_em - 10 and v_ex.liquidado_em + 10
           order by abs(p.data_pagamento - v_ex.liquidado_em), p.id limit 5) p;
  if v_pag is not null and jsonb_array_length(v_pag) > 0 then
    v_pag_id := (v_pag->0->>'pagamento_id')::uuid;
    v_pag_status := v_pag->0->>'status_conciliacao';
    v_pag_cobre := coalesce((v_pag->0->>'cobre_o_titulo')::boolean, false);
  end if;

  -- vinculo ativo com acordo nao cancelado
  select v.acordo_id, a.numero_acordo, upper(coalesce(a.status,'')) as status
    into v_vinc
    from public.acordo_titulo_vinculo v join public.acordos a on a.id = v.acordo_id
   where v.titulo_id = v_t.id and coalesce(v.ativo, true)
     and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')
   limit 1;

  -- composicao documental: o boleto esta listado em parcelas.titulos_origem
  -- de um acordo ATIVO/QUITADO do mesmo aluno
  select a.id, a.numero_acordo, upper(coalesce(a.status,'')) as status, a.valor_total, a.criado_em::date as criado,
         pa.id as parcela_id, pa.numero as parcela_numero, upper(coalesce(pa.status,'')) as parcela_status
    into v_comp
    from public.parcelas pa join public.acordos a on a.id = pa.acordo_id
   where a.aluno_id = v_t.aluno_id
     and upper(coalesce(a.status,'')) in ('ATIVO','QUITADO')
     and ltrim(coalesce(v_t.documento,''),'0') = any (
           select ltrim(btrim(x),'0') from unnest(string_to_array(coalesce(pa.titulos_origem,''), ',')) x)
   order by a.criado_em desc, pa.numero limit 1;
  if v_comp.id is not null then
    v_acordo_pago := public.prime_liquidacao_acordo_pago_de_verdade(v_comp.id);
  end if;

  -- acordo perto da data, SEM composicao: e so candidato -- gente decide
  select a.id, a.numero_acordo, upper(coalesce(a.status,'')) as status, a.valor_total, a.criado_em::date as criado
    into v_cand
    from public.acordos a
   where a.aluno_id = v_t.aluno_id and upper(coalesce(a.status,'')) in ('ATIVO','QUITADO')
     and v_ex.liquidado_em is not null
     and a.criado_em::date between v_ex.liquidado_em - 30 and v_ex.liquidado_em + 30
     and (v_comp.id is null or a.id <> v_comp.id)
   order by abs(a.criado_em::date - v_ex.liquidado_em), a.id limit 1;

  select exists (select 1 from public.acordos a where a.aluno_id = v_t.aluno_id
                   and upper(coalesce(a.status,'')) in ('CANCELADO','CANCELADA')) into v_canc;

  if to_regclass('public.prime_portador_membro') is not null then
    execute 'select exists (select 1 from public.prime_portador_membro m where m.portador = 166 and lpad(regexp_replace(m.cpf, ''\D'', '''', ''g''), 11, ''0'') = $1)'
      into v_m166 using v_cpf_a;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'titulo_id', v_t.id, 'aluno_id', v_t.aluno_id, 'documento', v_t.documento, 'vencimento', v_t.vencimento,
    'importado_em', v_t.imp, 'valor_titulo', round(v_valor,2), 'situacao_atual', v_t.situacao,
    'prime', case when v_ex.liquidado_em is null and v_ex.portador is null then null else jsonb_build_object(
       'liquidado_em', v_ex.liquidado_em, 'portador', v_ex.portador, 'valor_bruto', v_ex.valor_bruto,
       'valor_pago', v_ex.valor_pago, 'coletado_em', v_ex.coletado_em, 'cpf_confere', (v_ex.cpf_p = v_cpf_a),
       -- 09/10/2026: a mesma guarda de data da rotina de entrada. `liquidado_em`
       -- depois da coleta, ou no futuro, nao e pagamento ocorrido.
       'liquidacao_real', (v_ex.liquidado_em is not null and v_ex.liquidado_em > v_t.vencimento + 30
                           and v_ex.liquidado_em >= v_t.imp and v_ex.liquidado_em <> v_t.imp
                           and v_ex.liquidado_em <= v_ex.coletado_em::date
                           and v_ex.liquidado_em <= current_date),
       'liquidado_depois_da_coleta', (v_ex.liquidado_em is not null
                                      and v_ex.liquidado_em > v_ex.coletado_em::date),
       'valor_pago_e_divida_corrigida', true) end,
    'evidencia_chave', public.prime_liquidacao_chave(v_t.documento, v_ex.liquidado_em, v_ex.portador),
    'pagamentos_proximos', coalesce(v_pag, '[]'::jsonb),
    'pagamento_candidato_id', v_pag_id, 'pagamento_candidato_status', v_pag_status, 'pagamento_cobre_o_titulo', v_pag_cobre,
    'vinculo_ativo', case when v_vinc.acordo_id is null then null else jsonb_build_object(
       'acordo_id', v_vinc.acordo_id, 'numero', v_vinc.numero_acordo, 'status', v_vinc.status) end,
    'acordo_composicao', case when v_comp.id is null then null else jsonb_build_object(
       'acordo_id', v_comp.id, 'numero', v_comp.numero_acordo, 'status', v_comp.status, 'valor_total', v_comp.valor_total,
       'criado_em', v_comp.criado, 'parcela_id', v_comp.parcela_id, 'parcela_numero', v_comp.parcela_numero,
       'parcela_status', v_comp.parcela_status, 'pago_de_verdade', v_acordo_pago) end,
    'acordo_candidato', case when v_cand.id is null then null else jsonb_build_object(
       'acordo_id', v_cand.id, 'numero', v_cand.numero_acordo, 'status', v_cand.status, 'valor_total', v_cand.valor_total,
       'criado_em', v_cand.criado) end,
    'acordo_cancelado_no_historico', v_canc,
    'no_portador_166', v_m166,
    'aviso', 'valor_pago da Prime e divida corrigida, nao caixa; portador e data nao provam pagamento'));
end;
$function$;
-- ===== 2. A ROTINA DE ENTRADA: C_SEM_PROVA NAO SUSPENDE (regras 1, 2, 3) ====
create or replace function public.prime_liquidacao_classificar_novas(p_limite int default 500, p_aplicar boolean default true)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '300s'
as $function$
declare
  v_quem   text := coalesce(nullif(lower(coalesce(auth.jwt() ->> 'email','')),''), 'prime_liquidacao@rotina');
  v_corte  timestamptz;
  v_ligado boolean := true;
  r        record;
  v_ev     jsonb; v_class text; v_nivel text; v_motivo text; v_sub text;
  v_pag uuid; v_ac uuid; v_res jsonb;
  v_cont jsonb := '{}'::jsonb;
  v_n_pag int := 0; v_n_ac int := 0; v_n_c int := 0; v_n_log int := 0; v_valor_c numeric := 0;
  v_reav jsonb;
begin
  if auth.jwt() is not null
     and not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Classificar liquidacao Prime e da gestao ou da rotina.' using errcode = '42501';
  end if;

  select max(ativado_em) into v_corte from public.prime_liquidacao_regra;
  if v_corte is null then
    return jsonb_build_object('erro', 'REGRA_NAO_ATIVADA');
  end if;
  if to_regclass('public.fluxo_pagamentos_config') is not null then
    execute 'select coalesce((select ligado from public.fluxo_pagamentos_config where etapa = $1), true)'
      into v_ligado using 'prime_liquidacao_classificar';
  end if;
  if not v_ligado then
    return jsonb_build_object('pulou', 'etapa prime_liquidacao_classificar desligada');
  end if;

  -- Liquidacoes reais em titulos vivos cuja chave a regra ainda nao viu.
  -- "Real" e o que a Premissa da Prime ja provou (1.747 pagamentos, 0 erros):
  -- depois do vencimento + 30, depois da importacao, nao no dia dela, no 195.
  -- Isso diz que a LINHA e liquidacao de verdade -- nao diz quem pagou.
  drop table if exists _rle_novas;
  create temp table _rle_novas on commit drop as
  with cob as (
    select t.id, t.aluno_id, t.documento, t.vencimento, t.created_at::date as imp, upper(coalesce(t.situacao,'')) as situacao,
           coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as v
      from public.acordos_titulos t
     where coalesce(t.tipo_boleto,'') <> 'Acordo'
       and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO')
       and coalesce(lower(t.status),'') <> 'quitada'
  ),
  ex as (
    select distinct on (ltrim(e.boleto,'0')) ltrim(e.boleto,'0') as boleto, e.liquidado_em, e.portador, e.valor_bruto, e.valor_pago,
           e.coletado_em
      from public.prime_extrato e
     where e.liquidado_em is not null
     order by ltrim(e.boleto,'0'), e.coletado_em desc
  )
  select c.id as titulo_id, c.aluno_id, c.documento, c.v, c.situacao, ex.liquidado_em, ex.portador, ex.valor_bruto, ex.valor_pago,
         public.prime_liquidacao_chave(c.documento, ex.liquidado_em, ex.portador) as chave
    from cob c join ex on ex.boleto = ltrim(coalesce(c.documento,''),'0')
   where ex.portador = 195
     and ex.liquidado_em > c.vencimento + 30
     and ex.liquidado_em >= c.imp
     and ex.liquidado_em <> c.imp
     -- 09/10/2026, GUARDA DE DATA. `paymentDate` da Prime (= liquidado_em) vem
     -- preenchido em ~100% das linhas, INCLUSIVE em titulo a vencer -- medido
     -- em 28/09/2026, 0 de 302.477 nulos no portador 95
     -- (docs/integracoes/prime-api.md, prime-mapa-fontes-verdade.md). Data de
     -- liquidacao DEPOIS da coleta, ou no futuro, nao pode ser pagamento
     -- ocorrido: e `paymentDate` de parcela que ainda vai vencer.
     and ex.liquidado_em <= ex.coletado_em::date
     and ex.liquidado_em <= current_date
     and not exists (select 1 from public.prime_liquidacao_classificacao k
                      where k.titulo_id = c.id and k.evidencia_chave = public.prime_liquidacao_chave(c.documento, ex.liquidado_em, ex.portador)
                        and k.origem_decisao in ('ROTINA','CORTE'))
     and not exists (select 1 from public.prime_conferencia_decisao d
                      where d.titulo_id = c.id
                        and (d.decisao = 'PENDENTE'
                             or (d.decisao = 'REJEITADO'
                                 and coalesce((d.evidencia->>'liquidado_em')::date, (d.evidencia->'prime'->>'liquidado_em')::date) = ex.liquidado_em)))
   order by c.v desc, c.id
   limit greatest(coalesce(p_limite, 500), 1);

  if not p_aplicar then
    select jsonb_build_object('aplicado', false, 'novas', count(*), 'alunos', count(distinct aluno_id),
                              'valor', coalesce(round(sum(v),2),0), 'corte', v_corte)
      into v_res from _rle_novas;
    return v_res;
  end if;

  for r in select * from _rle_novas loop
    v_ev := public.prime_liquidacao_evidencias(r.titulo_id);
    v_pag := null; v_ac := null; v_sub := null;

    if r.situacao = 'NEGOCIADO' or (v_ev ? 'vinculo_ativo') then
      -- ja negociado no CRM: a liquidacao e a esperada. So registra.
      v_class := 'ACORDO_COMPROVADO'; v_nivel := 'DOCUMENTAL';
      v_motivo := 'titulo ja vinculado a acordo no CRM; liquidacao na Prime e consequencia do acordo';
      v_ac := (v_ev->'vinculo_ativo'->>'acordo_id')::uuid;
      v_n_log := v_n_log + 1;
    elsif v_ev ? 'acordo_composicao' then
      v_ac := (v_ev->'acordo_composicao'->>'acordo_id')::uuid;
      if v_ev->'acordo_composicao'->>'status' = 'QUITADO' then
        if coalesce((v_ev->'acordo_composicao'->'pago_de_verdade'->>'suficiente')::boolean, false) then
          v_class := 'PAGAMENTO_COMPROVADO'; v_nivel := 'FINANCEIRA'; v_sub := 'A_PAGAMENTO_COMPROVADO';
          v_motivo := 'boleto na composicao do acordo ' || coalesce(v_ev->'acordo_composicao'->>'numero','?')
                      || ' (QUITADO) com pagamentos baixados que cobrem o acordo';
          v_pag := nullif(v_ev->'acordo_composicao'->'pago_de_verdade'->'pagamento_ids'->>0,'')::uuid;
          v_n_pag := v_n_pag + 1;
        else
          v_class := 'PRIME_ORIGEM_NAO_COMPROVADA'; v_nivel := 'NENHUMA'; v_sub := 'C_SEM_PROVA';
          v_motivo := 'ACORDO_QUITADO_SEM_PAGAMENTO_REAL: o acordo ' || coalesce(v_ev->'acordo_composicao'->>'numero','?')
                      || ' esta QUITADO mas os pagamentos baixados nao cobrem o total';
          v_ac := null; v_n_c := v_n_c + 1; v_valor_c := v_valor_c + r.v;
        end if;
      else
        v_class := 'ACORDO_COMPROVADO'; v_nivel := 'DOCUMENTAL'; v_sub := 'B_ACORDO_COMPROVADO';
        v_motivo := 'boleto na composicao do acordo ' || coalesce(v_ev->'acordo_composicao'->>'numero','?') || ' (ATIVO)';
        v_n_ac := v_n_ac + 1;
      end if;
    else
      v_class := 'PRIME_ORIGEM_NAO_COMPROVADA'; v_nivel := 'NENHUMA'; v_sub := 'C_SEM_PROVA';
      v_motivo := 'PRIME_LIQUIDACAO_ORIGEM_NAO_COMPROVADA: sem pagamento ReATIVA que cubra o titulo e sem acordo comprovado'
                  || case when v_ev ? 'pagamento_candidato_id' then '; ha pagamento proximo a conferir' else '' end
                  || case when v_ev ? 'acordo_candidato' then '; ha acordo proximo da data sem composicao' else '' end;
      v_pag := nullif(v_ev->>'pagamento_candidato_id','')::uuid;
      v_n_c := v_n_c + 1; v_valor_c := v_valor_c + r.v;
    end if;

    -- 09/10/2026: C_SEM_PROVA NAO SUSPENDE MAIS. Importacao de titulo, saldo
    -- atualizado (`valor_pago`, que e divida corrigida) e `liquidado_em` sem
    -- comprovacao nao podem, isoladamente, gerar confirmacao de pagamento.
    -- Fica so o registro da classificacao e o titulo continua ABERTO/NEGOCIADO.
    -- Rotas A (pagamento comprovado) e B (acordo comprovado) seguem iguais --
    -- titulo com pagamento provado continua protegido da cobranca.
    if v_sub is not null and v_sub <> 'C_SEM_PROVA' then
      v_res := public.prime_liquidacao_suspender(r.titulo_id, v_sub, v_class, v_nivel, v_motivo, v_ev, v_pag, v_ac, v_quem);
    elsif v_sub = 'C_SEM_PROVA' then
      v_res := jsonb_build_object('ok', true, 'so_registro', true,
                                  'nao_suspendeu', 'IMPORTACAO_DE_TITULO_NAO_E_PAGAMENTO');
    else
      v_res := jsonb_build_object('ok', true, 'so_registro', true);
    end if;

    insert into public.prime_liquidacao_classificacao
      (titulo_id, aluno_id, documento, evidencia_chave, data_liquidacao_prime, valor_bruto_prime, valor_pago_prime, portador,
       pagamento_id, acordo_id, classificacao, nivel_evidencia, motivo, evidencia, origem_decisao, decidido_por, resultado_titulo)
    values (r.titulo_id, r.aluno_id, r.documento, r.chave, r.liquidado_em, r.valor_bruto, r.valor_pago, r.portador,
            v_pag, v_ac, v_class, v_nivel, v_motivo, v_ev || jsonb_build_object('suspensao', v_res), 'ROTINA', v_quem,
            (select situacao from public.acordos_titulos where id = r.titulo_id))
    on conflict do nothing;
  end loop;

  v_reav := public.prime_liquidacao_reavaliar_pendentes(v_quem);

  select jsonb_build_object('aplicado', true, 'corte', v_corte,
           'novas', count(*), 'alunos', count(distinct aluno_id), 'valor', coalesce(round(sum(v),2),0),
           'PAGAMENTO_COMPROVADO', v_n_pag, 'ACORDO_COMPROVADO_fila', v_n_ac, 'ACORDO_COMPROVADO_registro', v_n_log,
           'PRIME_ORIGEM_NAO_COMPROVADA', v_n_c, 'valor_em_confirmacao', 0,
           'valor_so_registro_sem_prova', round(v_valor_c,2), 'reavaliacao', v_reav)
    into v_cont from _rle_novas;

  if (v_cont->>'novas')::int > 0 or coalesce((v_reav->>'mudou')::int,0) > 0 then
    insert into public.auditoria (usuario, acao, tabela_afetada, detalhes)
    values (v_quem, 'PRIME_LIQUIDACAO_CLASSIFICACAO', 'acordos_titulos', v_cont);
  end if;
  return v_cont;
end;
$function$;
comment on function public.prime_liquidacao_classificar_novas(int, boolean) is
  'Classifica liquidacao nova da Prime. 09/10/2026: C_SEM_PROVA (liquidacao sem pagamento identificado) passa a ser SO REGISTRO -- nao suspende o titulo nem cria PENDENTE, porque importacao de titulo, saldo atualizado e liquidado_em sem comprovacao nao sao pagamento. Rotas A e B inalteradas. Elegibilidade tambem exige liquidado_em <= coletado_em e <= hoje.';

comment on function public.prime_liquidacao_evidencias(uuid) is
  'Evidencias de um titulo para a Conferencia Prime. 09/10/2026: liquidacao_real passa a exigir liquidado_em <= coletado_em e <= hoje (paymentDate da Prime vem preenchido inclusive em titulo a vencer); expoe liquidado_depois_da_coleta e valor_pago_e_divida_corrigida.';

-- ===== 3. TRAVA: SO AS DUAS FUNCOES MUDARAM ================================
do $$
declare a record; v_cn text; v_ev text; v_sus text; v_reav text;
begin
  select * into a from _cepc_antes;
  select md5(prosrc) into v_cn from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='prime_liquidacao_classificar_novas';
  select md5(prosrc) into v_ev from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='prime_liquidacao_evidencias';
  select md5(prosrc) into v_sus from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='prime_liquidacao_suspender';
  select md5(prosrc) into v_reav from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='prime_liquidacao_reavaliar_pendentes';

  if v_cn = a.md5_cn or v_ev = a.md5_ev then
    raise exception 'alguma das duas definicoes nao mudou -- a migration nao fez o que diz';
  end if;
  if v_sus is distinct from a.md5_sus or v_reav is distinct from a.md5_reav then
    raise exception 'suspender/reavaliar nao deviam mudar (% / %)', v_sus, v_reav;
  end if;

  if (select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='EM_CONFIRMACAO') <> a.em_conf
     or (select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='PAGO') <> a.pagos
     or (select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='NEGOCIADO') <> a.negociados
     or (select count(*) from public.prime_conferencia_decisao where decisao='PENDENTE') <> a.pendentes
     or (select count(*) from public.prime_liquidacao_classificacao) <> a.classificacoes
     or (select count(*) from public.solicitacoes_confirmacao_pagamento) <> a.solicitacoes
     or (select count(*) from public.pagamentos) <> a.pag
     or (select count(*) from public.parcelas) <> a.parc
     or (select count(*) from public.acordos) <> a.ac
     or (select count(*) from public.acordo_titulo_vinculo) <> a.vinc then
    raise exception 'esta migration e so DDL: alguma contagem de dado mudou';
  end if;
end $$;

commit;
