-- Desfaz a situacao ACORDO_QUITADO: a fila volta a enxergar so acordo ATIVO,
-- e quem tem acordo quitado volta a cair em "Pagou, sem acordo" (ou fora da
-- fila, se nao tiver pagamento registrado). A assinatura e a mesma, entao
-- conferencia_contadores nao precisa de nada.
--
-- Copia fiel da funcao como ficou em 20260903200000.
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

  if v_sit not in ('TODAS', 'ACORDO_E_PAGOU', 'ACORDO_SEM_PAGAR', 'PAGOU_SEM_ACORDO') then
    raise exception 'Situação inválida: %. Use TODAS, ACORDO_E_PAGOU, ACORDO_SEM_PAGAR ou PAGOU_SEM_ACORDO.', p_situacao;
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
  acordo as (
    select a.aluno_id, count(*)::int as acordos,
           sum(coalesce(a.saldo, 0)) as saldo_acordo,
           max(a.numero_acordo) as numero,
           count(*) filter (where exists (
             select 1 from public.parcelas p where p.acordo_id = a.id and p.status = 'PAGO')
           )::int as acordos_com_parcela_paga
      from public.acordos a
     where upper(coalesce(a.status, '')) = 'ATIVO' and a.aluno_id is not null
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
           ac.acordos, ac.saldo_acordo, ac.numero, coalesce(ac.acordos_com_parcela_paga, 0) as com_parcela_paga,
           pg.pago, pg.ultimo,
           case when ac.aluno_id is not null and pg.aluno_id is not null then 'ACORDO_E_PAGOU'
                when ac.aluno_id is not null then 'ACORDO_SEM_PAGAR'
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
                   'numero_acordo', f.numero,
                   'saldo_acordo', round(coalesce(f.saldo_acordo, 0)::numeric, 2),
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
  'Mensalidades em aberto e sem vinculo no periodo, de alunos que ja tem acordo ativo ou ja pagaram. '
  'Situacoes: ACORDO_E_PAGOU, ACORDO_SEM_PAGAR, PAGOU_SEM_ACORDO. Quem nao tem sinal nenhum fica fora -- e cobranca normal. Gestao financeira apenas.';
