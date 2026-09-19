-- REGRA PERMANENTE DE ENTRADA: PRIME LIQUIDADO NAO E SINONIMO DE PAGAMENTO.
--
-- Aprovada pela gestao em 18/09/2026, depois da auditoria dos 407 A1 (371
-- confirmados so por "valor pago > bruto" foram revertidos) e da leitura de
-- C2/D (a Prime nao expoe o motivo da liquidacao).
--
-- A partir do CORTE registrado em prime_liquidacao_regra, toda liquidacao NOVA
-- de um titulo vivo passa por classificacao de origem antes de qualquer estado
-- financeiro:
--
--   ROTA A  pagamento ReATIVA comprovado  -> a fila sugere "seguir o pagamento";
--           quem conclui e o fluxo oficial de pagamento (a vista quita; parcela
--           de parcelado deixa NEGOCIADO).
--   ROTA B  acordo CRM comprovado (composicao documental: o boleto esta em
--           parcelas.titulos_origem, ou ja ha vinculo ativo) -> a fila sugere
--           "vincular ao acordo"; ATIVO = NEGOCIADO; QUITADO so vira PAGO com
--           pagamentos reais suficientes.
--   ROTA C  sem prova -> EM_CONFIRMACAO / PENDENTE, motivo
--           PRIME_LIQUIDACAO_ORIGEM_NAO_COMPROVADA: fora do saldo exigivel, das
--           acoes massivas, da cobranca, do bordero, do honorario e da vaga.
--
-- NUNCA prova sozinho: valor_pago Prime, data de liquidacao, portador,
-- coincidencia de valor, status de contrato, presenca no 166.
--
-- Premissa 6 continua: nada aqui marca PAGO ou NEGOCIADO sozinho. A rotina
-- classifica, suspende e registra a evidencia; PAGO/NEGOCIADO so pelas rotas
-- oficiais (fluxo de pagamento, vinculo) com decisao registrada.
--
-- O PASSIVO HISTORICO NAO E REPROCESSADO: cada liquidacao ja existente no
-- momento do corte entra como HISTORICO_FORA_DO_CORTE e continua na
-- Conferencia atual.
--
-- Compativel com o PGlite dos testes: pg_cron, sistema_sob_carga,
-- fluxo_pagamentos_config e prime_portador_membro sao usados so quando existem.

begin;

-- ===== 0. FOTO DE ANTES (a prova do fim confere que nada mudou) ============
create temp table _rle_antes on commit drop as
select (select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='EM_CONFIRMACAO') as em_conf,
       (select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='PAGO') as pagos,
       (select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='NEGOCIADO') as negociados,
       (select count(*) from public.prime_conferencia_decisao where decisao='PENDENTE') as pendentes;

-- ===== 1. ESTRUTURA =========================================================

-- A ponte boleto <-> documento compara sem zeros a esquerda. Sem este indice o
-- corte (3.543 titulos x 400 mil linhas do extrato) estourou o statement_timeout
-- na primeira aplicacao (18/09 23:44 UTC, revertida por inteiro).
create index if not exists ix_prime_extrato_boleto_ltrim on public.prime_extrato (ltrim(boleto, '0'));

-- O corte: a partir de quando a regra vale, e quantos titulos ja liquidados
-- ficaram fora dela (item 14).
create table if not exists public.prime_liquidacao_regra (
  id                   int generated always as identity primary key,
  versao               text not null,
  ativado_em           timestamptz not null default now(),
  titulos_fora_do_corte int not null,
  alunos_fora_do_corte  int not null,
  valor_fora_do_corte   numeric not null,
  detalhe              jsonb not null default '{}'::jsonb
);
alter table public.prime_liquidacao_regra enable row level security;

-- Registro de cada liquidacao classificada (item 9). Uma linha por
-- titulo + evento da Prime + classificacao; a rotina nunca repete a mesma.
create table if not exists public.prime_liquidacao_classificacao (
  id                   bigint generated always as identity primary key,
  titulo_id            uuid not null references public.acordos_titulos(id) on delete cascade,
  aluno_id             uuid,
  documento            text,
  evidencia_chave      text not null,
  data_liquidacao_prime date,
  valor_bruto_prime    numeric,
  valor_pago_prime     numeric,
  portador             int,
  pagamento_id         uuid,
  acordo_id            uuid,
  classificacao        text not null,
  nivel_evidencia      text not null,
  motivo               text not null,
  evidencia            jsonb not null default '{}'::jsonb,
  classificado_em      timestamptz not null default now(),
  origem_decisao       text not null,
  decidido_por         text not null,
  resultado_titulo     text,
  constraint prime_liq_class_classificacao_chk check (classificacao in (
    'PAGAMENTO_COMPROVADO','ACORDO_COMPROVADO','PRIME_ORIGEM_NAO_COMPROVADA',
    'LIQUIDACAO_INSTITUCIONAL','HISTORICO_FORA_DO_CORTE','PRIME_REVERTEU_LIQUIDACAO')),
  constraint prime_liq_class_nivel_chk check (nivel_evidencia in ('FINANCEIRA','DOCUMENTAL','NENHUMA','HISTORICO')),
  constraint prime_liq_class_origem_chk check (origem_decisao in ('ROTINA','GESTAO','CORTE'))
);
-- idempotencia (item 11): a rotina e o corte nunca gravam duas vezes o mesmo
-- titulo + evento + classificacao. A gestao pode decidir por cima.
create unique index if not exists ux_prime_liq_class_rotina
  on public.prime_liquidacao_classificacao (titulo_id, evidencia_chave, classificacao)
  where origem_decisao in ('ROTINA','CORTE');
create index if not exists ix_prime_liq_class_titulo on public.prime_liquidacao_classificacao (titulo_id);
create index if not exists ix_prime_liq_class_quando on public.prime_liquidacao_classificacao (classificado_em);
alter table public.prime_liquidacao_classificacao enable row level security;

-- A fila humana ganha tres subgrupos novos. A1/A2 continuam para o historico.
alter table public.prime_conferencia_decisao drop constraint if exists prime_conferencia_decisao_subgrupo_check;
alter table public.prime_conferencia_decisao add constraint prime_conferencia_decisao_subgrupo_check
  check (subgrupo is null or subgrupo = any (array['A1','A2_COBRE','A2_NAO_COBRE','A2_INCONCLUSIVO',
                                                  'A_PAGAMENTO_COMPROVADO','B_ACORDO_COMPROVADO','C_SEM_PROVA']));

-- ===== 2. EVIDENCIA =========================================================

-- A chave do evento: documento + data de liquidacao + portador. valor_pago e
-- valor_bruto ficam FORA de proposito -- mudam de coleta para coleta e
-- fariam o mesmo evento parecer novo toda semana.
create or replace function public.prime_liquidacao_chave(p_documento text, p_liquidado_em date, p_portador int)
 returns text
 language sql
 immutable
as $function$
  select md5(concat_ws('|', ltrim(coalesce(p_documento,''),'0'), coalesce(p_liquidado_em::text,'ABERTO'), coalesce(p_portador,0)::text));
$function$;

-- Acordo QUITADO so vale como PAGO com dinheiro de verdade: pagamentos
-- BAIXADOS (pelo boleto das parcelas ou depois da criacao do acordo) que
-- cobrem ao menos 95% do total. Status QUITADO sozinho nao prova (item 3).
create or replace function public.prime_liquidacao_acordo_pago_de_verdade(p_acordo_id uuid)
 returns jsonb
 language plpgsql
 stable
 set search_path to 'public'
as $function$
declare
  v_ac record; v_soma numeric := 0; v_ids uuid[];
begin
  select a.id, a.aluno_id, a.valor_total, a.criado_em::date as criado, upper(coalesce(a.status,'')) as status,
         lpad(regexp_replace(coalesce(a.cpf,''),'\D','','g'),11,'0') as cpf11
    into v_ac from public.acordos a where a.id = p_acordo_id;
  if not found then
    return jsonb_build_object('suficiente', false, 'motivo', 'ACORDO_NAO_ENCONTRADO');
  end if;
  select coalesce(sum(p.valor_pago),0), array_agg(p.id)
    into v_soma, v_ids
    from public.pagamentos p
   where (p.aluno_id = v_ac.aluno_id
          or lpad(regexp_replace(coalesce(p.cpf,''),'\D','','g'),11,'0') = v_ac.cpf11)
     and coalesce(p.status_conciliacao,'') = 'BAIXADO'
     and (ltrim(coalesce(p.numero_parcela_completo,''),'0') in
            (select ltrim(coalesce(pa.boleto,''),'0') from public.parcelas pa where pa.acordo_id = v_ac.id and coalesce(pa.boleto,'') <> '')
          or p.data_pagamento >= v_ac.criado - 5);
  return jsonb_build_object(
    'suficiente', v_ac.status = 'QUITADO' and coalesce(v_ac.valor_total,0) > 0 and v_soma >= 0.95 * v_ac.valor_total,
    'status_acordo', v_ac.status, 'valor_total', v_ac.valor_total, 'pagamentos_baixados', round(v_soma,2),
    'pagamento_ids', coalesce(to_jsonb(v_ids), '[]'::jsonb),
    'parcelas_abertas', (select count(*) from public.parcelas pa where pa.acordo_id = v_ac.id
                          and upper(coalesce(pa.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')));
end;
$function$;

-- Tudo que o CRM sabe sobre a liquidacao de um titulo (item 9 e 13). Leitura
-- pura; e o que a rotina classifica e o que a tela mostra.
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
       'liquidacao_real', (v_ex.liquidado_em is not null and v_ex.liquidado_em > v_t.vencimento + 30
                           and v_ex.liquidado_em >= v_t.imp and v_ex.liquidado_em <> v_t.imp)) end,
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

-- ===== 3. A ROTINA DE ENTRADA (itens 4, 5, 6, 9, 11) ========================

-- Suspende UM titulo pela rota C (ou poe na fila a sugestao da rota A/B).
-- Interna: so a rotina e as decisoes da gestao chamam. Nunca marca PAGO.
create or replace function public.prime_liquidacao_suspender(
  p_titulo_id uuid, p_subgrupo text, p_classificacao text, p_nivel text, p_motivo text,
  p_evidencia jsonb, p_pagamento_id uuid, p_acordo_id uuid, p_quem text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_t record; v_op text; v_num text; v_valor numeric; v_rev boolean;
begin
  select t.*, coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as v
    into v_t from public.acordos_titulos t where t.id = p_titulo_id for update;
  if not found then return jsonb_build_object('ok', false, 'erro', 'TITULO_NAO_ENCONTRADO'); end if;
  if upper(coalesce(v_t.situacao,'')) not in ('ABERTO','EM_CONFIRMACAO') then
    return jsonb_build_object('ok', false, 'erro', 'NAO_ESTA_ABERTO', 'situacao', v_t.situacao);
  end if;
  v_valor := round(v_t.v, 2);
  v_rev := coalesce((p_evidencia->>'acordo_cancelado_no_historico')::boolean, false)
        or not coalesce((p_evidencia->'prime'->>'cpf_confere')::boolean, true)
        or p_subgrupo = 'C_SEM_PROVA' and p_motivo like 'ACORDO_QUITADO_SEM_PAGAMENTO_REAL%';
  select k.operador_email into v_op from public.casos k
   where k.aluno_id = v_t.aluno_id and not coalesce(k.encerrado_operacional, false)
   order by k.caso_atualizado_em desc nulls last limit 1;
  if p_acordo_id is not null then
    select coalesce(numero_acordo::text,'') into v_num from public.acordos where id = p_acordo_id;
  end if;

  insert into public.prime_conferencia_decisao
    (titulo_id, decisao, motivo, decidido_por, decidido_em, motivo_entrada, aluno_id, cpf, documento, valor,
     evidencia, evidencia_chave, corroboracao, subgrupo, acordo_id, acordo_numero, revisao_obrigatoria,
     operador_no_momento, detectado_em, situacao_anterior, status_anterior)
  values (p_titulo_id, 'PENDENTE', null, null, null, 'PRIME_LIQUIDACAO_ORIGEM_NAO_COMPROVADA', v_t.aluno_id, v_t.cpf,
          v_t.documento, v_valor,
          p_evidencia || jsonb_build_object('classificacao', p_classificacao, 'nivel_evidencia', p_nivel, 'motivo', p_motivo,
                                            'pagamento_id', p_pagamento_id),
          p_evidencia->>'evidencia_chave', 'NENHUMA', p_subgrupo, p_acordo_id, v_num, v_rev,
          v_op, now(), v_t.situacao, v_t.status)
  on conflict (titulo_id) do update
    set decisao = 'PENDENTE', motivo = null, decidido_por = null, decidido_em = null,
        motivo_entrada = excluded.motivo_entrada, aluno_id = excluded.aluno_id, cpf = excluded.cpf,
        documento = excluded.documento, valor = excluded.valor, evidencia = excluded.evidencia,
        evidencia_chave = excluded.evidencia_chave, corroboracao = excluded.corroboracao,
        subgrupo = excluded.subgrupo, acordo_id = excluded.acordo_id, acordo_numero = excluded.acordo_numero,
        revisao_obrigatoria = excluded.revisao_obrigatoria, operador_no_momento = excluded.operador_no_momento,
        detectado_em = excluded.detectado_em, situacao_anterior = excluded.situacao_anterior,
        status_anterior = excluded.status_anterior;

  if upper(coalesce(v_t.situacao,'')) <> 'EM_CONFIRMACAO' then
    perform set_config('conferencia_prime.decisao', 'on', true);
    update public.acordos_titulos set situacao = 'EM_CONFIRMACAO', atualizado_em = now() where id = p_titulo_id;
    perform set_config('conferencia_prime.decisao', 'off', true);

    insert into public.aluno_movimentacoes
      (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_nome, registrado_por_email,
       registrado_em, valor_movimentacao)
    values (v_t.aluno_id::text, 'TITULO_EM_CONFIRMACAO_PRIME',
            'Titulo ' || coalesce(v_t.documento,'?') || ' (venc. ' || to_char(v_t.vencimento,'DD/MM/YYYY')
              || ') saiu da cobranca: a Prime liquidou em ' || coalesce(p_evidencia->'prime'->>'liquidado_em','?')
              || ' e a origem nao esta comprovada (' || p_classificacao || '). Nada foi baixado; o valor foi mantido.',
            coalesce(v_t.situacao,'(sem)'), 'EM_CONFIRMACAO', 'Sistema', p_quem, now(), v_valor);
  end if;

  if v_t.aluno_id is not null then
    perform public.recalcular_situacao_aluno(v_t.aluno_id, 'prime_liquidacao_suspensao');
  end if;
  return jsonb_build_object('ok', true, 'titulo_id', p_titulo_id, 'subgrupo', p_subgrupo, 'valor', v_valor);
end;
$function$;

-- A rotina de entrada. p_aplicar = false so mede.
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
    select distinct on (ltrim(e.boleto,'0')) ltrim(e.boleto,'0') as boleto, e.liquidado_em, e.portador, e.valor_bruto, e.valor_pago
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

    if v_sub is not null then
      v_res := public.prime_liquidacao_suspender(r.titulo_id, v_sub, v_class, v_nivel, v_motivo, v_ev, v_pag, v_ac, v_quem);
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
           'PRIME_ORIGEM_NAO_COMPROVADA', v_n_c, 'valor_em_confirmacao', round(v_valor_c,2), 'reavaliacao', v_reav)
    into v_cont from _rle_novas;

  if (v_cont->>'novas')::int > 0 or coalesce((v_reav->>'mudou')::int,0) > 0 then
    insert into public.auditoria (usuario, acao, tabela_afetada, detalhes)
    values (v_quem, 'PRIME_LIQUIDACAO_CLASSIFICACAO', 'acordos_titulos', v_cont);
  end if;
  return v_cont;
end;
$function$;

-- Itens 7 e 12: o que ja esta na fila pela regra nova e reavaliado a cada
-- rodada. (a) Prime voltou o boleto para aberto -> o titulo volta a ser
-- cobrado pelo caminho da rejeicao, com a mudanca registrada. (b) surgiu
-- composicao de acordo -> a fila passa a sugerir o vinculo. (c) surgiu
-- pagamento -> a fila passa a sugerir seguir o pagamento. Titulo PAGO ou
-- NEGOCIADO com prova nunca e reaberto por aqui.
create or replace function public.prime_liquidacao_reavaliar_pendentes(p_quem text default 'prime_liquidacao@rotina')
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  d record; v_ev jsonb; v_liq date; v_valor numeric; v_mudou int := 0; v_rev int := 0; v_sug int := 0;
begin
  for d in select x.* from public.prime_conferencia_decisao x
            where x.decisao = 'PENDENTE' and x.subgrupo in ('C_SEM_PROVA','B_ACORDO_COMPROVADO','A_PAGAMENTO_COMPROVADO')
            order by x.detectado_em
  loop
    v_ev := public.prime_liquidacao_evidencias(d.titulo_id);
    if v_ev is null then continue; end if;
    v_liq := (v_ev->'prime'->>'liquidado_em')::date;

    -- (a) reversao explicita: a linha da Prime existe e nao esta mais liquidada
    if (v_ev ? 'prime') and v_liq is null then
      select round(coalesce(t.valor_cobranca_ajustado, t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0),2)
        into v_valor from public.acordos_titulos t where t.id = d.titulo_id;
      perform set_config('conferencia_prime.decisao', 'on', true);
      update public.acordos_titulos set situacao = 'ABERTO', status = 'em_aberto', atualizado_em = now()
       where id = d.titulo_id and upper(coalesce(situacao,'')) = 'EM_CONFIRMACAO';
      perform set_config('conferencia_prime.decisao', 'off', true);
      update public.prime_conferencia_decisao
         set decisao = 'REJEITADO', motivo = 'PRIME_REVERTEU_LIQUIDACAO: o boleto voltou a aparecer em aberto na Prime',
             decidido_por = p_quem, decidido_em = now()
       where titulo_id = d.titulo_id;
      insert into public.prime_liquidacao_classificacao
        (titulo_id, aluno_id, documento, evidencia_chave, data_liquidacao_prime, portador, classificacao, nivel_evidencia,
         motivo, evidencia, origem_decisao, decidido_por, resultado_titulo)
      values (d.titulo_id, d.aluno_id, d.documento, v_ev->>'evidencia_chave', null, (v_ev->'prime'->>'portador')::int,
              'PRIME_REVERTEU_LIQUIDACAO', 'NENHUMA', 'a Prime deixou de mostrar o boleto liquidado; o titulo voltou para a cobranca',
              v_ev, 'ROTINA', p_quem, 'ABERTO')
      on conflict do nothing;
      insert into public.aluno_movimentacoes
        (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
      values (d.aluno_id::text, 'TITULO_CONFIRMACAO_REJEITADA',
              'Titulo ' || coalesce(d.documento,'?') || ' voltou para a cobranca: a Prime deixou de mostra-lo liquidado.',
              'EM_CONFIRMACAO', 'ABERTO', 'Sistema', p_quem, now(), v_valor);
      if d.aluno_id is not null then
        perform public.recalcular_situacao_aluno(d.aluno_id, 'prime_liquidacao_reversao');
      end if;
      v_rev := v_rev + 1; v_mudou := v_mudou + 1;
      continue;
    end if;

    -- (b)/(c): a evidencia mudou de nivel -> atualiza a sugestao da fila
    if d.subgrupo = 'C_SEM_PROVA' and (v_ev ? 'acordo_composicao')
       and (v_ev->'acordo_composicao'->>'status' = 'ATIVO'
            or coalesce((v_ev->'acordo_composicao'->'pago_de_verdade'->>'suficiente')::boolean,false)) then
      update public.prime_conferencia_decisao
         set subgrupo = case when v_ev->'acordo_composicao'->>'status' = 'QUITADO' then 'A_PAGAMENTO_COMPROVADO' else 'B_ACORDO_COMPROVADO' end,
             acordo_id = (v_ev->'acordo_composicao'->>'acordo_id')::uuid,
             acordo_numero = v_ev->'acordo_composicao'->>'numero',
             evidencia = v_ev || jsonb_build_object('classificacao',
               case when v_ev->'acordo_composicao'->>'status' = 'QUITADO' then 'PAGAMENTO_COMPROVADO' else 'ACORDO_COMPROVADO' end,
               'nivel_evidencia', case when v_ev->'acordo_composicao'->>'status' = 'QUITADO' then 'FINANCEIRA' else 'DOCUMENTAL' end,
               'motivo', 'reavaliado: surgiu composicao documental de acordo'),
             detectado_em = now()
       where titulo_id = d.titulo_id;
      v_sug := v_sug + 1; v_mudou := v_mudou + 1;
    elsif d.subgrupo = 'C_SEM_PROVA'
          and coalesce(d.evidencia->>'pagamento_candidato_id','') is distinct from coalesce(v_ev->>'pagamento_candidato_id','') then
      update public.prime_conferencia_decisao
         set evidencia = d.evidencia || jsonb_build_object('pagamentos_proximos', v_ev->'pagamentos_proximos',
               'pagamento_candidato_id', v_ev->'pagamento_candidato_id', 'pagamento_candidato_status', v_ev->'pagamento_candidato_status',
               'pagamento_cobre_o_titulo', v_ev->'pagamento_cobre_o_titulo', 'reavaliado_em', now())
       where titulo_id = d.titulo_id;
      v_sug := v_sug + 1; v_mudou := v_mudou + 1;
    end if;
  end loop;
  return jsonb_build_object('mudou', v_mudou, 'revertidas_pela_prime', v_rev, 'sugestao_atualizada', v_sug);
end;
$function$;

-- ===== 4. AS DECISOES DA FILA ===============================================

-- ROTA A pela tela: o pagamento esta identificado mas ainda pendente no
-- motor. O titulo volta para o fluxo oficial (ABERTO) e o motor conclui; a
-- decisao e registrada como PAGAMENTO_COMPROVADO pela gestao.
create or replace function public.prime_conferencia_seguir_pagamento(p_titulo_id uuid, p_pagamento_id uuid, p_motivo text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_motivo text := nullif(btrim(coalesce(p_motivo,'')), '');
  v_titulo public.acordos_titulos%rowtype;
  v_dec public.prime_conferencia_decisao%rowtype;
  v_pag record; v_valor numeric; v_ev jsonb;
begin
  if not coalesce(public.usuario_e_gestao(), false) and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Conferencia Prime e decisao da gestao.' using errcode = '42501';
  end if;
  if length(coalesce(v_motivo,'')) < 10 then
    raise exception 'MOTIVO_OBRIGATORIO: diga por que este pagamento e deste titulo (minimo 10 caracteres).';
  end if;
  select * into v_titulo from public.acordos_titulos where id = p_titulo_id for update;
  if not found then raise exception 'TITULO_NAO_ENCONTRADO'; end if;
  if upper(coalesce(v_titulo.situacao,'')) <> 'EM_CONFIRMACAO' then
    raise exception 'NAO_ESTA_EM_CONFIRMACAO';
  end if;
  select * into v_dec from public.prime_conferencia_decisao where titulo_id = p_titulo_id for update;
  if not found or v_dec.decisao <> 'PENDENTE' then raise exception 'SEM_DECISAO_PENDENTE'; end if;

  select p.id, p.aluno_id, p.data_pagamento, p.valor_pago, p.status_conciliacao,
         lpad(regexp_replace(coalesce(p.cpf,''),'\D','','g'),11,'0') as cpf11
    into v_pag from public.pagamentos p where p.id = p_pagamento_id;
  if not found then raise exception 'PAGAMENTO_NAO_ENCONTRADO'; end if;
  if not (v_pag.aluno_id = v_titulo.aluno_id
          or v_pag.cpf11 = lpad(regexp_replace(coalesce(v_titulo.cpf,''),'\D','','g'),11,'0')) then
    raise exception 'PAGAMENTO_DE_OUTRO_ALUNO';
  end if;
  if coalesce(v_pag.status_conciliacao,'') in ('BAIXADO','TITULO_ORIGINAL_LIQUIDADO') then
    raise exception 'PAGAMENTO_JA_CONCLUIDO: este pagamento ja foi baixado -- se ele cobre o titulo, vincule ao acordo dele.';
  end if;

  v_valor := round(coalesce(v_titulo.valor_cobranca_ajustado, v_titulo.saldo_corrigido, v_titulo.valor_em_aberto, v_titulo.valor_original, 0), 2);
  v_ev := public.prime_liquidacao_evidencias(p_titulo_id);

  perform set_config('conferencia_prime.decisao', 'on', true);
  update public.acordos_titulos set situacao = 'ABERTO', status = 'em_aberto', atualizado_em = now() where id = p_titulo_id;
  perform set_config('conferencia_prime.decisao', 'off', true);

  update public.prime_conferencia_decisao
     set decisao = 'REJEITADO', motivo = 'ROTA_FINANCEIRA_PAGAMENTO: ' || v_motivo,
         decidido_por = nullif(v_email,''), decidido_em = now()
   where titulo_id = p_titulo_id;

  insert into public.prime_liquidacao_classificacao
    (titulo_id, aluno_id, documento, evidencia_chave, data_liquidacao_prime, valor_bruto_prime, valor_pago_prime, portador,
     pagamento_id, classificacao, nivel_evidencia, motivo, evidencia, origem_decisao, decidido_por, resultado_titulo)
  values (p_titulo_id, v_titulo.aluno_id, v_titulo.documento, coalesce(v_ev->>'evidencia_chave', v_dec.evidencia_chave, '-'),
          (v_ev->'prime'->>'liquidado_em')::date, (v_ev->'prime'->>'valor_bruto')::numeric, (v_ev->'prime'->>'valor_pago')::numeric,
          (v_ev->'prime'->>'portador')::int, p_pagamento_id, 'PAGAMENTO_COMPROVADO', 'FINANCEIRA',
          'gestao seguiu o pagamento ' || p_pagamento_id::text || ' (' || coalesce(v_pag.status_conciliacao,'?') || '): ' || v_motivo,
          v_ev, 'GESTAO', coalesce(nullif(v_email,''),'gestao'), 'ABERTO_PARA_O_FLUXO_DE_PAGAMENTO');

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
  values (v_titulo.aluno_id::text, 'TITULO_CONFIRMACAO_REJEITADA',
          'Titulo ' || coalesce(v_titulo.documento,'?') || ' segue pelo fluxo de pagamento (' || coalesce(v_pag.status_conciliacao,'?')
            || ' de ' || to_char(v_pag.data_pagamento,'DD/MM/YYYY') || '). Motivo: ' || v_motivo,
          'EM_CONFIRMACAO', 'ABERTO', v_email, v_email, now(), v_valor);

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (coalesce(nullif(v_email,''), 'sistema'), 'CONFERENCIA_PRIME_SEGUIR_PAGAMENTO', 'acordos_titulos', p_titulo_id,
          jsonb_build_object('pagamento_id', p_pagamento_id, 'motivo', v_motivo, 'valor', v_valor, 'evidencia', v_ev));

  if v_titulo.aluno_id is not null then
    perform public.recalcular_situacao_aluno(v_titulo.aluno_id, 'conferencia_prime_seguir_pagamento');
  end if;
  return jsonb_build_object('ok', true, 'titulo_id', p_titulo_id, 'pagamento_id', p_pagamento_id,
                            'proximo_passo', 'o fluxo oficial de pagamento conclui o titulo pela cadeia pagamento -> acordo/parcela -> titulo');
end;
$function$;

-- VINCULAR: os subgrupos comprovados vinculam direto ao acordo da fila; o
-- resto continua exigindo acordo escolhido e motivo. Acordo QUITADO so vira
-- PAGO com pagamentos reais (item 3) -- vale para todos os subgrupos.
create or replace function public.prime_conferencia_vincular(p_titulo_id uuid, p_acordo_id uuid default null, p_observacao text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_email  text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_obs    text := nullif(btrim(coalesce(p_observacao,'')), '');
  v_titulo public.acordos_titulos%rowtype;
  v_dec    public.prime_conferencia_decisao%rowtype;
  v_acordo uuid;
  v_num    text;
  v_status text;
  v_res    jsonb;
  v_pago   jsonb;
  v_ev     jsonb;
begin
  if not (public.crm_usuario_pode_quitar_baixar() or coalesce(public.usuario_e_gestao(), false)) then
    raise exception 'SEM_PERMISSAO: seu usuário não pode vincular título a acordo por aqui.';
  end if;

  select * into v_titulo from public.acordos_titulos where id = p_titulo_id for update;
  if not found then
    raise exception 'TITULO_NAO_ENCONTRADO';
  end if;
  if upper(coalesce(v_titulo.situacao,'')) <> 'EM_CONFIRMACAO' then
    raise exception 'NAO_ESTA_EM_CONFIRMACAO: so se vincula por aqui titulo que a Conferencia Prime colocou em confirmacao.';
  end if;

  select * into v_dec from public.prime_conferencia_decisao where titulo_id = p_titulo_id for update;
  if not found or v_dec.decisao <> 'PENDENTE' then
    raise exception 'SEM_DECISAO_PENDENTE';
  end if;
  -- So o que a evidencia comprova vincula direto ao acordo da deteccao (A2 que
  -- o acordo cobre; composicao documental; pagamento comprovado). Qualquer
  -- outro so com o acordo escolhido por gente e motivo escrito.
  v_acordo := coalesce(p_acordo_id, v_dec.acordo_id);
  if coalesce(v_dec.subgrupo,'') not in ('A2_COBRE','B_ACORDO_COMPROVADO','A_PAGAMENTO_COMPROVADO')
     and (p_acordo_id is null or length(coalesce(v_obs,'')) < 10) then
    raise exception 'ESCOLHA_O_ACORDO_E_O_MOTIVO: titulo % exige o acordo escolhido e motivo explicito (minimo 10 caracteres).', coalesce(v_dec.subgrupo,'?');
  end if;
  if v_dec.revisao_obrigatoria and length(coalesce(v_obs,'')) < 10 then
    raise exception 'MOTIVO_OBRIGATORIO: este titulo exige revisao humana -- escreva o motivo da decisao (minimo 10 caracteres).';
  end if;
  if v_acordo is null then
    raise exception 'ACORDO_NAO_INFORMADO';
  end if;
  select coalesce(numero_acordo::text,''), upper(coalesce(status,'')) into v_num, v_status
    from public.acordos where id = v_acordo and aluno_id = v_titulo.aluno_id;
  if not found then
    raise exception 'ACORDO_DE_OUTRO_ALUNO: o acordo informado nao e deste aluno.';
  end if;

  -- ITEM 3: QUITADO sem dinheiro real nao vira PAGO por vinculo.
  if v_status = 'QUITADO' then
    v_pago := public.prime_liquidacao_acordo_pago_de_verdade(v_acordo);
    if not coalesce((v_pago->>'suficiente')::boolean, false) then
      raise exception 'ACORDO_QUITADO_SEM_PAGAMENTO_REAL: o acordo % esta QUITADO mas os pagamentos baixados (R$ %) nao cobrem o total (R$ %); o titulo continua em confirmacao.',
        v_num, coalesce(v_pago->>'pagamentos_baixados','0'), coalesce(v_pago->>'valor_total','?');
    end if;
  end if;

  perform set_config('conferencia_prime.decisao', 'on', true);
  v_res := public.vincular_titulos_acordo(array[p_titulo_id], v_acordo);
  perform set_config('conferencia_prime.decisao', 'off', true);
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'VINCULO_FALHOU: %', v_res::text;
  end if;

  update public.prime_conferencia_decisao
     set decisao = 'VINCULADO', motivo = v_obs, decidido_por = nullif(v_email,''),
         decidido_em = now(), acordo_id = v_acordo, acordo_numero = v_num
   where titulo_id = p_titulo_id;

  -- registro da regra de entrada (item 9) para o que entrou por ela
  if v_dec.subgrupo in ('A_PAGAMENTO_COMPROVADO','B_ACORDO_COMPROVADO','C_SEM_PROVA') then
    v_ev := public.prime_liquidacao_evidencias(p_titulo_id);
    insert into public.prime_liquidacao_classificacao
      (titulo_id, aluno_id, documento, evidencia_chave, data_liquidacao_prime, valor_bruto_prime, valor_pago_prime, portador,
       pagamento_id, acordo_id, classificacao, nivel_evidencia, motivo, evidencia, origem_decisao, decidido_por, resultado_titulo)
    values (p_titulo_id, v_titulo.aluno_id, v_titulo.documento, coalesce(v_ev->>'evidencia_chave', v_dec.evidencia_chave, '-'),
            (v_ev->'prime'->>'liquidado_em')::date, (v_ev->'prime'->>'valor_bruto')::numeric, (v_ev->'prime'->>'valor_pago')::numeric,
            (v_ev->'prime'->>'portador')::int, nullif(v_pago->'pagamento_ids'->>0,'')::uuid, v_acordo,
            case when v_status = 'QUITADO' then 'PAGAMENTO_COMPROVADO' else 'ACORDO_COMPROVADO' end,
            case when v_status = 'QUITADO' then 'FINANCEIRA' else 'DOCUMENTAL' end,
            'gestao vinculou ao acordo ' || v_num || ' (' || v_status || ')' || coalesce(': ' || v_obs, ''),
            v_ev || jsonb_build_object('vinculo', v_res), 'GESTAO', coalesce(nullif(v_email,''),'gestao'),
            upper(coalesce(v_res->>'estado_titulo','')));
  end if;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, status_anterior, status_novo,
     registrado_por_nome, registrado_por_email, registrado_em, valor_movimentacao)
  values (v_titulo.aluno_id::text, 'TITULO_VINCULADO_CONFERENCIA_PRIME',
          'Titulo ' || coalesce(v_titulo.documento,'?') || ' vinculado ao acordo ' || v_num
            || ' pela Conferencia Prime: a divida fica so nas parcelas do acordo.'
            || coalesce(' ' || v_obs, ''),
          'EM_CONFIRMACAO', upper(coalesce(v_res->>'estado_titulo','')), v_email, v_email, now(),
          coalesce(v_titulo.valor_cobranca_ajustado, v_titulo.saldo_corrigido, v_titulo.valor_em_aberto, v_titulo.valor_original, 0));

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (coalesce(nullif(v_email,''), 'sistema'), 'CONFERENCIA_PRIME_VINCULO', 'acordos_titulos', p_titulo_id,
          jsonb_build_object('acordo_id', v_acordo, 'acordo_numero', v_num, 'subgrupo', v_dec.subgrupo,
                             'observacao', v_obs, 'evidencia', v_dec.evidencia, 'resultado', v_res));

  perform public.recalcular_situacao_aluno(v_titulo.aluno_id, 'conferencia_prime_vinculo');
  return v_res || jsonb_build_object('decisao', 'VINCULADO', 'acordo_numero', v_num);
end;
$function$;

-- BAIXAR: a trava do item 10. Nenhuma liquidacao vira PAGO por aqui sem
-- pagamento ReATIVA corroborando; "valor pago acima do bruto" e informacao
-- do extrato, nao caixa. O que entrou pela regra nova nunca baixa por aqui.
create or replace function public.prime_conferencia_baixar(p_titulo_id uuid, p_observacao text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_email     text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_obs       text := nullif(btrim(coalesce(p_observacao,'')), '');
  v_titulo    public.acordos_titulos%rowtype;
  v_dec       public.prime_conferencia_decisao%rowtype;
  v_ev        record;
  v_valor     numeric;
  v_bloqueio  text;
begin
  if not public.crm_usuario_pode_quitar_baixar() then
    raise exception 'SEM_PERMISSAO: seu usuário não pode dar baixa em título.';
  end if;

  select * into v_titulo from public.acordos_titulos where id = p_titulo_id for update;
  if not found then
    raise exception 'TITULO_NAO_ENCONTRADO';
  end if;

  if upper(coalesce(v_titulo.situacao,'')) = 'PAGO' then
    return jsonb_build_object('ja_processado', true, 'status', v_titulo.status, 'situacao', v_titulo.situacao);
  end if;

  -- Premissa 6: so baixa o que a deteccao do grupo A pos em confirmacao e que
  -- ainda espera decisao humana. Nunca mais a data crua da Prime.
  if upper(coalesce(v_titulo.situacao,'')) <> 'EM_CONFIRMACAO' then
    raise exception 'NAO_ESTA_EM_CONFIRMACAO: so se baixa por aqui titulo que a Conferencia Prime colocou em confirmacao.';
  end if;

  select * into v_dec from public.prime_conferencia_decisao where titulo_id = p_titulo_id for update;
  if not found or v_dec.decisao <> 'PENDENTE' then
    raise exception 'SEM_DECISAO_PENDENTE';
  end if;

  -- REGRA DE ENTRADA (18/09/2026): o que entrou sem prova nao baixa. Com
  -- acordo comprovado, vincule; com pagamento identificado, siga o pagamento.
  if coalesce(v_dec.subgrupo,'') in ('C_SEM_PROVA','B_ACORDO_COMPROVADO','A_PAGAMENTO_COMPROVADO') then
    raise exception 'SEM_PROVA_DE_PAGAMENTO: liquidacao na Prime nao e pagamento. Vincule ao acordo comprovado, siga o pagamento identificado ou mantenha em confirmacao.';
  end if;

  if v_dec.subgrupo = 'A2_COBRE' then
    raise exception 'USE_O_VINCULO: o acordo % cobre este titulo -- confirme pelo vinculo ao acordo, nao por baixa.', coalesce(v_dec.acordo_numero,'?');
  end if;
  if (v_dec.revisao_obrigatoria or v_dec.subgrupo in ('A2_NAO_COBRE','A2_INCONCLUSIVO'))
     and length(coalesce(v_obs,'')) < 10 then
    raise exception 'MOTIVO_OBRIGATORIO: este titulo exige revisao humana -- escreva o motivo da decisao (minimo 10 caracteres).';
  end if;

  select case
           when upper(coalesce(a.status_jornada,''))     in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA') then upper(a.status_jornada)
           when upper(coalesce(a.status_atual,''))       in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA') then upper(a.status_atual)
           when upper(coalesce(a.status_acionamento,'')) in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA') then upper(a.status_acionamento)
         end
    into v_bloqueio
  from public.alunos a where a.id = v_titulo.aluno_id;

  if v_bloqueio is not null then
    raise exception 'COBRANCA_NAO_COMUM: aluno está como % -- fora do escopo desta conferência.', v_bloqueio;
  end if;

  -- A evidencia e conferida DE NOVO, agora -- nao vale a da deteccao.
  select * into v_ev from public.prime_grupo_a_candidatos(array[p_titulo_id]) limit 1;
  if not found then
    raise exception 'EVIDENCIA_NAO_CONFIRMA: a liquidacao deste titulo nao se sustenta mais na Prime -- rejeite para voltar a cobrar.';
  end if;
  if v_ev.subgrupo = 'A2_COBRE' and v_dec.subgrupo <> 'A2_COBRE' then
    raise exception 'CLASSIFICACAO_MUDOU: hoje o acordo % cobre este titulo -- vincule ao acordo em vez de baixar.', coalesce(v_ev.acordo_numero,'?');
  end if;
  -- ITEM 10: valor_pago da Prime NAO e caixa. Sem pagamento ReATIVA no dia,
  -- nada vira PAGO por aqui -- em nenhum subgrupo.
  if coalesce(v_ev.corroboracao,'') <> 'PAGAMENTO_REATIVA' then
    raise exception 'VALOR_PAGO_PRIME_NAO_E_CAIXA: a unica corroboracao e "valor pago acima do bruto", que e divida corrigida, nao dinheiro recebido. Mantenha em confirmacao ou rejeite.';
  end if;

  v_valor := round(coalesce(v_titulo.valor_cobranca_ajustado, v_titulo.saldo_corrigido,
                            v_titulo.valor_em_aberto, v_titulo.valor_original, 0), 2);

  perform set_config('conferencia_prime.decisao', 'on', true);
  update public.acordos_titulos
     set situacao = 'PAGO', status = 'quitada',
         origem_liquidacao     = 'PRIME_LIQUIDACAO_OFICIAL',
         origem_liquidacao_ref = 'conferencia_prime:' || p_titulo_id::text,
         origem_liquidacao_em  = now(),
         motivo_ajuste = coalesce(motivo_ajuste,'')
           || case when coalesce(motivo_ajuste,'') = '' then '' else ' | ' end
           || 'baixado pela Conferencia Prime: liquidado na Prime em ' || to_char(v_ev.liquidado_em, 'DD/MM/YYYY')
           || ', corroborado por ' || v_ev.corroboracao || '; decisao de ' || coalesce(nullif(v_email,''), 'sistema'),
         atualizado_em = now()
   where id = p_titulo_id;
  perform set_config('conferencia_prime.decisao', 'off', true);

  update public.prime_conferencia_decisao
     set decisao = 'CONFIRMADO', motivo = v_obs, decidido_por = nullif(v_email,''), decidido_em = now(),
         evidencia = coalesce(evidencia, '{}'::jsonb) || jsonb_build_object('reconferida_na_decisao', v_ev.evidencia)
   where titulo_id = p_titulo_id;

  if v_titulo.aluno_id is not null then
    insert into public.aluno_movimentacoes (
      aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_email, registrado_em, valor_movimentacao
    ) values (
      v_titulo.aluno_id::text,
      'BAIXA_CONFERENCIA_PRIME',
      concat_ws(' ',
        'Titulo', btrim(coalesce(v_titulo.documento,'')),
        'venc.', to_char(v_titulo.vencimento, 'DD/MM/YYYY'),
        'baixado por conferencia com a Prime (liquidado em',
        to_char(v_ev.liquidado_em, 'DD/MM/YYYY') || ', corroborado por ' || v_ev.corroboracao || ').',
        v_obs
      ),
      'EM_CONFIRMACAO', 'PAGO', v_email, now(), v_valor
    );
  end if;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (coalesce(nullif(v_email,''), 'sistema'), 'CONFERENCIA_PRIME_BAIXA', 'acordos_titulos', p_titulo_id,
          jsonb_build_object('documento', v_titulo.documento, 'valor', v_valor, 'subgrupo', v_dec.subgrupo,
                             'observacao', v_obs, 'evidencia_deteccao', v_dec.evidencia,
                             'evidencia_decisao', v_ev.evidencia));

  if v_titulo.aluno_id is not null then
    perform public.recalcular_situacao_aluno(v_titulo.aluno_id, 'conferencia_prime_baixa');
  end if;

  return jsonb_build_object('ja_processado', false, 'titulo_id', p_titulo_id, 'decisao', 'CONFIRMADO',
                            'valor_baixado', v_valor, 'liquidado_em', v_ev.liquidado_em);
end;
$function$;

-- CONFIRMAR: o botao generico segue a classificacao. Sem prova, nao ha o que
-- confirmar (item 13).
create or replace function public.prime_conferencia_confirmar(p_titulo_id uuid, p_observacao text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_sub text;
begin
  -- Acordo comprovado (A2 que cobre, composicao documental ou pagamento
  -- comprovado) confirma por VINCULO; sem prova nao confirma; o resto (A1
  -- historico) confirma pela baixa oficial, que reconfere a evidencia.
  select subgrupo into v_sub from public.prime_conferencia_decisao
   where titulo_id = p_titulo_id and decisao = 'PENDENTE';
  if v_sub in ('A2_COBRE','B_ACORDO_COMPROVADO','A_PAGAMENTO_COMPROVADO') then
    return public.prime_conferencia_vincular(p_titulo_id, null, p_observacao) || jsonb_build_object('ok', true);
  end if;
  if v_sub = 'C_SEM_PROVA' then
    raise exception 'SEM_PROVA_DE_PAGAMENTO: liquidacao na Prime nao e pagamento. Mantenha em confirmacao, vincule a um acordo com motivo ou siga um pagamento identificado.';
  end if;
  return coalesce(public.prime_conferencia_baixar(p_titulo_id, p_observacao), '{}'::jsonb) || jsonb_build_object('ok', true);
end;
$function$;

-- A FILA: mesma assinatura + classificacao e motivo de entrada (item 13).
drop function if exists public.prime_conferencia_fila();
create function public.prime_conferencia_fila()
 returns table(titulo_id uuid, aluno_id uuid, aluno_nome text, cpf text, documento text, vencimento date, valor numeric,
               liquidado_em date, portador integer, corroboracao text, subgrupo text, acordo_id uuid, acordo_numero text,
               acordo_status text, razao numeric, revisao_obrigatoria boolean, operador_responsavel text,
               outras_dividas boolean, detectado_em timestamp with time zone, evidencia jsonb,
               classificacao text, motivo_entrada text)
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
         coalesce(d.evidencia->>'classificacao',
                  case when d.subgrupo like 'A%' then 'GRUPO_A_HISTORICO' end),
         d.motivo_entrada
    from public.prime_conferencia_decisao d
    join public.acordos_titulos t on t.id = d.titulo_id
    left join public.alunos al on al.id = d.aluno_id
    left join public.acordos ac on ac.id = d.acordo_id
   where d.decisao = 'PENDENTE'
   order by (coalesce(d.subgrupo,'') in ('A_PAGAMENTO_COMPROVADO','B_ACORDO_COMPROVADO')) desc,
            (coalesce(d.subgrupo,'') like 'A2%') desc, d.valor desc, d.titulo_id;
end;
$function$;

-- ===== 5. A TRAVA NO LIQUIDADOR AUTOMATICO (item 2) ==========================
-- Pagamento de acordo que nao cobre os titulos nao fecha os titulos. Parcela 1
-- de parcelado deixa de virar PAGO do titulo inteiro. O resto do texto e o de
-- producao (20260915120000). Titulos recusados entram na rota C pela rotina.
create or replace function public.conciliacao_liquidar_titulo_por_prime(p_pagamento_id uuid, p_titulos jsonb, p_aplicar boolean default true)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_pag record; v_t record; v_item jsonb;
  v_boleto text; v_pago date;
  v_liquidados jsonb := '[]'::jsonb; v_recusados jsonb := '[]'::jsonb;
  v_n int := 0; v_soma numeric := 0; v_motivo text;
  -- o que a ESCRITA fez -- nunca o que a leitura previu
  v_rows int := 0; v_escrito numeric;
  -- REGRA DE ENTRADA 18/09/2026: o dinheiro do pagamento tem de cobrir o que fecha
  v_base numeric; v_teto numeric; v_acumulado numeric := 0;
begin
  if coalesce(auth.role(),'') <> 'service_role'
     and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Liquidar titulo pela Prime e da gestao ou da rotina.' using errcode = '42501';
  end if;

  select p.id, p.aluno_id, p.status_conciliacao, p.titulo_numero, p.data_pagamento, p.valor_pago
    into v_pag
    from public.pagamentos p where p.id = p_pagamento_id;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'PAGAMENTO_NAO_ENCONTRADO');
  end if;

  -- Ja resolvido: idempotente, e sem reescrever nada.
  if coalesce(v_pag.status_conciliacao,'') = 'TITULO_ORIGINAL_LIQUIDADO' then
    return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id,
      'ja_resolvido', true, 'liquidados', 0);
  end if;

  -- IDENTIDADE PRIMEIRO. Sem aluno resolvido nao ha a quem pertencer o titulo,
  -- e fechar divida no aluno errado e pior do que nao fechar.
  if v_pag.aluno_id is null then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_ALUNO_VINCULADO',
      'detalhe', 'a identidade precisa ser resolvida antes de concluir titulo');
  end if;

  -- So age sobre pendencia de acordo. Pagamento ja baixado, em revisao ou sem
  -- vinculo tem outro caminho, e nao e este.
  if coalesce(v_pag.status_conciliacao,'') not in ('AGUARDANDO_ACORDO','ACORDO_CONFIRMADO_SEM_ESTRUTURA') then
    return jsonb_build_object('ok', false, 'motivo', 'ESTADO_NAO_ELEGIVEL',
      'status_conciliacao', v_pag.status_conciliacao);
  end if;

  -- O TETO DO DINHEIRO: base sem o honorario de 8%, com a margem global de 1,15.
  -- Titulo que nao cabe na base nao fecha por este pagamento.
  v_base := round(coalesce(v_pag.valor_pago, 0) / 1.08, 2);
  v_teto := round(v_base * 1.15, 2);

  for v_item in select * from jsonb_array_elements(coalesce(p_titulos,'[]'::jsonb))
  loop
    v_boleto := nullif(ltrim(regexp_replace(coalesce(v_item->>'boleto',''), '\D', '', 'g'), '0'), '');
    begin
      v_pago := (v_item->>'pago_em')::date;
    exception when others then
      v_pago := null;
    end;

    if coalesce((v_item->>'portador')::int, 0) <> 195 then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_item->>'boleto', 'porque', 'PORTADOR_NAO_E_195');
      continue;
    end if;
    if v_boleto is null or v_pago is null then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_item->>'boleto', 'porque', 'SEM_BOLETO_OU_SEM_DATA');
      continue;
    end if;

    select t.id, t.documento, t.vencimento, t.created_at, t.situacao, t.status,
           t.acordo_id, t.origem_liquidacao,
           coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as saldo
      into v_t
      from public.acordos_titulos t
     where nullif(ltrim(regexp_replace(coalesce(t.documento,''), '\D', '', 'g'), '0'), '') = v_boleto
       and t.aluno_id = v_pag.aluno_id;

    if not found then
      -- Pode ser titulo que nunca veio por bordero. NAO se cria titulo aqui:
      -- o CRM cobra o que recebeu, e inventar linha inflaria a carteira.
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'NAO_EXISTE_NO_CRM_PARA_ESTE_ALUNO');
      continue;
    end if;
    if coalesce(v_t.origem_liquidacao,'') = 'PRIME_LIQUIDACAO_OFICIAL' then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'JA_LIQUIDADO');
      continue;
    end if;
    if coalesce(v_t.situacao,'') <> 'ABERTO' or coalesce(v_t.status,'') <> 'em_aberto' then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'NAO_ESTA_ABERTO',
                                     'situacao', v_t.situacao, 'status', v_t.status);
      continue;
    end if;
    if v_t.acordo_id is not null
       or exists (select 1 from public.acordo_titulo_vinculo v
                   where v.titulo_id = v_t.id and coalesce(v.ativo, true)) then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'JA_NEGOCIADO_NO_CRM');
      continue;
    end if;
    if not (v_pago > v_t.vencimento + 30) then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'PAGAMENTO_DENTRO_DE_30_DIAS_DO_VENCIMENTO');
      continue;
    end if;
    if not (v_pago >= v_t.created_at::date) then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'PAGAMENTO_ANTERIOR_A_IMPORTACAO');
      continue;
    end if;
    -- ITEM 2: o pagamento tem de cobrir o que fecha. A soma dos titulos que
    -- este pagamento fecha nao passa da base + margem. Parcela de parcelado
    -- nao vira PAGO do titulo inteiro; o titulo segue para a rota C.
    if v_acumulado + v_t.saldo > v_teto then
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'PAGAMENTO_NAO_COBRE_O_TITULO',
                                     'saldo', v_t.saldo, 'base_do_pagamento', v_base, 'teto', v_teto, 'ja_coberto', v_acumulado);
      continue;
    end if;

    if not p_aplicar then
      -- PREVIA: nada e escrito, entao o que se reporta e o que PASSARIA nas
      -- travas agora. Nao promete a corrida -- so a leitura.
      v_n := v_n + 1;
      v_soma := v_soma + v_t.saldo;
      v_acumulado := v_acumulado + v_t.saldo;
      v_liquidados := v_liquidados || jsonb_build_object('boleto', v_boleto, 'titulo_id', v_t.id,
                        'vencimento', v_t.vencimento, 'pago_em', v_pago, 'saldo', v_t.saldo);
      continue;
    end if;

    -- AQUISICAO ATOMICA. As checagens acima foram feitas com a foto de antes;
    -- entre elas e esta escrita outra execucao pode ter levado o mesmo titulo.
    -- Entao a elegibilidade INTEIRA vai no WHERE do proprio UPDATE: em READ
    -- COMMITTED, duas transacoes que disputam a linha serializam, e a segunda
    -- reavalia o predicado contra a linha ja escrita -- encontra
    -- `origem_liquidacao` preenchida e afeta zero linhas. Compare-and-swap,
    -- sem lock explicito.
    --
    -- E o que conta e o que a ESCRITA fez, nao o que a leitura previu: `v_n`,
    -- `v_soma` e o estado do pagamento so avancam com linha realmente alterada.
    update public.acordos_titulos t
       set situacao = 'PAGO',
           status   = 'quitada',
           -- acordo_id continua NULL de proposito: nao ha acordo no CRM, e
           -- criar um so para ter onde apontar seria inventar estrutura.
           origem_liquidacao     = 'PRIME_LIQUIDACAO_OFICIAL',
           origem_liquidacao_ref = p_pagamento_id::text,
           origem_liquidacao_em  = now(),
           motivo_ajuste = coalesce(t.motivo_ajuste,'')
             || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
             || 'liquidada na origem: a Prime registra o documento ' || v_boleto
             || ' pago em ' || to_char(v_pago,'DD/MM/YYYY') || ' no portador 195'
             || ', e o Santander pagou o acordo ' || coalesce(nullif(v_pag.titulo_numero,''),'(sem numero)')
             || ' em ' || coalesce(to_char(v_pag.data_pagamento,'DD/MM/YYYY'),'?')
             || '. Nenhum acordo ou parcela foi criado a partir disso.',
           atualizado_em = now()
     where t.id = v_t.id
       and t.aluno_id = v_pag.aluno_id
       and t.origem_liquidacao is null
       and coalesce(t.situacao,'') = 'ABERTO'
       and coalesce(t.status,'')   = 'em_aberto'
       and t.acordo_id is null
       and not exists (select 1 from public.acordo_titulo_vinculo v
                        where v.titulo_id = t.id and coalesce(v.ativo, true))
    returning coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)
      into v_escrito;
    get diagnostics v_rows = row_count;

    if v_rows = 0 then
      -- Perdeu a corrida, ou a linha deixou de ser elegivel entre a leitura e a
      -- escrita. Nao e erro: e o caso em que NAO se conta.
      v_recusados := v_recusados || jsonb_build_object('boleto', v_boleto, 'porque', 'PERDEU_A_CORRIDA');
      continue;
    end if;

    v_n := v_n + 1;
    v_soma := v_soma + coalesce(v_escrito, 0);
    v_acumulado := v_acumulado + coalesce(v_escrito, 0);
    v_liquidados := v_liquidados || jsonb_build_object('boleto', v_boleto, 'titulo_id', v_t.id,
                      'vencimento', v_t.vencimento, 'pago_em', v_pago, 'saldo', v_escrito);
  end loop;

  if v_n = 0 then
    return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id, 'aplicou', false,
      'liquidados', 0, 'recusados', v_recusados,
      'motivo', 'nenhum titulo passou nas travas -- o pagamento segue como estava');
  end if;

  v_motivo := 'titulo original concluido pela liquidacao oficial na Prime: ' || v_n
    || ' documento(s) do portador 195 fecharam, somando R$ '
    || to_char(v_soma, 'FM999G999G990D00')
    || ' que saem do saldo em aberto. Nenhum acordo ou parcela foi criado, e nenhuma'
    || ' parcela foi baixada -- o caixa continua sendo o do pagamento Santander.';

  if p_aplicar then
    update public.pagamentos
       set status_conciliacao = 'TITULO_ORIGINAL_LIQUIDADO',
           conciliacao_motivo = v_motivo,
           conciliacao_em     = now()
     where id = p_pagamento_id;

    -- `decisao` tem CHECK proprio e nao aceita estado novo: o vocabulario dela
    -- e VINCULADO/DESCARTADO/AGUARDANDO_TERCEIRO/RESOLVIDO_AUTOMATICO/
    -- ENCERRADO_GESTAO. O desfecho especifico mora em `status_conciliacao`,
    -- exatamente como o motor ja faz com BAIXADO.
    update public.fila_pagamento_sem_vinculo
       set decisao = 'RESOLVIDO_AUTOMATICO',
           decidido_por = 'conciliacao@sistema',
           decidido_em = now(),
           status_conciliacao = 'TITULO_ORIGINAL_LIQUIDADO',
           observacao = coalesce(observacao,'')
             || case when coalesce(observacao,'') = '' then '' else ' | ' end
             || 'titulo original concluido pela liquidacao oficial na Prime'
     where pagamento_id = p_pagamento_id and decisao is null;
  end if;

  return jsonb_build_object('ok', true, 'pagamento_id', p_pagamento_id, 'aplicou', p_aplicar,
    'status', 'TITULO_ORIGINAL_LIQUIDADO', 'liquidados', v_n,
    'saldo_que_sai', v_soma, 'titulos', v_liquidados, 'recusados', v_recusados,
    'motivo', v_motivo);
end;
$function$;

-- ===== 6. OBSERVABILIDADE (item 16) =========================================
create or replace function public.prime_liquidacao_painel()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_regra record; v_res jsonb;
begin
  if not coalesce(public.usuario_e_gestao(), false) and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Painel da regra de entrada e da gestao.' using errcode = '42501';
  end if;
  select * into v_regra from public.prime_liquidacao_regra order by ativado_em desc limit 1;
  with novas as (
    select k.* from public.prime_liquidacao_classificacao k where k.origem_decisao = 'ROTINA'
  ),
  por_classe as (
    select classificacao, count(*) n, count(distinct titulo_id) titulos,
           round(coalesce(sum(coalesce(k.valor_bruto_prime,0)),0),2) valor_prime,
           round(coalesce(sum((select coalesce(t.valor_cobranca_ajustado,t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0)
                                  from public.acordos_titulos t where t.id = k.titulo_id)),0),2) valor_crm
      from novas k group by 1
  ),
  pend as (
    select d.* from public.prime_conferencia_decisao d
     where d.decisao = 'PENDENTE' and d.motivo_entrada = 'PRIME_LIQUIDACAO_ORIGEM_NAO_COMPROVADA'
  ),
  resolvidas as (
    select d.decisao, count(*) n, round(coalesce(sum(d.valor),0),2) valor
      from public.prime_conferencia_decisao d
     where d.motivo_entrada = 'PRIME_LIQUIDACAO_ORIGEM_NAO_COMPROVADA' and d.decisao <> 'PENDENTE'
     group by 1
  )
  select jsonb_build_object(
    'regra', case when v_regra.id is null then null else jsonb_build_object('versao', v_regra.versao, 'ativado_em', v_regra.ativado_em,
              'titulos_fora_do_corte', v_regra.titulos_fora_do_corte, 'alunos_fora_do_corte', v_regra.alunos_fora_do_corte,
              'valor_fora_do_corte', v_regra.valor_fora_do_corte) end,
    'recebidas', (select count(*) from novas),
    'por_classificacao', (select coalesce(jsonb_object_agg(classificacao, jsonb_build_object('eventos', n, 'titulos', titulos,
                            'valor_crm', valor_crm, 'valor_prime', valor_prime)), '{}'::jsonb) from por_classe),
    'em_confirmacao', jsonb_build_object('titulos', (select count(*) from pend), 'alunos', (select count(distinct aluno_id) from pend),
                        'valor', (select round(coalesce(sum(valor),0),2) from pend),
                        'dias_pendente_medio', (select round(coalesce(avg(extract(epoch from (now() - detectado_em))/86400.0),0),1) from pend),
                        'por_subgrupo', (select coalesce(jsonb_object_agg(s, n), '{}'::jsonb) from (select subgrupo s, count(*) n from pend group by 1) z)),
    'resolvidas_depois', (select coalesce(jsonb_object_agg(decisao, jsonb_build_object('titulos', n, 'valor', valor)), '{}'::jsonb) from resolvidas),
    'ultima_rodada', (select a.created_at from public.auditoria a where a.acao = 'PRIME_LIQUIDACAO_CLASSIFICACAO' order by a.created_at desc limit 1))
  into v_res;
  return v_res;
end;
$function$;

-- ===== 7. PERMISSOES ========================================================
revoke all on function public.prime_liquidacao_suspender(uuid, text, text, text, text, jsonb, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.prime_liquidacao_classificar_novas(int, boolean) to authenticated, service_role;
grant execute on function public.prime_liquidacao_reavaliar_pendentes(text) to service_role;
revoke all on function public.prime_liquidacao_reavaliar_pendentes(text) from public, anon, authenticated;
grant execute on function public.prime_liquidacao_evidencias(uuid) to authenticated, service_role;
grant execute on function public.prime_liquidacao_acordo_pago_de_verdade(uuid) to authenticated, service_role;
grant execute on function public.prime_conferencia_seguir_pagamento(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.prime_liquidacao_painel() to authenticated, service_role;
grant execute on function public.prime_conferencia_fila() to authenticated, service_role;

-- ===== 8. O CORTE (item 14) ================================================
-- Tudo que ja esta liquidado agora e HISTORICO: a rotina nunca vai tocar.
insert into public.prime_liquidacao_classificacao
  (titulo_id, aluno_id, documento, evidencia_chave, data_liquidacao_prime, valor_bruto_prime, valor_pago_prime, portador,
   classificacao, nivel_evidencia, motivo, evidencia, origem_decisao, decidido_por, resultado_titulo)
select c.id, c.aluno_id, c.documento, public.prime_liquidacao_chave(c.documento, e.liquidado_em, e.portador),
       e.liquidado_em, e.valor_bruto, e.valor_pago, e.portador,
       'HISTORICO_FORA_DO_CORTE', 'HISTORICO',
       'liquidacao ja existente na ativacao da regra de entrada (18/09/2026); continua na Conferencia Prime historica',
       jsonb_build_object('situacao_no_corte', c.situacao, 'valor_crm', round(c.v,2)), 'CORTE', 'regra_entrada@corte', c.situacao
  from (select t.id, t.aluno_id, t.documento, t.vencimento, t.created_at::date imp, upper(coalesce(t.situacao,'')) situacao,
               coalesce(t.valor_cobranca_ajustado,t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0) v
          from public.acordos_titulos t
         where coalesce(t.tipo_boleto,'')<>'Acordo'
           and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO')
           and coalesce(lower(t.status),'')<>'quitada') c
  join lateral (select e.liquidado_em, e.portador, e.valor_bruto, e.valor_pago from public.prime_extrato e
                 where ltrim(e.boleto,'0') = ltrim(coalesce(c.documento,''),'0') and e.liquidado_em is not null
                 order by e.coletado_em desc limit 1) e on true
 where e.portador = 195 and e.liquidado_em > c.vencimento + 30 and e.liquidado_em >= c.imp and e.liquidado_em <> c.imp
on conflict do nothing;

insert into public.prime_liquidacao_regra (versao, titulos_fora_do_corte, alunos_fora_do_corte, valor_fora_do_corte, detalhe)
select '2026-09-18.1', count(*), count(distinct aluno_id), round(coalesce(sum((evidencia->>'valor_crm')::numeric),0),2),
       jsonb_build_object('pendentes_na_conferencia', (select count(*) from public.prime_conferencia_decisao where decisao='PENDENTE'),
                          'regra', 'PRIME_LIQUIDADO_NAO_E_PAGAMENTO; rotas A/B/C; historico intocado',
                          'por_situacao', (select coalesce(jsonb_object_agg(s, n), '{}'::jsonb)
                                             from (select resultado_titulo s, count(*) n from public.prime_liquidacao_classificacao
                                                    where origem_decisao='CORTE' group by 1) z))
  from public.prime_liquidacao_classificacao where origem_decisao = 'CORTE';

-- ===== 9. LIGAR A ROTINA ====================================================
do $liga$
begin
  if to_regclass('public.fluxo_pagamentos_config') is not null then
    insert into public.fluxo_pagamentos_config (etapa, ligado, observacao)
    values ('prime_liquidacao_classificar', true, 'regra de entrada: classifica liquidacao nova da Prime (rotas A/B/C); desligar pausa a rotina horaria')
    on conflict (etapa) do nothing;
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'prime_liquidacao_classificar_hora';
    perform cron.schedule('prime_liquidacao_classificar_hora', '50 * * * *', $job$
  do $inner$
  declare v_carga jsonb;
  begin
    v_carga := public.sistema_sob_carga();
    if coalesce((v_carga->>'sob_carga')::boolean, false) then return; end if;
    perform public.prime_liquidacao_classificar_novas(500, true);
  end
  $inner$;
  $job$);
  end if;
end
$liga$;

-- ===== 10. PROVA (aborta a aplicacao se a estrutura ou o "nada mudou" falhar)
do $prova$
declare a record; d record; r record;
begin
  select * into a from _rle_antes;
  select (select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='EM_CONFIRMACAO') as em_conf,
         (select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='PAGO') as pagos,
         (select count(*) from public.acordos_titulos where upper(coalesce(situacao,''))='NEGOCIADO') as negociados,
         (select count(*) from public.prime_conferencia_decisao where decisao='PENDENTE') as pendentes
    into d;
  if a.em_conf <> d.em_conf or a.pagos <> d.pagos or a.negociados <> d.negociados or a.pendentes <> d.pendentes then
    raise exception 'REGRA_DE_ENTRADA: a migration mexeu em titulo (antes % / depois %)', to_jsonb(a), to_jsonb(d);
  end if;
  select * into r from public.prime_liquidacao_regra order by ativado_em desc limit 1;
  if r.id is null then raise exception 'REGRA_DE_ENTRADA: corte nao registrado'; end if;
  if r.titulos_fora_do_corte <> (select count(*) from public.prime_liquidacao_classificacao where origem_decisao='CORTE') then
    raise exception 'REGRA_DE_ENTRADA: contagem do corte diverge';
  end if;
  perform 1 from pg_proc where proname in ('prime_liquidacao_classificar_novas','prime_liquidacao_reavaliar_pendentes',
    'prime_liquidacao_evidencias','prime_liquidacao_suspender','prime_conferencia_seguir_pagamento','prime_liquidacao_painel',
    'prime_liquidacao_chave','prime_liquidacao_acordo_pago_de_verdade') and pronamespace = 'public'::regnamespace
  having count(*) = 8;
  if not found then raise exception 'REGRA_DE_ENTRADA: funcao faltando'; end if;
  -- a trava do item 10 esta no texto da baixa
  if position('VALOR_PAGO_PRIME_NAO_E_CAIXA' in (select prosrc from pg_proc where proname='prime_conferencia_baixar' and pronamespace='public'::regnamespace)) = 0 then
    raise exception 'REGRA_DE_ENTRADA: trava do valor_pago ausente na baixa';
  end if;
  if position('PAGAMENTO_NAO_COBRE_O_TITULO' in (select prosrc from pg_proc where proname='conciliacao_liquidar_titulo_por_prime' and pronamespace='public'::regnamespace)) = 0 then
    raise exception 'REGRA_DE_ENTRADA: trava do item 2 ausente no liquidador';
  end if;
end
$prova$;

commit;
