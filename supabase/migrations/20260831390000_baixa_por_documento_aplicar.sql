-- Baixa automatica pelo numero do documento, com portao explicito.
--
-- Amanda, 31/08: "consegue baixar o valor pago e honorario e o operador?" e
-- "posso processar?" -- vai extrair um retroativo do Relatorio de Titulos em
-- Aberto posicionado em 01/07/2026.
--
-- POR QUE ESTA FUNCAO PRECISA EXISTIR ANTES DO RETROATIVO. O relatorio de
-- titulos em aberto nao traz o que ja foi pago, entao um retroativo de 01/07
-- traz de volta acordos que foram quitados depois -- eles entram como divida
-- ABERTA e nao existem mais (ate R$ 3,82 mi). Sem esta baixa, essa divida falsa
-- fica de pe. Com ela, o extrato do Santander marca como pago exatamente o que
-- foi pago, e o que sobrar aberto e divida real.
--
-- A DATA IMPORTA: 01/07/2026, nao antes. `pagamentos` comeca em 01/07; junho
-- mora em `recuperacao_historica`, sem CPF nem documento -- ver
-- [[junho-mora-num-lugar-so]]. Retroativo mais antigo que isso nao tem com o
-- que cruzar.
--
-- PORTAO: sem p_confirmar a funcao SO CONTA, nao escreve. Baixa em massa e
-- irreversivel, entao nunca roda por acidente.
--
-- HONORARIO: o extrato e mais completo que o CRM -- 353 de 355 pagamentos
-- trazem honorario, contra 17 parcelas com honorario gravado aqui. So preenche
-- onde esta vazio, NUNCA sobrescreve.
--
-- Recalculo por ULTIMO, como manda [[vincular-e-abater-precisam-recalcular]].
-- Backup em `_backup_baixa_documento_<timestamp>` antes de escrever.
--
-- Testado em producao com rollback: A_VENCER -> PAGO, honorario nulo -> R$ 26,77
-- vindo do extrato, pago_em na data do pagamento, saldo do aluno 1.648,76 ->
-- 1.287,31.

create or replace function public.baixa_por_documento_aplicar(
  p_desde date default '2026-07-01'::date,
  p_confirmar boolean default false
)
returns jsonb
language plpgsql security definer
set search_path to 'public' set statement_timeout to '300s'
as $function$
declare
  v_baixadas int := 0; v_honorarios int := 0; v_alunos int := 0;
  v_valor numeric := 0; v_lote text;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode='42501';
  end if;

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

  execute format(
    'create table if not exists public.%I as
       select p.*, now() salvo_em from public.parcelas p
        where p.id in (select parcela_id from _alvo)', '_backup_' || v_lote);

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
    from _alvo t
   where pa.id = t.parcela_id;
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
$function$;

revoke all on function public.baixa_por_documento_aplicar(date, boolean) from public, anon;
grant execute on function public.baixa_por_documento_aplicar(date, boolean) to authenticated, service_role;
