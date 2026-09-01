-- Amanda, 01/09: "nao ficamos de criar a rotina atraves do relatorio de
-- pagamento" -- e "esse e o principal vinculo".
--
-- O relatorio de pagamento traz o NUMERO DO DOCUMENTO de cada boleto pago. A
-- parcela do acordo, do outro lado, nasce SEM numero: a importacao grava o
-- numero como titulo (tipo_boleto='Acordo') e nem sempre esse titulo entra.
-- Sem numero dos dois lados, a baixa nao casa -- foi o que aconteceu em 01/09
-- com 25 dos 36 pagamentos do lote, entre eles o acordo inteiro do Jose Luiz
-- de Assis Neto (10 x R$ 300,71) e do Ananias Carvalho da Silva Tavares
-- (R$ 776,05 + R$ 760,57 + R$ 760,58), ambos pagos por completo.
--
-- Esta rotina inverte a direcao: em vez de esperar a parcela ter numero, ela
-- LE o numero no pagamento e o grava na parcela -- e so entao baixa.
--
-- FORMATO DA CHAVE (medido): `numero_parcela_completo` = 11 digitos =
--   "50" + titulo(5) + parcela(4).  Ex.: 50709150001 = acordo 70915, parcela 1.
--
-- POR QUE NAO SE DERIVA O NUMERO SEM O PAGAMENTO: tentado em 01/09 a partir de
-- `fila_acordos_confirmar.acordo_base`, acerta 83% e erra de forma sistematica
-- -- o Relatorio de Titulos em Aberto so traz as parcelas AINDA ABERTAS, entao
-- a primeira que aparece pode ser a terceira ou a setima do acordo. Derivar por
-- posicao inventaria numero errado, e numero errado da baixa no boleto de
-- outra pessoa. O pagamento e a unica fonte que diz o numero com certeza.
--
-- TRAVAS:
--   * so amarra em parcela SEM numero (nunca sobrescreve);
--   * o numero da parcela vem do proprio documento, e tem de existir no acordo;
--   * o valor tem de bater, ou a diferenca caber em juros e multa (ate 15%);
--   * o acordo tem de estar ATIVO -- cancelado exige decisao humana;
--   * ambiguidade NUNCA e resolvida no chute: se um pagamento casa com mais de
--     uma parcela, ou uma parcela com mais de um pagamento, os dois saem;
--   * um numero de boleto so pode apontar para UMA parcela (indice unico);
--   * sem p_confirmar ela SO CONTA.
--
-- Primeira aplicacao, 01/09: 131 parcelas, 90 alunos, R$ 109.252,85.

create or replace function public.baixa_pelo_relatorio_pagamento(
  p_confirmar boolean default false, p_desde date default '2026-07-01'::date)
returns jsonb language plpgsql security definer
set search_path to 'public' set statement_timeout to '600s'
as $function$
declare
  v_amarradas int := 0; v_baixadas int := 0; v_alunos int := 0;
  v_valor numeric := 0; v_lote text; v_ambiguos int := 0;
begin
  if coalesce(current_setting('reativa.fluxo_pagamentos', true),'') <> 'on'
     and coalesce(auth.role(),'') <> 'service_role'
     and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode='42501';
  end if;

  create temp table _brp_pag on commit drop as
  select p.id pagamento_id, p.aluno_id, p.data_pagamento, p.valor_pago,
         coalesce(p.valor_honorario,0) honorario,
         coalesce(p.operador_email, p.operador_nome, 'extrato_santander') quem,
         ltrim(coalesce(p.numero_parcela_completo,''),'0') chave,
         substr(ltrim(coalesce(p.numero_parcela_completo,''),'0'), 3, 5) titulo_nr,
         substr(ltrim(coalesce(p.numero_parcela_completo,''),'0'), 8, 4)::int parcela_nr
    from public.pagamentos p
   where p.data_pagamento >= p_desde
     and p.aluno_id is not null
     and ltrim(coalesce(p.numero_parcela_completo,''),'0') ~ '^50\d{9}$'
     and not exists (select 1 from public.parcelas pa
                      where pa.boleto = ltrim(coalesce(p.numero_parcela_completo,''),'0'));

  create temp table _brp_casa on commit drop as
  select g.pagamento_id, g.aluno_id, g.chave, g.data_pagamento, g.valor_pago,
         g.honorario, g.quem, pa.id parcela_id, pa.acordo_id, pa.valor
    from _brp_pag g
    join public.acordos a on a.aluno_id = g.aluno_id and upper(coalesce(a.status,''))='ATIVO'
    join public.parcelas pa on pa.acordo_id = a.id and pa.numero = g.parcela_nr
   where pa.boleto is null
     and pa.status <> 'PAGO'
     and g.valor_pago >= pa.valor - 0.05
     and g.valor_pago <= pa.valor * 1.15;

  delete from _brp_casa c
   where (select count(*) from _brp_casa c2 where c2.pagamento_id = c.pagamento_id) > 1
      or (select count(*) from _brp_casa c3 where c3.parcela_id = c.parcela_id) > 1;
  get diagnostics v_ambiguos = row_count;

  select count(*), count(distinct aluno_id), round(coalesce(sum(valor_pago),0),2)
    into v_amarradas, v_alunos, v_valor from _brp_casa;

  if not coalesce(p_confirmar, false) then
    return jsonb_build_object('modo','previa',
      'pagamentos_sem_parcela', (select count(*) from _brp_pag),
      'amarraria_e_baixaria', v_amarradas, 'alunos', v_alunos, 'valor', v_valor,
      'descartados_por_ambiguidade', v_ambiguos);
  end if;

  v_lote := 'baixa_relatorio_' || to_char(clock_timestamp(),'YYYYMMDDHH24MISS');
  execute format(
    'create table if not exists public.%I as
       select p.*, now() salvo_em from public.parcelas p
        where p.id in (select parcela_id from _brp_casa)', '_backup_' || v_lote);
  execute format('alter table public.%I enable row level security', '_backup_' || v_lote);

  update public.parcelas pa set boleto = c.chave, atualizado_em = now()
    from _brp_casa c where pa.id = c.parcela_id and pa.boleto is null;
  get diagnostics v_amarradas = row_count;

  update public.parcelas pa
     set status = 'PAGO', pago_em = c.data_pagamento,
         confirmado_por_email = c.quem,
         honorarios = case when coalesce(pa.honorarios,0) = 0 and c.honorario > 0
                           then c.honorario else pa.honorarios end,
         observacao = coalesce(pa.observacao,'')
           || case when coalesce(pa.observacao,'')='' then '' else ' | ' end
           || 'baixa pelo relatorio de pagamento: documento ' || c.chave
           || ' pago em ' || to_char(c.data_pagamento,'DD/MM/YYYY'),
         atualizado_em = now()
    from _brp_casa c where pa.id = c.parcela_id and pa.status <> 'PAGO';
  get diagnostics v_baixadas = row_count;

  perform public.recalcular_situacao_aluno(x.aluno_id)
     from (select distinct aluno_id from _brp_casa) x;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (coalesce(nullif(auth.email(),''),'rotina'), 'BAIXA_PELO_RELATORIO_PAGAMENTO',
          'parcelas', null,
          jsonb_build_object('lote', v_lote, 'amarradas', v_amarradas,
                             'baixadas', v_baixadas, 'alunos', v_alunos, 'valor', v_valor,
                             'backup', '_backup_' || v_lote));

  return jsonb_build_object('modo','aplicado','lote', v_lote,
    'boletos_gravados', v_amarradas, 'parcelas_baixadas', v_baixadas,
    'alunos', v_alunos, 'valor', v_valor, 'backup', '_backup_' || v_lote,
    'descartados_por_ambiguidade', v_ambiguos);
end;
$function$;

revoke all on function public.baixa_pelo_relatorio_pagamento(boolean, date) from public, anon;
grant execute on function public.baixa_pelo_relatorio_pagamento(boolean, date) to authenticated, service_role;
