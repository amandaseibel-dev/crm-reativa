-- Amanda, 31/08: "se isso der certo, otimizamos muito o tempo e podemos criar
-- as baixas automaticas a partir do relatorio de pagamento que importamos na
-- projecao, la tem o numero do documento" e "consegue baixar o valor pago e
-- honorario e o operador?".
--
-- Duas portas para a mesma regra:
--   1. `baixa_por_documento_aplicar` -- passada em lote, com portao explicito:
--      sem p_confirmar ela SO CONTA, nao escreve.
--   2. `_pagamento_baixa_pelo_documento` -- gatilho: o pagamento entra pela
--      importacao da Projecao e ja procura a sua parcela, sem esperar cron.
--
-- LIMITES DELIBERADOS (a cobranca trabalha com exatos):
--   * so casa pelo NUMERO DO DOCUMENTO, nunca por valor ou data;
--   * o lote exige valor identico (tolerancia de R$ 0,05); o gatilho aceita
--     ate 15% acima, que e a faixa de juros e multa;
--   * acordo CANCELADO nunca recebe baixa automatica -- exige decisao humana
--     (os 28 casos de 01/09, em que o acordo foi cancelado DEPOIS do pagamento);
--   * o honorario do extrato so PREENCHE onde esta vazio, nunca sobrescreve.
--
-- Ver [[boleto-da-parcela-e-a-chave-do-pagamento]] e [[cobranca-trabalha-com-exatos]].

create or replace function public.baixa_por_documento_aplicar(
  p_desde date default '2026-07-01'::date, p_confirmar boolean default false)
returns jsonb language plpgsql security definer
set search_path to 'public' set statement_timeout to '300s'
as $function$
declare
  v_baixadas int := 0; v_honorarios int := 0; v_alunos int := 0;
  v_valor numeric := 0; v_lote text;
begin
  if coalesce(current_setting('reativa.fluxo_pagamentos', true),'') <> 'on'
     and coalesce(auth.role(),'') <> 'service_role'
     and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode='42501';
  end if;

  -- Portao explicito: sem p_confirmar => so conta, nao escreve.
  if not coalesce(p_confirmar, false) then
    select count(*), round(coalesce(sum(p.valor_pago),0),2), count(distinct a.aluno_id)
      into v_baixadas, v_valor, v_alunos
      from public.pagamentos p
      join public.parcelas pa on pa.boleto = ltrim(coalesce(p.numero_parcela_completo,''),'0')
      join public.acordos a on a.id = pa.acordo_id
     where p.data_pagamento >= p_desde and coalesce(p.numero_parcela_completo,'')<>''
       and pa.status in ('A_VENCER','VENCIDA') and abs(pa.valor - p.valor_pago) <= 0.05;
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
   order by pa.id, p.data_pagamento;

  -- backup antes de escrever
  execute format(
    'create table if not exists public.%I as
       select p.*, now() salvo_em from public.parcelas p
        where p.id in (select parcela_id from _alvo)', '_backup_' || v_lote);
  execute format('alter table public.%I enable row level security', '_backup_' || v_lote);

  update public.parcelas pa
     set status = 'PAGO',
         pago_em = t.data_pagamento,
         confirmado_por_email = t.quem,
         -- o extrato e MAIS completo que o CRM no honorario: 353 de 355 contra
         -- 17 gravados aqui. So preenche onde falta, nunca sobrescreve.
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

  -- recalculo por ULTIMO, com tudo ja escrito
  perform public.recalcular_situacao_aluno(x.aluno_id)
     from (select distinct aluno_id from _alvo) x;

  return jsonb_build_object('modo','aplicado','lote', v_lote,
    'parcelas_baixadas', v_baixadas, 'honorarios_preenchidos', v_honorarios,
    'valor', v_valor, 'alunos', v_alunos, 'backup', '_backup_' || v_lote);
end;
$function$;

revoke all on function public.baixa_por_documento_aplicar(date, boolean) from public, anon;
grant execute on function public.baixa_por_documento_aplicar(date, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- A mesma regra na entrada do pagamento.
-- ---------------------------------------------------------------------------

create or replace function public._pagamento_baixa_pelo_documento()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_chave text; v_parcela record;
begin
  v_chave := ltrim(coalesce(new.numero_parcela_completo,''),'0');
  if v_chave = '' then return new; end if;

  select p.id, p.valor, p.status, p.honorarios, p.acordo_id, a.aluno_id, a.status status_acordo
    into v_parcela
    from public.parcelas p join public.acordos a on a.id = p.acordo_id
   where p.boleto = v_chave limit 1;

  if not found then return new; end if;
  if v_parcela.status = 'PAGO' then return new; end if;

  -- acordo cancelado nao recebe baixa automatica: exige decisao humana.
  if upper(coalesce(v_parcela.status_acordo,'')) <> 'ATIVO' then return new; end if;

  -- so baixa se o valor bate, ou se a diferenca cabe em juros e multa (ate 15%).
  -- Acima disso o pagamento pode ser de varias parcelas ou de outra coisa.
  if new.valor_pago < v_parcela.valor - 0.05
     or new.valor_pago > v_parcela.valor * 1.15 then
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
           || ' pago em ' || to_char(new.data_pagamento,'DD/MM/YYYY'),
         atualizado_em = now()
   where id = v_parcela.id;

  perform public.recalcular_situacao_aluno(v_parcela.aluno_id);
  return new;
end;
$function$;

drop trigger if exists trg_pagamento_baixa_documento on public.pagamentos;
create trigger trg_pagamento_baixa_documento
  after insert on public.pagamentos
  for each row execute function public._pagamento_baixa_pelo_documento();
