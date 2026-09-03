-- A fila "Mensalidades a vincular" passa a enxergar o acordo QUITADO.
--
-- Amanda, 03/09/2026: "preciso que voce confirme se tudo que entrou de
-- pagamentos em julho e agosto nao consta mensalidades que poderiam ser
-- vinculado a algum acordo" -- e, sobre o achado: "nao precisa baixar nada,
-- coloca na fila".
--
-- MEDIDO EM 03/09/2026. Quem pagou em julho ou agosto e ainda tem mensalidade
-- em aberto sem vinculo: 332 alunos, 703 titulos, R$ 574.878.
--   * 131 tem acordo ATIVO       R$ 277.800  -> ja apareciam ("Tem acordo e ja pagou")
--   * 143 tem acordo so QUITADO  R$ 223.766  -> apareciam como "Pagou, SEM acordo"
--   *  57 nunca tiveram acordo   R$  72.997  -> "Pagou, sem acordo", correto
--   *   1 so acordo CANCELADO    R$     315  -> cobranca normal
--
-- O FURO: a fila so olhava acordo ATIVO. Quem pagou o acordo inteiro (quase
-- todos quitados em 01/09, pela baixa das parcelas) ficava rotulado "Pagou,
-- sem acordo" com a coluna Acordo vazia -- a gestao nao tinha como saber que
-- existia um acordo para vincular. Nos 143, TODA mensalidade solta venceu antes
-- do acordo: e a divida que ele substituiu, contando em dobro.
--
-- Vincular a acordo quitado ja e permitido (vincular_titulos_acordo aceita
-- ATIVO e QUITADO desde 20260902140000) e deixa a mensalidade quitada sem
-- zerar valor; a ficha do aluno oferece o acordo pago na lista. Falta so a
-- fila apontar. Sem recorte de mes o balde novo tem 152 alunos / 282 titulos /
-- R$ 258.658 (7 sem pagamento registrado -- o acordo quitado ja e o sinal).
--
-- Acordo CANCELADO continua fora: a divida voltou para cobranca e o vinculo e
-- bloqueado. Quem tem ATIVO e QUITADO ao mesmo tempo segue pelo ATIVO -- e
-- nele que a mensalidade entra como negociada.
--
-- Situacao nova: ACORDO_QUITADO. Itens ganham acordo_status, valor_acordo e
-- quitado_em (ultima parcela paga). A assinatura nao muda; conferencia_contadores
-- passa a contar o balde novo sem precisar de alteracao.
-- DESFAZER: supabase/rollbacks/20260903230000_confirmacao_a_vincular_acordo_quitado.rollback.sql
create or replace function public.confirmacao_a_vincular(
  p_de date default null,
  p_ate date default null,
  p_situacao text default 'TODAS',
  p_limite int default 200,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
set statement_timeout to '120s'
as $function$
declare
  v_sit text := upper(coalesce(nullif(p_situacao, ''), 'TODAS'));
  v_limite int := least(greatest(coalesce(p_limite, 200), 1), 500);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_total int;
  v_itens jsonb;
  v_resumo jsonb;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;

  if v_sit not in ('TODAS', 'ACORDO_E_PAGOU', 'ACORDO_SEM_PAGAR', 'ACORDO_QUITADO', 'PAGOU_SEM_ACORDO') then
    raise exception 'Situação inválida: %. Use TODAS, ACORDO_E_PAGOU, ACORDO_SEM_PAGAR, ACORDO_QUITADO ou PAGOU_SEM_ACORDO.', p_situacao;
  end if;

  with titulos as (
    select t.aluno_id,
           count(*)::int as titulos,
           sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)) as valor,
           min(t.vencimento) as venc_min,
           max(t.vencimento) as venc_max
      from public.acordos_titulos t
     where (p_de is null or t.vencimento >= p_de)
       and (p_ate is null or t.vencimento <= p_ate)
       and upper(coalesce(t.situacao, '')) = 'ABERTO'
       and lower(coalesce(t.status, '')) = 'em_aberto'
       and coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
       -- sem vínculo por nenhum dos dois caminhos: a coluna e a tabela de apoio
       and t.acordo_id is null
       and not exists (select 1 from public.acordo_titulo_vinculo v where v.titulo_id = t.id)
       and t.aluno_id is not null
     group by t.aluno_id
  ),
  -- ATIVO e QUITADO contam; CANCELADO fica fora. Os dois lados ficam separados
  -- para o ATIVO mandar quando o aluno tem ambos.
  acordo as (
    select a.aluno_id,
           count(*) filter (where upper(coalesce(a.status, '')) = 'ATIVO')::int as ativos,
           count(*) filter (where upper(coalesce(a.status, '')) = 'QUITADO')::int as quitados,
           sum(coalesce(a.saldo, 0)) filter (where upper(coalesce(a.status, '')) = 'ATIVO') as saldo_ativo,
           sum(coalesce(a.valor_total, 0)) filter (where upper(coalesce(a.status, '')) = 'ATIVO') as valor_ativo,
           sum(coalesce(a.valor_total, 0)) filter (where upper(coalesce(a.status, '')) = 'QUITADO') as valor_quitado,
           max(a.numero_acordo) filter (where upper(coalesce(a.status, '')) = 'ATIVO') as numero_ativo,
           max(a.numero_acordo) filter (where upper(coalesce(a.status, '')) = 'QUITADO') as numero_quitado,
           -- "quitado em" = a ultima parcela paga, nao o atualizado_em do acordo
           max((select max(p.pago_em) from public.parcelas p where p.acordo_id = a.id))
             filter (where upper(coalesce(a.status, '')) = 'QUITADO') as quitado_em,
           count(*) filter (where upper(coalesce(a.status, '')) = 'ATIVO' and exists (
             select 1 from public.parcelas p where p.acordo_id = a.id and p.status = 'PAGO')
           )::int as acordos_com_parcela_paga
      from public.acordos a
     where upper(coalesce(a.status, '')) in ('ATIVO', 'QUITADO') and a.aluno_id is not null
     group by a.aluno_id
  ),
  pago as (
    select pg.aluno_id, sum(pg.valor_pago) as pago, max(pg.data_pagamento) as ultimo
      from public.pagamentos pg where pg.aluno_id is not null group by pg.aluno_id
  ),
  base as (
    select t.aluno_id, t.titulos, t.valor, t.venc_min, t.venc_max,
           al.nome, al.cpf_mascarado, al.telefone,
           coalesce(al.responsavel_atual_nome, '(sem dono)') as responsavel,
           al.responsavel_atual_email,
           case when ac.ativos > 0 then 'ATIVO' when ac.quitados > 0 then 'QUITADO' end as acordo_status,
           case when ac.ativos > 0 then ac.ativos else ac.quitados end as acordos,
           case when ac.ativos > 0 then ac.saldo_ativo else 0 end as saldo_acordo,
           case when ac.ativos > 0 then ac.valor_ativo else ac.valor_quitado end as valor_acordo,
           case when ac.ativos > 0 then ac.numero_ativo else ac.numero_quitado end as numero,
           case when ac.ativos > 0 then null else ac.quitado_em::date end as quitado_em,
           coalesce(ac.acordos_com_parcela_paga, 0) as com_parcela_paga,
           pg.pago, pg.ultimo,
           case when ac.ativos > 0 and pg.aluno_id is not null then 'ACORDO_E_PAGOU'
                when ac.ativos > 0 then 'ACORDO_SEM_PAGAR'
                when ac.quitados > 0 then 'ACORDO_QUITADO'
                when pg.aluno_id is not null then 'PAGOU_SEM_ACORDO'
                else 'SEM_SINAL' end as situacao
      from titulos t
      join public.alunos al on al.id = t.aluno_id
      left join acordo ac on ac.aluno_id = t.aluno_id
      left join pago pg on pg.aluno_id = t.aluno_id
  ),
  -- "Sem sinal" é cobrança normal, não tratativa: fica fora da fila.
  fila as (
    select * from base
     where situacao <> 'SEM_SINAL'
       and (v_sit = 'TODAS' or situacao = v_sit)
  )
  select
    (select count(*)::int from fila),
    coalesce((
      select jsonb_agg(item order by ordem_valor desc, ordem_id)
        from (
          select jsonb_build_object(
                   'aluno_id', f.aluno_id,
                   'nome', f.nome,
                   'cpf', f.cpf_mascarado,
                   'telefone', f.telefone,
                   'responsavel', f.responsavel,
                   'responsavel_email', f.responsavel_atual_email,
                   'situacao', f.situacao,
                   'titulos', f.titulos,
                   'valor_mensalidade', round(f.valor::numeric, 2),
                   'venc_min', f.venc_min,
                   'venc_max', f.venc_max,
                   'acordos', coalesce(f.acordos, 0),
                   'acordo_status', f.acordo_status,
                   'numero_acordo', f.numero,
                   'saldo_acordo', round(coalesce(f.saldo_acordo, 0)::numeric, 2),
                   'valor_acordo', round(coalesce(f.valor_acordo, 0)::numeric, 2),
                   'quitado_em', f.quitado_em,
                   'acordos_com_parcela_paga', f.com_parcela_paga,
                   'valor_pago', round(coalesce(f.pago, 0)::numeric, 2),
                   'ultimo_pagamento', f.ultimo
                 ) as item,
                 f.valor as ordem_valor,
                 f.aluno_id as ordem_id,
                 row_number() over (order by f.valor desc, f.aluno_id) as rn
            from fila f
        ) p
       where rn > v_offset and rn <= v_offset + v_limite
    ), '[]'::jsonb),
    coalesce((
      select jsonb_object_agg(situacao, jsonb_build_object(
               'alunos', qtd, 'titulos', titulos, 'valor', round(valor::numeric, 2)))
        from (select situacao, count(*)::int qtd, sum(titulos)::int titulos, sum(valor) valor
                from base where situacao <> 'SEM_SINAL' group by situacao) r
    ), '{}'::jsonb)
  into v_total, v_itens, v_resumo;

  return jsonb_build_object(
    'de', p_de, 'ate', p_ate,
    'total', coalesce(v_total, 0),
    'limite', v_limite, 'offset', v_offset,
    'resumo', v_resumo,
    'itens', v_itens
  );
end;
$function$;

revoke all on function public.confirmacao_a_vincular(date, date, text, int, int) from public;
grant execute on function public.confirmacao_a_vincular(date, date, text, int, int) to authenticated;

comment on function public.confirmacao_a_vincular(date, date, text, int, int) is
  'Mensalidades em aberto e sem vinculo no periodo, de alunos que ja tem acordo (ativo ou quitado) ou ja pagaram. '
  'Situacoes: ACORDO_E_PAGOU, ACORDO_SEM_PAGAR, ACORDO_QUITADO, PAGOU_SEM_ACORDO. '
  'Quem nao tem sinal nenhum fica fora -- e cobranca normal. Acordo cancelado nao conta. Gestao financeira apenas.';
