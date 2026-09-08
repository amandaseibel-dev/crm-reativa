-- Baixa pelo documento: guarda pelo vencimento.
--
-- Amanda, 08/09/2026: "o sistema esta dando baixa em pagamentos certos e
-- outros em pagamentos errados" e, sobre a regra: "colocamos sempre a baixa
-- amarrada ao numero do titulo". A regra esta certa. O que estava errado era
-- a amarracao de QUAL parcela carrega QUAL documento.
--
-- O QUE ACONTECIA: `parcelas_amarrar_boleto` assumia que os 4 ultimos digitos
-- do documento sao o numero da parcela. Medido em 08/09 nas 10.924 parcelas
-- com boleto: sufixo = numero em 5.969; sufixo = numero + 1 em 3.884 (o doc
-- 0001 costuma ser a entrada); +2 a +9 em ~1.070. Com parcelas de valor
-- igual (2.050 acordos) o valor nao desempata, e a parcela recebia o boleto
-- de outra. Caso-prova: Kleiton Vieira, acordo 2245, 4 x R$ 310,58 -- o
-- pagamento de 05/08 (doc final 0003) baixou a parcela 3 (outubro) e o de
-- 08/09 (doc final 0004) baixou a parcela 4 (novembro); o extrato dizia
-- vencimento 03/09 (parcela 2). Desde julho: 89 parcelas / R$ 66 mil / 65
-- alunos baixadas numa parcela futura com uma anterior ainda aberta.
--
-- O QUE MUDA NESTA MIGRATION (so regra, nenhum dado e reescrito):
-- `documento_casa_com_parcela` e a guarda. Com vencimento no extrato, a
-- parcela do boleto tem de vencer naquele dia (+-3); sem vencimento, tem de
-- ser a parcela aberta mais antiga do acordo. O gatilho da importacao, a
-- rotina do relatorio e a baixa por documento passam por ela. O que ela
-- recusa fica registrado em `auditoria` (BAIXA_DOCUMENTO_RECUSADA) e segue
-- para a Conferencia de Pagamentos, como era antes da automacao.
--
-- O que fica para depois, com decisao da gestao: reamarrar os boletos pelo
-- vencimento e reparar as 89 baixas ja feitas na parcela errada.

create or replace function public.vencimento_do_pagamento(p_dados jsonb)
returns date
language sql
immutable
as $$
  select case when coalesce(p_dados->>'vencimento','') ~ '^\d{4}-\d{2}-\d{2}' then (p_dados->>'vencimento')::date end
$$;

create or replace function public.documento_casa_com_parcela(p_parcela_id uuid, p_vencimento date)
returns boolean
language sql
stable
set search_path to 'public'
as $$
  select case
    when p_vencimento is not null then abs(p.vencimento - p_vencimento) <= 3
    else not exists (
      select 1 from public.parcelas y
       where y.acordo_id = p.acordo_id and y.id <> p.id
         and upper(coalesce(y.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
         and y.vencimento < p.vencimento)
  end
  from public.parcelas p
  where p.id = p_parcela_id
$$;

comment on function public.documento_casa_com_parcela(uuid, date) is
  'Guarda da baixa automatica: com vencimento do extrato, a parcela tem de vencer naquele dia (+-3); sem, tem de ser a parcela aberta mais antiga do acordo.';

-- Gatilho da importacao passa pela guarda ---------------------------------

create or replace function public._pagamento_baixa_pelo_documento()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_chave text; v_parcela record; v_venc date;
begin
  v_chave := ltrim(coalesce(new.numero_parcela_completo,''),'0');
  if v_chave = '' then return new; end if;
  v_venc := public.vencimento_do_pagamento(new.dados);

  select p.id, p.valor, p.status, p.honorarios, p.acordo_id, p.vencimento, p.numero, a.aluno_id, a.status status_acordo
    into v_parcela
    from public.parcelas p join public.acordos a on a.id = p.acordo_id
   where p.boleto = v_chave limit 1;

  if not found then return new; end if;
  if v_parcela.status = 'PAGO' then return new; end if;
  if upper(coalesce(v_parcela.status_acordo,'')) <> 'ATIVO' then return new; end if;

  if new.valor_pago < v_parcela.valor - 0.05
     or new.valor_pago > v_parcela.valor * 1.15 then
    return new;
  end if;

  -- A GUARDA: o documento bate com a parcela certa? Com vencimento no
  -- extrato, e a parcela daquele vencimento; sem, e a aberta mais antiga.
  if not public.documento_casa_com_parcela(v_parcela.id, v_venc) then
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values ('rotina', 'BAIXA_DOCUMENTO_RECUSADA', 'parcelas', v_parcela.id,
            jsonb_build_object('pagamento_id', new.id, 'documento', v_chave,
                               'vencimento_extrato', v_venc, 'parcela_numero', v_parcela.numero,
                               'parcela_vencimento', v_parcela.vencimento, 'valor_pago', new.valor_pago,
                               'motivo', case when v_venc is not null then 'vencimento do extrato nao bate com a parcela do boleto'
                                              else 'ha parcela mais antiga em aberto no acordo' end));
    return new;
  end if;

  update public.parcelas
     set status = 'PAGO', pago_em = new.data_pagamento,
         confirmado_por_email = coalesce(new.operador_email,'extrato_santander'),
         honorarios = case when coalesce(honorarios,0) = 0 and coalesce(new.valor_honorario,0) > 0
                           then new.valor_honorario else honorarios end,
         observacao = coalesce(observacao,'')
           || case when coalesce(observacao,'') = '' then '' else ' | ' end
           || 'baixa automatica na importacao: documento ' || v_chave
           || ' pago em ' || to_char(new.data_pagamento,'DD/MM/YYYY')
           || case when v_venc is not null then ' (vencimento ' || to_char(v_venc,'DD/MM/YYYY') || ' conferido)' else '' end,
         atualizado_em = now()
   where id = v_parcela.id;

  perform public.recalcular_situacao_aluno(v_parcela.aluno_id);
  return new;
end;
$$;

-- Rotina do relatorio (cron e lote da importacao) passa pela guarda ---------

create or replace function public.baixa_pelo_relatorio_pagamento(p_confirmar boolean DEFAULT false, p_desde date DEFAULT '2026-07-01'::date)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '600s'
as $$
declare
  v_baixadas int := 0; v_alunos int := 0; v_registros int := 0;
  v_valor numeric := 0; v_lote text; v_menor int := 0; v_maior int := 0; v_recusadas int := 0;
begin
  if coalesce(current_setting('reativa.fluxo_pagamentos', true),'') <> 'on'
     and coalesce(auth.role(),'') <> 'service_role'
     and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode='42501';
  end if;

  create temp table _brp_casa on commit drop as
  select distinct on (pa.id)
         p.id pagamento_id, a.aluno_id, pa.boleto chave, p.data_pagamento, p.valor_pago,
         coalesce(p.valor_honorario,0) honorario,
         coalesce(p.operador_email, p.operador_nome, 'extrato_santander') quem,
         nullif(p.operador_nome,'') op_nome, nullif(p.operador_email,'') op_email,
         pa.id parcela_id, pa.acordo_id, pa.valor,
         public.vencimento_do_pagamento(p.dados) venc_extrato
    from public.pagamentos p
    join public.parcelas pa on pa.boleto = ltrim(coalesce(p.numero_parcela_completo,''),'0')
    join public.acordos a on a.id = pa.acordo_id
   where p.data_pagamento >= p_desde
     and pa.status not in ('PAGO','CANCELADA')
     and upper(coalesce(a.status,'')) <> 'CANCELADO'
     and p.valor_pago >= pa.valor - 0.05
     and p.valor_pago <= pa.valor * 1.15
     and public.documento_casa_com_parcela(pa.id, public.vencimento_do_pagamento(p.dados))
   order by pa.id, p.data_pagamento;

  select count(*) filter (where p.valor_pago < pa.valor - 0.05),
         count(*) filter (where p.valor_pago > pa.valor * 1.15),
         count(*) filter (where p.valor_pago >= pa.valor - 0.05 and p.valor_pago <= pa.valor * 1.15
                            and not public.documento_casa_com_parcela(pa.id, public.vencimento_do_pagamento(p.dados)))
    into v_menor, v_maior, v_recusadas
    from public.pagamentos p
    join public.parcelas pa on pa.boleto = ltrim(coalesce(p.numero_parcela_completo,''),'0')
   where p.data_pagamento >= p_desde and pa.status not in ('PAGO','CANCELADA');

  select count(*), count(distinct aluno_id), round(coalesce(sum(valor_pago),0),2)
    into v_baixadas, v_alunos, v_valor from _brp_casa;

  if not coalesce(p_confirmar, false) then
    return jsonb_build_object('modo','previa','baixaria', v_baixadas,
      'alunos', v_alunos, 'valor', v_valor,
      'recusados_pagou_menos', v_menor, 'recusados_pagou_muito_mais', v_maior,
      'recusados_parcela_nao_bate', v_recusadas);
  end if;

  v_lote := 'baixa_relatorio_' || to_char(clock_timestamp(),'YYYYMMDDHH24MISS');
  execute format('create table if not exists public.%I as
       select p.*, now() salvo_em from public.parcelas p
        where p.id in (select parcela_id from _brp_casa)', '_backup_' || v_lote);
  execute format('alter table public.%I enable row level security', '_backup_' || v_lote);

  -- O REGISTRO DE BAIXA VEM ANTES da parcela: pagar a ultima parcela fecha o
  -- acordo na hora (trg_acordo_fecha_com_a_ultima_parcela), e acordo fechado
  -- recusa registro de baixa. Registrar primeiro evita a colisao entre as duas
  -- regras -- foi o que travou a baixa do Jean Batista Silva em 01/09.
  insert into public.baixas_pagamento
    (aluno_id, aluno_nome, aluno_cpf, valor_pago, honorarios_recebidos, status_baixa,
     operador_origem_nome, operador_origem_email, responsavel_baixa_nome, responsavel_baixa_email,
     baixado_por_nome, baixado_por_email, baixado_em, data_pagamento, parcela_id, acordo_id,
     observacao_operador)
  select al.id::text, al.nome, al.cpf, c.valor_pago, c.honorario, 'REALIZADA',
         coalesce(c.op_nome, al.responsavel_atual_nome), coalesce(c.op_email, al.responsavel_atual_email),
         coalesce(c.op_nome, al.responsavel_atual_nome), coalesce(c.op_email, al.responsavel_atual_email),
         'Rotina de baixa pelo documento', 'rotina@sistema', now(),
         c.data_pagamento, c.parcela_id, c.acordo_id, 'Baixa pelo documento ' || c.chave
    from _brp_casa c join public.alunos al on al.id = c.aluno_id
   where not exists (select 1 from public.baixas_pagamento b
                      where b.parcela_id = c.parcela_id and b.devolvido_em is null);
  get diagnostics v_registros = row_count;

  update public.parcelas pa
     set status = 'PAGO', pago_em = c.data_pagamento, confirmado_por_email = c.quem,
         honorarios = case when coalesce(pa.honorarios,0) = 0 and c.honorario > 0
                           then c.honorario else pa.honorarios end,
         observacao = coalesce(pa.observacao,'')
           || case when coalesce(pa.observacao,'')='' then '' else ' | ' end
           || 'baixa pelo documento ' || c.chave
           || ' pago em ' || to_char(c.data_pagamento,'DD/MM/YYYY')
           || case when c.venc_extrato is not null then ' (vencimento ' || to_char(c.venc_extrato,'DD/MM/YYYY') || ' conferido)' else '' end,
         atualizado_em = now()
    from _brp_casa c where pa.id = c.parcela_id and pa.status <> 'PAGO';
  get diagnostics v_baixadas = row_count;

  perform public.recalcular_situacao_aluno(x.aluno_id)
     from (select distinct aluno_id from _brp_casa) x;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (coalesce(nullif(auth.email(),''),'rotina'), 'BAIXA_PELO_DOCUMENTO', 'parcelas', null,
          jsonb_build_object('lote', v_lote, 'baixadas', v_baixadas, 'registros', v_registros,
                             'alunos', v_alunos, 'valor', v_valor, 'backup', '_backup_' || v_lote,
                             'recusados_parcela_nao_bate', v_recusadas));

  return jsonb_build_object('modo','aplicado','lote', v_lote,
    'parcelas_baixadas', v_baixadas, 'registros_de_baixa', v_registros,
    'alunos', v_alunos, 'valor', v_valor, 'backup', '_backup_' || v_lote,
    'recusados_pagou_menos', v_menor, 'recusados_pagou_muito_mais', v_maior,
    'recusados_parcela_nao_bate', v_recusadas);
end;
$$;

-- Baixa por documento (etapa desligada hoje, mas ganha a guarda) -----------

create or replace function public.baixa_por_documento_aplicar(p_desde date DEFAULT '2026-07-01'::date, p_confirmar boolean DEFAULT false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '300s'
as $$
declare
  v_baixadas int := 0; v_honorarios int := 0; v_alunos int := 0;
  v_valor numeric := 0; v_lote text;
begin
  if coalesce(current_setting('reativa.fluxo_pagamentos', true),'') <> 'on'
     and coalesce(auth.role(),'') <> 'service_role'
     and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode='42501';
  end if;

  if not coalesce(p_confirmar, false) then
    select count(*), round(coalesce(sum(p.valor_pago),0),2), count(distinct a.aluno_id)
      into v_baixadas, v_valor, v_alunos
      from public.pagamentos p
      join public.parcelas pa on pa.boleto = ltrim(coalesce(p.numero_parcela_completo,''),'0')
      join public.acordos a on a.id = pa.acordo_id
     where p.data_pagamento >= p_desde and coalesce(p.numero_parcela_completo,'')<>''
       and pa.status in ('A_VENCER','VENCIDA') and abs(pa.valor - p.valor_pago) <= 0.05
       and public.documento_casa_com_parcela(pa.id, public.vencimento_do_pagamento(p.dados));
    return jsonb_build_object('modo','previa','baixaria', v_baixadas,
                              'valor', v_valor, 'alunos', v_alunos);
  end if;

  v_lote := 'baixa_documento_' || to_char(clock_timestamp(),'YYYYMMDDHH24MISS');

  create temp table _alvo on commit drop as
  select distinct on (pa.id)
         pa.id parcela_id, pa.acordo_id, a.aluno_id, pa.valor, pa.honorarios honorario_antes,
         p.id pagamento_id, p.data_pagamento, p.valor_pago,
         coalesce(p.valor_honorario,0) honorario_extrato,
         coalesce(p.operador_email, p.operador_nome, 'extrato_santander') quem
    from public.pagamentos p
    join public.parcelas pa on pa.boleto = ltrim(coalesce(p.numero_parcela_completo,''),'0')
    join public.acordos a on a.id = pa.acordo_id
   where p.data_pagamento >= p_desde and coalesce(p.numero_parcela_completo,'')<>''
     and pa.status in ('A_VENCER','VENCIDA') and abs(pa.valor - p.valor_pago) <= 0.05
     and public.documento_casa_com_parcela(pa.id, public.vencimento_do_pagamento(p.dados))
   order by pa.id, p.data_pagamento;

  execute format(
    'create table if not exists public.%I as
       select p.*, now() salvo_em from public.parcelas p
        where p.id in (select parcela_id from _alvo)', '_backup_' || v_lote);
  execute format('alter table public.%I enable row level security', '_backup_' || v_lote);

  update public.parcelas pa
     set status = 'PAGO',
         pago_em = t.data_pagamento,
         confirmado_por_email = t.quem,
         honorarios = case when coalesce(pa.honorarios,0) = 0 and t.honorario_extrato > 0
                           then t.honorario_extrato else pa.honorarios end,
         observacao = coalesce(pa.observacao,'')
                      || case when coalesce(pa.observacao,'')='' then '' else ' | ' end
                      || 'baixa automatica pelo documento ' || pa.boleto
                      || ' (extrato de ' || to_char(t.data_pagamento,'DD/MM/YYYY') || ')',
         atualizado_em = now()
    from _alvo t where pa.id = t.parcela_id;
  get diagnostics v_baixadas = row_count;

  select count(*) into v_honorarios from _alvo
   where coalesce(honorario_antes,0) = 0 and honorario_extrato > 0;
  select round(coalesce(sum(valor_pago),0),2), count(distinct aluno_id)
    into v_valor, v_alunos from _alvo;

  perform public.recalcular_situacao_aluno(x.aluno_id)
     from (select distinct aluno_id from _alvo) x;

  return jsonb_build_object('modo','aplicado','lote', v_lote,
    'parcelas_baixadas', v_baixadas, 'honorarios_preenchidos', v_honorarios,
    'valor', v_valor, 'alunos', v_alunos, 'backup', '_backup_' || v_lote);
end;
$$;
